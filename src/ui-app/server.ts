import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';

import { insightsViewHtml } from '../apps/view.js';
import { resolveProjectRoot } from '../core/paths.js';
import { VERSION } from '../version.js';
import { ToolBridge } from './bridge.js';
import { connectCursor, createCursorChat, detectEngines, type EngineId, type EngineInfo, type RunningChat, runChat } from './chat.js';
import { appPageHtml } from './page.js';

/**
 * The TestPilot app: a point-and-click page in the browser for the same tools the AI chats use.
 * It listens on this computer only (127.0.0.1), every API call needs the random key that is in
 * the address the app opened with, and requests for any other host name are refused, so other
 * websites open in the browser cannot reach it.
 */

export interface AppOptions {
    root?: string;
    /** 0 picks a free port. */
    port?: number;
    open?: boolean;
}

export interface RunningApp {
    url: string;
    root: string;
    port: number;
    close(): Promise<void>;
}

const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 20 * 1024 * 1024;
const UPLOAD_TYPES = /\.(xlsx|xls|csv|docx|md|markdown|feature|txt)$/i;
const running = new Map<string, RunningApp>();

function defaultApprover(): string {
    try {
        return userInfo().username;
    } catch {
        return '';
    }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        // The page is fully inline; it only talks back to this server.
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self'; child-src 'self'; base-uri 'none'; form-action 'none'"
    });
    res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error(`That is too large (limit ${Math.round(limit / 1024 / 1024)} MB).`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** A file name that cannot leave the test-cases folder. */
export function safeUploadName(raw: string): string {
    const base = path.basename(raw.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
    if (!base || !UPLOAD_TYPES.test(base)) throw new Error('Upload an Excel (.xlsx), CSV, Word (.docx), Markdown or Gherkin (.feature) file.');
    return base.slice(0, 120);
}

/** Opens the address in the person's default browser. Failure is fine: the address is printed too. */
export function openInBrowser(url: string): void {
    if (process.env.TESTPILOT_NO_BROWSER) return;
    try {
        const win = process.platform === 'win32';
        // The address only holds letters, digits and URL punctuation without spaces or "&", so quoting it for cmd is safe.
        const [cmd, args] = win ? ['cmd', ['/c', 'start', '""', `"${url}"`]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
        const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: win });
        child.on('error', () => undefined);
        child.unref();
    } catch {
        /* the address is shown to the person instead */
    }
}

export async function startApp(options: AppOptions = {}): Promise<RunningApp> {
    const root = resolveProjectRoot(options.root);
    const existing = running.get(root);
    if (existing) {
        if (options.open) openInBrowser(existing.url);
        return existing;
    }

    const key = randomBytes(24).toString('base64url');
    const keyBuf = Buffer.from(key);
    const bridge = new ToolBridge(root);
    let port = 0;
    // Chat: one conversation per AI tool, one turn at a time.
    let engines: EngineInfo[] | undefined;
    const sessions: Partial<Record<EngineId, string>> = {};
    let chatRunning: RunningChat | undefined;

    const allowedHost = (host?: string) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    const hasKey = (req: IncomingMessage) => {
        const given = Buffer.from(String(req.headers['x-testpilot-key'] ?? ''));
        return given.length === keyBuf.length && timingSafeEqual(given, keyBuf);
    };

    const server: Server = createHttpServer(async (req, res) => {
        try {
            if (!allowedHost(req.headers.host)) return send(res, 403, { error: 'Open the TestPilot app with the address it printed (http://127.0.0.1:…).' });
            const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, appPageHtml(), 'text/html; charset=utf-8');
            if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(res, 204, '');
            if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
            if (!hasKey(req)) return send(res, 401, { error: 'This page has lost its key. Open the TestPilot app again from the address it printed.' });

            if (req.method === 'GET' && url.pathname === '/api/info') {
                return send(res, 200, { root, version: VERSION, approver: defaultApprover(), platform: process.platform, envExists: existsSync(path.join(root, '.env')) });
            }
            if (req.method === 'GET' && url.pathname === '/api/tools') return send(res, 200, { tools: await bridge.listTools() });
            if (req.method === 'GET' && url.pathname === '/api/insights-view') return send(res, 200, { html: insightsViewHtml() });
            if (req.method === 'POST' && url.pathname === '/api/call') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}') as { name?: unknown; arguments?: unknown };
                if (typeof body.name !== 'string' || !/^[a-z_]{1,64}$/.test(body.name)) return send(res, 400, { error: 'Unknown tool.' });
                const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? (body.arguments as Record<string, unknown>) : {};
                return send(res, 200, await bridge.call(body.name, args));
            }
            if (req.method === 'GET' && url.pathname === '/api/chat/engines') {
                engines = await detectEngines(root);
                return send(res, 200, { engines, sessions: { ...sessions } });
            }
            if (req.method === 'POST' && url.pathname === '/api/chat/connect-cursor') return send(res, 200, connectCursor(root));
            if (req.method === 'POST' && url.pathname === '/api/chat/new') {
                for (const k of Object.keys(sessions)) delete sessions[k as EngineId];
                return send(res, 200, { ok: true });
            }
            if (req.method === 'POST' && url.pathname === '/api/chat/stop') {
                chatRunning?.stop();
                return send(res, 200, { ok: true });
            }
            if (req.method === 'POST' && url.pathname === '/api/chat') {
                const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}') as { engine?: string; message?: unknown };
                const message = typeof body.message === 'string' ? body.message.trim().slice(0, 8000) : '';
                if (!message) return send(res, 400, { error: 'Type a message first.' });
                engines ??= await detectEngines(root);
                const engine = engines.find(e => e.id === body.engine && e.found);
                if (!engine) return send(res, 400, { error: 'That AI tool was not found on this computer. See the chat page for how to install it.' });
                if (chatRunning) return send(res, 409, { error: 'The AI is still answering the last message. Wait for it, or press Stop.' });
                res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
                const write = (e: unknown) => res.write(JSON.stringify(e) + '\n');
                let session = sessions[engine.id];
                let firstTurn = !session;
                if (!session && engine.id === 'cursor') {
                    write({ type: 'status', text: 'Starting a new Cursor chat…' });
                    session = await createCursorChat(engine, root);
                    if (session) sessions.cursor = session;
                    firstTurn = true;
                }
                await new Promise<void>(resolve => {
                    chatRunning = runChat(
                        engine,
                        root,
                        message,
                        session,
                        e => {
                            if (e.type === 'done' && e.sessionId && !sessions[engine.id]) sessions[engine.id] = e.sessionId;
                            write(e);
                            if (e.type === 'done' || e.type === 'error') resolve();
                        },
                        firstTurn
                    );
                    res.on('close', () => {
                        chatRunning?.stop();
                        resolve();
                    });
                });
                chatRunning = undefined;
                res.end();
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/upload') {
                const name = safeUploadName(url.searchParams.get('name') ?? '');
                const data = await readBody(req, MAX_UPLOAD);
                if (!data.length) return send(res, 400, { error: 'The file is empty.' });
                const dir = path.join(root, 'test-cases');
                mkdirSync(dir, { recursive: true });
                // Never overwrite: a second upload with the same name gets a number.
                const ext = path.extname(name);
                const stem = name.slice(0, name.length - ext.length);
                let target = name;
                for (let i = 2; existsSync(path.join(dir, target)); i++) target = `${stem} (${i})${ext}`;
                writeFileSync(path.join(dir, target), data, { flag: 'wx' });
                return send(res, 200, { path: `test-cases/${target}` });
            }
            return send(res, 404, { error: 'Not found' });
        } catch (error) {
            return send(res, 500, { error: (error as Error).message });
        }
    });
    server.requestTimeout = 0; // test runs can take many minutes
    server.headersTimeout = 60_000;

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
    const app: RunningApp = {
        url: `http://127.0.0.1:${port}/?key=${key}`,
        root,
        port,
        async close() {
            running.delete(root);
            chatRunning?.stop();
            await bridge.close();
            await new Promise<void>(resolve => server.close(() => resolve()));
            server.closeAllConnections?.();
        }
    };
    running.set(root, app);
    if (options.open) openInBrowser(app.url);
    return app;
}
