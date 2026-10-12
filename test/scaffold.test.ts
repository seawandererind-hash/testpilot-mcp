import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { answerWebSetup, connect, tempRepo } from './helpers.js';

describe('scaffold', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('previews, refuses without approval, then writes the Playwright framework and AI files', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerWebSetup(c, root);

        const preview = await c.call('preview_scaffold');
        expect(preview.isError).toBeFalsy();
        const paths = preview.structuredContent.files.map((f: { path: string }) => f.path);
        expect(paths).toEqual(
            expect.arrayContaining([
                'playwright.config.ts',
                'src/pages/BasePage.ts',
                'src/pages/HomePage.ts',
                'src/fixtures/test.ts',
                'tests/smoke/home.spec.ts',
                'package.json',
                'AGENTS.md',
                'CLAUDE.md',
                '.agents/skills/write-playwright-test/SKILL.md',
                '.claude/skills/write-playwright-test/SKILL.md',
                '.agents/skills/import-test-cases-excel/SKILL.md',
                '.cursor/mcp.json',
                '.mcp.json',
                '.agents/mcp_config.json',
                '.cursor/rules/testpilot.mdc',
                '.agents/rules/testpilot.md',
                '.github/copilot-instructions.md'
            ])
        );
        expect(existsSync(path.join(root, 'playwright.config.ts'))).toBe(false);

        const refused = await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken });
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain('Approval needed');

        const bad = await c.call('scaffold_project', { confirmToken: 'scaffold-nope', userApproved: true });
        expect(bad.isError).toBe(true);

        const done = await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken, userApproved: true, approver: 'Surya' });
        expect(done.isError).toBeFalsy();
        expect(readFileSync(path.join(root, 'playwright.config.ts'), 'utf8')).toContain("['junit', { outputFile: 'test-results/junit.xml' }]");
        const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.name).toBe('demo-app');
        expect(pkg.devDependencies['@playwright/test']).toBe('1.64.0');
        expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
        const skill = readFileSync(path.join(root, '.agents/skills/write-playwright-test/SKILL.md'), 'utf8');
        expect(skill).toMatch(/^---\nname: write-playwright-test\ndescription: .+\n---/);
        const mcp = JSON.parse(readFileSync(path.join(root, '.cursor/mcp.json'), 'utf8'));
        expect(mcp.mcpServers.testpilot.command).toBe('npx');
        expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.env');
        expect(readFileSync(path.join(root, '.testpilot/decisions.md'), 'utf8')).toContain('| Surya |');

        const status = await c.call('testpilot_status');
        expect(status.structuredContent.completedSteps).toContain('SCAFFOLD');
        expect(status.structuredContent.nextStep.step).toBe('APP_UNDER_TEST');
    });

    it('keeps files the user changed unless they agree to overwrite', async () => {
        const root = tempRepo({ 'AGENTS.md': '# Our own agent notes\n', 'playwright.config.ts': 'export default {};\n' });
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerWebSetup(c, root);
        const preview = await c.call('preview_scaffold');
        const byPath = Object.fromEntries(preview.structuredContent.files.map((f: { path: string; status: string }) => [f.path, f.status]));
        expect(byPath['AGENTS.md']).toBe('skip');
        expect(byPath['playwright.config.ts']).toBe('conflict');
        expect(preview.structuredContent.conflicts).toEqual(['playwright.config.ts']);

        const done = await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        expect(done.isError).toBeFalsy();
        expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# Our own agent notes\n');
        expect(readFileSync(path.join(root, 'playwright.config.ts'), 'utf8')).toBe('export default {};\n');
    });

    it('asks for approval in a form when the client supports it', async () => {
        const root = tempRepo();
        const asked: string[] = [];
        const c = await connect(root, 'modern', {
            elicit: params => {
                asked.push(params.message);
                return params.message.startsWith('Create the project framework') ? { approve: true, name: 'Surya' } : undefined;
            }
        });
        close = c.close;
        await answerWebSetup(c, root);
        const preview = await c.call('preview_scaffold');
        const done = await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken });
        expect(done.isError).toBeFalsy();
        expect(asked.some(m => m.startsWith('Create the project framework'))).toBe(true);
        expect(done.structuredContent.approvedBy).toBe('Surya');
    });

    it('keeps notes inside keep markers when regenerating', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerWebSetup(c, root);
        const preview = await c.call('preview_scaffold');
        await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        const agents = path.join(root, 'AGENTS.md');
        const original = readFileSync(agents, 'utf8');
        expect(original).toContain('<!-- keep -->');
        writeFileSync(agents, original.replace(/<!-- keep -->[\s\S]*?<!-- \/keep -->/, '<!-- keep -->\nTeam note: staging resets nightly.\n<!-- /keep -->'));
        await c.call('wizard', { action: 'answer', step: 'APP_UNDER_TEST', answer: 'https://staging.example.com' });
        const regen = await c.call('regenerate_docs');
        expect(regen.isError).toBeFalsy();
        const updated = readFileSync(agents, 'utf8');
        expect(updated).toContain('Team note: staging resets nightly.');
        expect(updated).toContain('https://staging.example.com');
        expect(readFileSync(path.join(root, '.env.example'), 'utf8')).toMatch(/^APP_BASE_URL=https:\/\/staging\.example\.com$/m);
    });
});
