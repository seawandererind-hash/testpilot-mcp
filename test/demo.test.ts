import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { demoRoot } from '../src/tools/demo.js';
import { connect, tempRepo } from './helpers.js';

describe('demo_project', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('asks first, then creates the shop, answers the wizard and serves the site', async () => {
        const root = tempRepo();
        const c = await connect(root, 'modern');
        close = c.close;

        const ask = await c.call('demo_project', { action: 'start', port: 4710 });
        expect(ask.isError).toBe(true);
        expect(ask.content[0].text).toMatch(/Approval needed/);
        expect(existsSync(path.join(root, 'demo-site'))).toBe(false);

        const res = await c.call('demo_project', { action: 'start', port: 4710, userApproved: true, approver: 'Surya' });
        expect(res.isError).toBeFalsy();
        const data = res.structuredContent;
        expect(data.nested).toBe(false);
        expect(data.wizardStep).toBe('SCAFFOLD');
        expect(data.script.map((s: { tool: string }) => s.tool)).toEqual(expect.arrayContaining(['preview_scaffold', 'live_test', 'run_tests', 'heal_tests']));
        expect(readFileSync(path.join(root, 'test-cases/shop.csv'), 'utf8')).toContain('SHOP-1');
        expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('TEST_USER_EMAIL=qa@example.com');
        const config = readFileSync(path.join(root, '.testpilot/config.yaml'), 'utf8');
        expect(config).toContain('appType: web');
        expect(config).toContain('testCaseSource: csv');

        const page = await fetch(data.url).then(r => r.text());
        expect(page).toContain('Sign in');
        expect((await fetch(`${data.url}/../../etc/passwd`)).status).toBe(404);

        await c.call('demo_project', { action: 'break' });
        expect(await fetch(data.url).then(r => r.text())).toContain('Log in');
        await c.call('demo_project', { action: 'restore' });
        expect(await fetch(data.url).then(r => r.text())).toContain('Sign in');

        // Starting again reuses the running shop and keeps the answers.
        const again = await c.call('demo_project', { action: 'start', port: 4710 });
        expect(again.isError).toBeFalsy();
        expect(again.structuredContent.url).toBe(data.url);

        const stopped = await c.call('demo_project', { action: 'stop' });
        expect(stopped.structuredContent.stopped).toBe(true);
    });

    it('uses a subfolder when the folder already holds a project', () => {
        const root = tempRepo({ 'src/index.ts': 'export {}' });
        expect(demoRoot(root)).toBe(path.join(root, 'testpilot-demo'));
        const empty = tempRepo();
        expect(demoRoot(empty)).toBe(empty);
        mkdirSync(path.join(root, 'testpilot-demo'), { recursive: true });
    });
});
