import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

import { tempRepo } from './helpers.js';

const server = path.resolve('plugins/testpilot/server');
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { structuredContent?: any; isError?: boolean; content: Array<{ text: string }> };

describe('server bundled in the plugin', () => {
    it('is the released version and runs the guided setup through to a scaffold preview', async () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
        const bundled = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
        expect(bundled.version).toBe(pkg.version);

        const root = tempRepo();
        const client = new Client({ name: 'bundle-test', version: '1.0.0' });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(server, 'testpilot.mjs'), '--root', root] }));
        try {
            expect(client.getServerVersion()?.version).toBe(pkg.version);
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
            for (const [step, answer] of answers) expect((await call(client, 'wizard', { projectRoot: root, action: 'answer', step, answer })).isError).toBeFalsy();
            const preview = await call(client, 'preview_scaffold', { projectRoot: root });
            expect(preview.isError).toBeFalsy();
            const paths = preview.structuredContent.files.map((f: { path: string }) => f.path);
            expect(paths).toEqual(expect.arrayContaining(['playwright.config.ts', 'src/pages/BasePage.ts', '.cursor/mcp.json', '.claude/skills/write-playwright-test/SKILL.md']));
        } finally {
            await client.close();
        }
    }, 60_000);
});
