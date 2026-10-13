import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

/**
 * A tiny static web server for the practice shop, run inside the TestPilot process so the demo
 * needs no Python or extra package. It only serves files from the demo folder, on 127.0.0.1.
 */
interface Running {
    server: Server;
    port: number;
    dir: string;
}

const running = new Map<string, Running>();

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function demoServerFor(dir: string): { url: string; port: number } | undefined {
    const r = running.get(path.resolve(dir));
    return r ? { url: `http://localhost:${r.port}`, port: r.port } : undefined;
}

/** Starts (or reuses) the server for a folder, trying ports from `firstPort` upwards. */
export async function startDemoServer(dir: string, firstPort = 4599): Promise<{ url: string; port: number; reused: boolean }> {
    const root = path.resolve(dir);
    const existing = running.get(root);
    if (existing) return { url: `http://localhost:${existing.port}`, port: existing.port, reused: true };
    const server = createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
        const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
            return;
        }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
    });
    for (let port = firstPort; port < firstPort + 30; port++) {
        const ok = await new Promise<boolean>(resolve => {
            server.once('error', () => resolve(false));
            server.listen(port, '127.0.0.1', () => resolve(true));
        });
        if (ok) {
            server.unref();
            running.set(root, { server, port, dir: root });
            return { url: `http://localhost:${port}`, port, reused: false };
        }
    }
    throw new Error(`No free port between ${firstPort} and ${firstPort + 29} for the demo shop.`);
}

export async function stopDemoServer(dir: string): Promise<boolean> {
    const root = path.resolve(dir);
    const r = running.get(root);
    if (!r) return false;
    running.delete(root);
    await new Promise<void>(resolve => r.server.close(() => resolve()));
    return true;
}
