import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { ProjectStore } from '../core/store.js';
import { planCursorMcpConfig } from '../knowledge/generate.js';
import { PACKAGE_NAME } from '../version.js';

/**
 * The chat inside the TestPilot app. The app has no AI of its own: it hands each message to an
 * AI command-line tool the person already has and is signed in to, in this project folder:
 *  - Cursor CLI (`agent`, signed in with the person's Cursor account, so it uses their Cursor plan)
 *  - Claude Code (`claude`, signed in with their Claude account)
 * The tool talks to TestPilot over MCP like the editor chat does, so the same approval gates apply:
 * TestPilot answers "Approval needed", the AI asks in the chat, and the person's "yes" comes as the next message.
 */

export type EngineId = 'cursor' | 'claude';

export interface EngineInfo {
    id: EngineId;
    name: string;
    found: boolean;
    command?: string;
    version?: string;
    /** For Cursor: whether the Cursor CLI will see a testpilot MCP server in this project or the user's settings. */
    testpilotConnected?: boolean;
    install: string;
    signIn: string;
}

/** Events streamed to the page, one JSON object per line. */
export type ChatEvent =
    | { type: 'start'; engine: EngineId }
    | { type: 'text'; text: string }
    | { type: 'tool'; name: string; status: 'started' | 'done' }
    | { type: 'done'; sessionId?: string }
    | { type: 'error'; text: string };

const GUIDE = [
    'You are the chat inside the TestPilot app, helping someone who may be new to software testing.',
    'Use the TestPilot MCP tools (testpilot_status first) for everything about test automation in this project. The setup wizard always asks the kind of app first, then the framework, then the language: ask the person each question in plain words and never pick answers for them.',
    'When a TestPilot tool says "Approval needed", show what will happen and ask the person; only call it again with userApproved: true after they clearly say yes in a later message.',
    'Never ask for passwords or keys: they go in the .env file, which the person edits. Keep answers short and friendly, with no jargon. The person can also click the same steps in the TestPilot app pages.'
].join(' ');

function candidates(id: EngineId): string[] {
    // TESTPILOT_CURSOR_AGENT / TESTPILOT_CLAUDE_CLI point at the program when it is not on PATH.
    if (id === 'cursor') return process.env.TESTPILOT_CURSOR_AGENT ? [process.env.TESTPILOT_CURSOR_AGENT] : ['agent', 'cursor-agent'];
    return process.env.TESTPILOT_CLAUDE_CLI ? [process.env.TESTPILOT_CLAUDE_CLI] : ['claude'];
}

