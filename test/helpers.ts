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

type Connected = Awaited<ReturnType<typeof connect>>;

/** Answers the wizard for a web + Playwright + Excel setup up to (not including) SCAFFOLD. */
export async function answerWebSetup(c: Connected, root: string, overrides: Record<string, string | string[]> = {}): Promise<void> {
    const answers: Array<[string, string | string[]]> = [
        ['APP_TYPE', 'web'],
        ['FRAMEWORK', 'playwright'],
        ['LANGUAGE', 'typescript'],
        ['PATTERN', 'pom'],
        ['EXECUTION_TARGET', 'local'],
        ['TEST_CASE_SOURCE', 'excel'],
        ['CI', 'github-actions'],
        ['REPORTING', ['html', 'junit']]
    ];
    for (const [step, answer] of answers) {
        const res = await c.call('wizard', { action: 'answer', step, answer: overrides[step] ?? answer });
        if (res.isError) throw new Error(`${step}: ${res.content[0].text}`);
    }
    await c.call('write_env_template');
    writeFileSync(path.join(root, '.env'), 'TEST_USER_EMAIL=qa@example.com\nTEST_USER_PASSWORD=not-a-real-password\n');
    const env = await c.call('check_env');
    if (env.isError || !env.structuredContent.ok) throw new Error(`check_env: ${env.content[0].text}`);
}
