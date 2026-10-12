import { existsSync } from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

import { tempRepo } from './helpers.js';

const entry = path.resolve('dist/index.js');

describe.skipIf(!existsSync(entry))('stdio (built server)', () => {
    it.each(['legacy', 'auto'] as const)('serves %s clients and shows wizard forms', async mode => {
        const root = tempRepo();
        const client = new Client({ name: 'stdio-test', version: '1.0.0' }, { versionNegotiation: { mode }, capabilities: { elicitation: { form: {} } } });
        const asked: string[] = [];
        client.setRequestHandler('elicitation/create', async request => {
            asked.push((request.params as { message: string }).message);
            return { action: 'accept', content: { answer: 'api' } };
        });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--root', root] }));
        try {
            const res = (await client.callTool({ name: 'wizard', arguments: { action: 'next' } })) as { structuredContent?: any; isError?: boolean };
            expect(res.isError).toBeFalsy();
            expect(asked[0]).toContain('What kind of application');
            expect(res.structuredContent.saved).toContain('API');
        } finally {
            await client.close();
        }
    }, 30_000);
});