function probe(command: string): Promise<string | undefined> {
    return new Promise(resolve => {
        let out = '';
        let child: ChildProcess;
        try {
            child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch {
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => {
            child.kill();
            resolve(undefined);
        }, 8000);
        child.stdout?.on('data', d => (out += String(d)));
        child.on('error', () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        child.on('close', code => {
            clearTimeout(timer);
            // `agent` is also a common word: only accept something that answers --version with a version number.
            const version = /\d+\.\d+(\.\d+)?/.exec(out)?.[0];
            resolve(code === 0 && version ? out.trim().split('\n')[0].slice(0, 80) : undefined);
        });
    });
}

function mentionsTestpilot(file: string): boolean {
    try {
        const json = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
        return Boolean(json.mcpServers && Object.keys(json.mcpServers).some(k => /testpilot/i.test(k)));
    } catch {
        return false;
    }
}

export function cursorSeesTestpilot(root: string): boolean {
    return mentionsTestpilot(path.join(root, '.cursor', 'mcp.json')) || mentionsTestpilot(path.join(homedir(), '.cursor', 'mcp.json'));
}

const INSTALL = {
    cursor: {
        win32: "In PowerShell: irm 'https://cursor.com/install?win32=true' | iex   then close and reopen Cursor (or the PowerShell window).",
        other: 'In a terminal: curl https://cursor.com/install -fsS | bash'
    },
    claude: { win32: 'In PowerShell: irm https://claude.ai/install.ps1 | iex', other: 'In a terminal: curl -fsSL https://claude.ai/install.sh | bash' }
};

export async function detectEngines(root: string): Promise<EngineInfo[]> {
    const os = process.platform === 'win32' ? 'win32' : 'other';
    const find = async (id: EngineId) => {
        for (const command of candidates(id)) {
            const version = await probe(command);
            if (version) return { command, version };
        }
        return undefined;
    };
    const [cursor, claude] = await Promise.all([find('cursor'), find('claude')]);
    return [
        {
            id: 'cursor',
            name: 'Cursor (your Cursor plan)',
            found: Boolean(cursor),
            ...cursor,
            testpilotConnected: cursorSeesTestpilot(root),
            install: INSTALL.cursor[os],
            signIn: 'agent login'
        },
        { id: 'claude', name: 'Claude Code (your Claude plan)', found: Boolean(claude), ...claude, install: INSTALL.claude[os], signIn: 'claude   (then type /login)' }
    ];
}

/** Adds the testpilot server to the project's .cursor/mcp.json (merging, never replacing other servers). */
export function connectCursor(root: string): { path: string; status: string; note?: string } {
    const store = new ProjectStore(root);
    const plan = planCursorMcpConfig(store, PACKAGE_NAME);
    if (plan.status === 'new' || plan.status === 'merge') {
        store.write(plan.path, plan.content);
        store.recordDecision('Connected the Cursor CLI chat in the TestPilot app to TestPilot', `${plan.status === 'new' ? 'Created' : 'Updated'} ${plan.path}`, 'user (TestPilot app)');
    }
    return { path: plan.path, status: plan.status, note: plan.note };
}

/** The command that starts this same TestPilot server, for Claude Code's --mcp-config. */
function selfServer(root: string): { command: string; args: string[] } {
    const script = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
    if (script && existsSync(script)) return { command: process.execPath, args: [script, '--root', root] };
    return { command: 'npx', args: ['-y', PACKAGE_NAME, '--root', root] };
}

/** cmd.exe cannot carry line breaks inside one argument; everything else is quoted by cross-spawn. */
function oneLine(text: string): string {
    return process.platform === 'win32' ? text.replace(/\r?\n/g, ' ') : text;
}

/** Cursor CLI: "agent create-chat" returns a chat id that later turns pass to --resume. */
export function createCursorChat(engine: EngineInfo, root: string): Promise<string | undefined> {
    return new Promise(resolve => {
        let out = '';
        let child: ChildProcess;
        try {
            child = spawn(engine.command ?? 'agent', ['create-chat'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch {
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => child.kill(), 30_000);
        child.stdout?.on('data', d => (out += String(d)));
        child.on('error', () => resolve(undefined));
        child.on('close', code => {
            clearTimeout(timer);
            const id = out.trim().split(/\s+/).reverse().find(w => /^[A-Za-z0-9-]{8,}$/.test(w));
            resolve(code === 0 ? id : undefined);
        });
    });
}

export function buildCommand(engine: EngineInfo, root: string, message: string, sessionId?: string, firstTurn = !sessionId): { command: string; args: string[] } {
    const prompt = firstTurn ? `${GUIDE}\n\nThe person says: ${message}` : message;
    if (engine.id === 'cursor') {
        const args = ['-p', '--output-format', 'stream-json', '--workspace', root, '--trust', '--approve-mcps'];
        if (sessionId) args.push('--resume', sessionId);
        args.push(oneLine(prompt));
        return { command: engine.command ?? 'agent', args };
    }
    const mcp = JSON.stringify({ mcpServers: { testpilot: selfServer(root) } });
    const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--mcp-config',
        mcp,
        '--strict-mcp-config',
        // TestPilot's tools plus reading and editing files in the project; no shell commands.
        '--allowedTools',
        'mcp__testpilot,Read,Glob,Grep,Edit,Write',
        '--append-system-prompt',
        oneLine(GUIDE)
    ];
    if (sessionId) args.push('--resume', sessionId);
    args.push(oneLine(message));
    return { command: engine.command ?? 'claude', args };
}

/** Turns one line of the tool's stream-json output into chat events (Cursor and Claude Code use nearly the same shape). */
export function parseStreamLine(line: string): ChatEvent[] {
    let ev: Record<string, any>;
    try {
        ev = JSON.parse(line);
    } catch {
        return [];
    }
    const out: ChatEvent[] = [];
    if (ev.type === 'assistant' && ev.message?.content) {
        // Partial-output deltas are not requested, so each assistant event is a whole message.
        for (const c of ev.message.content as Array<Record<string, any>>) {
            if (c.type === 'text' && c.text) out.push({ type: 'text', text: String(c.text) });
            if (c.type === 'tool_use' && c.name) out.push({ type: 'tool', name: friendlyTool(String(c.name)), status: 'started' });
        }
    } else if (ev.type === 'tool_call' && ev.subtype === 'started') {
        const call = (ev.tool_call ?? {}) as Record<string, any>;
        const key = Object.keys(call)[0] ?? 'tool';
        const name = call.function?.name ?? call[key]?.name ?? call[key]?.toolName ?? call[key]?.args?.toolName ?? key.replace(/ToolCall$/, '');
        out.push({ type: 'tool', name: friendlyTool(String(name)), status: 'started' });
    } else if (ev.type === 'result') {
        if (ev.is_error) out.push({ type: 'error', text: String(ev.result ?? 'The AI stopped with an error.') });
        out.push({ type: 'done', sessionId: ev.session_id ? String(ev.session_id) : undefined });
    }
    return out;
}

function friendlyTool(name: string): string {
    return name.replace(/^mcp__testpilot__/, 'TestPilot: ').replace(/^testpilot[-_]/, 'TestPilot: ');
}

export interface RunningChat {
    stop(): void;
}

/** Runs one turn of the chat and reports events as they come. */
export function runChat(engine: EngineInfo, root: string, message: string, sessionId: string | undefined, emit: (e: ChatEvent) => void, firstTurn = !sessionId): RunningChat {
    const { command, args } = buildCommand(engine, root, message, sessionId, firstTurn);
    let child: ChildProcess;
    let finished = false;
    let sawDone = false;
    let stderr = '';
    let buffer = '';
    const finish = (e?: ChatEvent) => {
        if (finished) return;
        finished = true;
        if (e) emit(e);
    };
    try {
        child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    } catch (error) {
        finish({ type: 'error', text: `Could not start ${command}: ${(error as Error).message}` });
        return { stop: () => undefined };
    }
    emit({ type: 'start', engine: engine.id });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            for (const e of parseStreamLine(line)) {
                if (e.type === 'done') {
                    sawDone = true;
                    finish(e);
                } else if (!finished) emit(e);
            }
        }
    });
    child.stderr?.on('data', d => (stderr = (stderr + String(d)).slice(-4000)));
    child.on('error', error => finish({ type: 'error', text: `Could not start ${command}: ${error.message}` }));
    child.on('close', code => {
        for (const e of buffer.trim() ? parseStreamLine(buffer.trim()) : []) {
            if (e.type !== 'done') continue;
            sawDone = true;
            finish(e);
        }
        if (sawDone) return;
        const hint = /login|log in|sign in|authenticat|unauthori[sz]ed/i.test(stderr)
            ? ` You may need to sign in first: run "${engine.signIn}" in a terminal.`
            : /trust/i.test(stderr)
              ? ' The AI tool did not trust this folder.'
              : '';
        finish({ type: 'error', text: `The AI stopped${code ? ` (exit code ${code})` : ''}.${hint}${stderr.trim() ? `\n\n${stderr.trim().slice(-1200)}` : ''}` });
    });
    return {
        stop() {
            if (!finished) {
                child.kill();
                finish({ type: 'error', text: 'Stopped.' });
            }
        }
    };
}
