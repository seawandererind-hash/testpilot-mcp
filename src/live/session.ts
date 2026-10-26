import { type ChildProcess, spawn } from 'node:child_process';

import type { ExploredElement } from '../explore/web.js';
import type { ProjectStore } from '../core/store.js';
import type { AiDrive } from './ai-case.js';
import { LIVE_DRIVER_SCRIPT } from './driver-script.js';
import { type DriverReply, encodeCommand, LineBuffer, type LiveCommand, parseDriverLine } from './protocol.js';
import type { LivePageCapture, RecordedStep } from './recording.js';

/** Closes a session nobody has used for this long. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

type CommandBody = LiveCommand extends infer C ? (C extends LiveCommand ? Omit<C, 'id'> : never) : never;

/** The server's handle on one browser process. */
export interface DriverHandle {
    send(command: CommandBody, timeoutMs?: number): Promise<DriverReply>;
    close(): Promise<void>;
    /** Kills the process at once (used on server exit). */
    kill(): void;
    readonly alive: boolean;
}

export interface LaunchOptions {
    url: string;
    headed: boolean;
    slowMo: number;
    storageState?: string;
    ignoreHttpsErrors: boolean;
    /** Absolute folder for screenshots. */
    outDir: string;
    /** Folder the process runs in (the test root). */
    cwd: string;
    /** Folders to look for Playwright in, first match wins. */
    resolveFrom: string[];
}

export type DriverFactory = (store: ProjectStore, options: LaunchOptions) => Promise<{ handle: DriverHandle; ready: DriverReply }>;

/** Starts the real browser process with the project's Playwright. */
export const spawnDriver: DriverFactory = async (store, options) => {
    const scriptRel = '.testpilot/tmp/live-driver.mjs';
    store.write(scriptRel, LIVE_DRIVER_SCRIPT);
    const env = {
        ...process.env,
        TESTPILOT_LIVE: JSON.stringify({ url: options.url, headed: options.headed, slowMo: options.slowMo, storageState: options.storageState, ignoreHttpsErrors: options.ignoreHttpsErrors, outDir: options.outDir, resolveFrom: options.resolveFrom })
    };
    const child = spawn(process.execPath, [store.resolve(scriptRel)], { cwd: options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const handle = new ChildDriver(child);
    try {
        const ready = await handle.waitFor(0, 90_000);
        return { handle, ready };
    } catch (error) {
        handle.kill();
        throw error;
    }
};

class ChildDriver implements DriverHandle {
    private nextId = 1;
    private readonly waiting = new Map<number, { resolve: (r: DriverReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private readonly early = new Map<number, DriverReply>();
    private stderr = '';
    private exited = false;

    constructor(private readonly child: ChildProcess) {
        const lines = new LineBuffer();
        child.stdout!.on('data', chunk => {
            for (const line of lines.push(chunk.toString())) {
                const reply = parseDriverLine(line);
                if (reply) this.deliver(reply);
            }
        });
        child.stderr!.on('data', chunk => (this.stderr = (this.stderr + chunk.toString()).slice(-4000)));
        child.stdin!.on('error', () => {});
        child.on('error', error => this.fail(error));
        child.on('close', () => {
            this.exited = true;
            this.fail(new Error(`The browser process stopped. ${this.stderr.split('\n').slice(-4).join(' ')}`.trim()));
        });
    }

    get alive(): boolean {
        return !this.exited;
    }

    private deliver(reply: DriverReply): void {
        const entry = this.waiting.get(reply.id);
        if (entry) {
            clearTimeout(entry.timer);
            this.waiting.delete(reply.id);
            entry.resolve(reply);
        } else if (reply.id >= 0) {
            this.early.set(reply.id, reply);
        }
    }

    private fail(error: Error): void {
        for (const [id, entry] of this.waiting) {
            clearTimeout(entry.timer);
            entry.reject(error);
            this.waiting.delete(id);
        }
    }

    waitFor(id: number, timeoutMs: number): Promise<DriverReply> {
        const got = this.early.get(id);
        if (got) {
            this.early.delete(id);
            return Promise.resolve(got);
        }
        if (this.exited) return Promise.reject(new Error(`The browser process is not running. ${this.stderr.split('\n').slice(-4).join(' ')}`.trim()));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error('The browser did not answer in time.'));
            }, timeoutMs);
            this.waiting.set(id, { resolve, reject, timer });
        });
    }

    send(command: CommandBody, timeoutMs = 60_000): Promise<DriverReply> {
        const id = this.nextId++;
        const reply = this.waitFor(id, timeoutMs);
        this.child.stdin!.write(encodeCommand({ ...command, id } as LiveCommand));
        return reply;
    }

    async close(): Promise<void> {
        if (this.exited) return;
        await this.send({ op: 'close' }, 10_000).catch(() => undefined);
        this.kill();
    }

    kill(): void {
        if (!this.exited) this.child.kill('SIGTERM');
    }
}

/** One live browser session for one project, kept across tool calls. */
export interface LiveSession {
    root: string;
    handle: DriverHandle;
    startUrl: string;
    startedAt: string;
    headed: boolean;
    caseId?: string;
    name?: string;
    /** A plain-English AI case driven by the chat's own AI (no model key). */
    ai?: AiDrive;
    allowProduction: boolean;
    /** Repository-relative screenshot folder. */
    shotsDir: string;
    steps: RecordedStep[];
    /** Latest capture of every page path visited. */
    pages: Map<string, LivePageCapture>;
    /** Elements on the page right now, for diffs and auto mode. */
    current: { url: string; title: string; elements: ExploredElement[] };
    idleTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, LiveSession>();
let factory: DriverFactory = spawnDriver;
let exitHookInstalled = false;

/** Tests swap the browser for a fake; pass undefined to restore the real one. */
export function setDriverFactory(next: DriverFactory | undefined): void {
    factory = next ?? spawnDriver;
}

export function driverFactory(): DriverFactory {
    return factory;
}

export function getSession(root: string): LiveSession | undefined {
    const session = sessions.get(root);
    if (session && !session.handle.alive) {
        clearIdle(session);
        sessions.delete(root);
        return undefined;
    }
    return session;
}

export function addSession(session: LiveSession): void {
    installExitHook();
    sessions.set(session.root, session);
    touch(session);
}

/** Resets the idle timer; called on every tool call that uses the session. */
export function touch(session: LiveSession, idleMs = IDLE_TIMEOUT_MS): void {
    clearIdle(session);
    session.idleTimer = setTimeout(() => void closeSession(session.root), idleMs);
    session.idleTimer.unref();
}

function clearIdle(session: LiveSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
}

export async function closeSession(root: string): Promise<boolean> {
    const session = sessions.get(root);
    if (!session) return false;
    sessions.delete(root);
    clearIdle(session);
    await session.handle.close();
    return true;
}

export async function closeAllSessions(): Promise<void> {
    await Promise.all([...sessions.keys()].map(root => closeSession(root)));
}

function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once('exit', () => {
        for (const session of sessions.values()) session.handle.kill();
    });
}
