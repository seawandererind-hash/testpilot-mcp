import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createServer } from '../src/server.js';

/** A throwaway repository folder with a package.json so it looks like a project. */
export function tempRepo(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'testpilot-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.0.0' }));
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

export type Era = 'legacy' | 'modern';

/** Connects an in-process client to a TestPilot handler in the given protocol era. */
export async function connect(root: string, era: Era, opts: { elicit?: (params: { message: string; requestedSchema: unknown }) => Record<string, unknown> | undefined } = {}) {
    const handler = createMcpHandler(() => createServer({ root }));
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
    });
    const client = new Client(
        { name: 'testpilot-tests', version: '1.0.0' },
        { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' }, capabilities: opts.elicit ? { elicitation: { form: {} } } : {} }
    );
    if (opts.elicit) {
        client.setRequestHandler('elicitation/create', async request => {
            const content = opts.elicit!(request.params as never);
            return content ? { action: 'accept', content } : { action: 'decline' };
        });
    }
    await client.connect(transport);
    return {
        client,
        async call(name: string, args: Record<string, unknown> = {}) {
            const res = await client.callTool({ name, arguments: { projectRoot: root, ...args } });
            return res as { content: Array<{ type: string; text: string }>; structuredContent?: any; isError?: boolean };
        },
        async close() {
            await client.close();
            await handler.close();
        }
    };
}
