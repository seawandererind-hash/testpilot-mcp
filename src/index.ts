#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `TestPilot MCP ${VERSION}

Usage:
  testpilot-mcp [--root <repo folder>]                 Serve over stdio (Cursor, Claude Code, Antigravity, VS Code…)
  testpilot-mcp --http [--port 3333] [--host 127.0.0.1] Serve over Streamable HTTP

Options:
  --root <path>   Repository folder to work in (default: TESTPILOT_ROOT or the current folder)
  --http          Serve Streamable HTTP instead of stdio
  --port <n>      HTTP port (default 3333)
  --host <addr>   HTTP bind address (default 127.0.0.1)
  --version       Print the version
`;

const { values } = parseArgs({
    options: {
        root: { type: 'string' },
        http: { type: 'boolean', default: false },
        port: { type: 'string', default: process.env.PORT ?? '3333' },
        host: { type: 'string', default: '127.0.0.1' },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
    },
    allowPositionals: false
});

if (values.help) {
    console.error(HELP);
    process.exit(0);
}
if (values.version) {
    console.error(VERSION);
    process.exit(0);
}

const root = values.root ?? process.env.TESTPILOT_ROOT;

if (values.http) {
    const token = process.env.TESTPILOT_HTTP_TOKEN;
    const handler = createMcpHandler(() => createServer({ root, mode: 'local' }));
    const nodeHandler = toNodeHandler(handler);
    const local = values.host === '127.0.0.1' || values.host === 'localhost' || values.host === '::1';
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const httpServer = createHttpServer((req, res) => {
        if (!req.url?.startsWith('/mcp')) {
            res.writeHead(404).end('TestPilot MCP: the endpoint is /mcp');
            return;
        }
        if (local && (!validateHost(req, res) || !validateOrigin(req, res))) return;
        if (token && req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end('Unauthorized');
            return;
        }
        void nodeHandler(req, res);
    });
    if (!local && !token) console.error('[testpilot] Warning: serving on a non-local address without TESTPILOT_HTTP_TOKEN. Put it behind authentication.');
    httpServer.listen(Number(values.port), values.host, () => console.error(`[testpilot] TestPilot MCP ${VERSION} listening on http://${values.host}:${values.port}/mcp`));
    process.on('SIGINT', async () => {
        await handler.close();
        httpServer.close();
        process.exit(0);
    });
} else {
    const handle = serveStdio(() => createServer({ root, mode: 'local' }));
    console.error(`[testpilot] TestPilot MCP ${VERSION} ready on stdio${root ? ` (root ${root})` : ''}`);
    process.on('SIGINT', () => void handle.close());
}
