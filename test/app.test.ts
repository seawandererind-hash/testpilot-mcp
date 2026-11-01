import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appPageHtml } from '../src/ui-app/page.js';
import { type RunningApp, safeUploadName, startApp } from '../src/ui-app/server.js';
import { connect, tempRepo } from './helpers.js';

process.env.TESTPILOT_NO_BROWSER = '1';

/** A raw request, so the Host header can be set to anything. */
function raw(port: number, opts: { method?: string; path: string; host?: string; key?: string; body?: string | Buffer }): Promise<{ status: number; json: any; text: string }> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
        if (opts.key) headers['x-testpilot-key'] = opts.key;
        if (opts.body && typeof opts.body === 'string') headers['content-type'] = 'application/json';
        const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers }, res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json: any;
                try {
                    json = JSON.parse(text);
                } catch {
                    json = undefined;
                }
                resolve({ status: res.statusCode ?? 0, json, text });
            });
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

describe('TestPilot app (point-and-click UI)', () => {
    let app: RunningApp;
    let root: string;
    let key: string;

    beforeAll(async () => {
        root = tempRepo();
        app = await startApp({ root });
        key = new URL(app.url).searchParams.get('key')!;
    });
    afterAll(async () => {
        await app.close();
    });

    it('listens on this computer only, with a key in the address', () => {
        expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?key=[\w-]{32}$/);
    });

    it('serves the page, but refuses other host names (DNS rebinding)', async () => {
        const ok = await raw(app.port, { path: '/' });
        expect(ok.status).toBe(200);
        expect(ok.text).toContain('<title>TestPilot</title>');
        const evil = await raw(app.port, { path: '/', host: 'evil.example:80' });
        expect(evil.status).toBe(403);
    });

    it('refuses API calls without the key', async () => {
        const res = await raw(app.port, { method: 'POST', path: '/api/call', body: JSON.stringify({ name: 'testpilot_status' }) });
        expect(res.status).toBe(401);
        const wrong = await raw(app.port, { method: 'POST', path: '/api/call', key: 'x'.repeat(32), body: JSON.stringify({ name: 'testpilot_status' }) });
        expect(wrong.status).toBe(401);
    });

    it('calls the same tools as the chat, and the wizard asks the app type first', async () => {
        const info = await raw(app.port, { path: '/api/info', key });
        expect(info.json.root).toBe(app.root);
        const res = await raw(app.port, { method: 'POST', path: '/api/call', key, body: JSON.stringify({ name: 'wizard', arguments: { action: 'next', interactive: false } }) });
        expect(res.json.ok).toBe(true);
        expect(res.json.data.step.step).toBe('APP_TYPE');
        expect(res.json.text).not.toContain('"step"');
    });

    it('keeps approval gates: a write without approval comes back as "Approval needed"', async () => {
        const call = (name: string, args: Record<string, unknown>) => raw(app.port, { method: 'POST', path: '/api/call', key, body: JSON.stringify({ name, arguments: args }) });
        for (const [step, answer] of [
            ['APP_TYPE', 'web'],
            ['FRAMEWORK', 'playwright'],
            ['LANGUAGE', 'typescript']
        ]) {
            expect((await call('wizard', { action: 'answer', step, answer })).json.ok).toBe(true);
        }
        const saved = await call('save_test_case', { id: 'A-1', title: 'Customer can sign in', steps: [{ action: 'Open the sign-in page' }] });
        expect(saved.json.ok).toBe(true);
        const preview = await call('preview_scaffold', {});
        expect(preview.json.ok).toBe(true);
        const res = await call('scaffold_project', { confirmToken: preview.json.data.confirmToken });
        expect(res.json.ok).toBe(false);
        expect(res.json.text).toMatch(/^Approval needed\. Show the user the preview and ask: ".*"\. Call this tool again/s);
    });

    it('lists tools for the advanced page without hosted-only ones', async () => {
        const res = await raw(app.port, { path: '/api/tools', key });
        const names = res.json.tools.map((t: { name: string }) => t.name);
        expect(names).toContain('wizard');
        expect(names).not.toContain('hosted_workspace');
    });

    it('stores uploads in test-cases/ without overwriting, and refuses other file types', async () => {
        const first = await raw(app.port, { method: 'POST', path: '/api/upload?name=cases.csv', key, body: Buffer.from('id,title\nA-1,One\n') });
        const second = await raw(app.port, { method: 'POST', path: '/api/upload?name=cases.csv', key, body: Buffer.from('id,title\nA-2,Two\n') });
        expect(first.json.path).toBe('test-cases/cases.csv');
        expect(second.json.path).toBe('test-cases/cases (2).csv');
        expect(readFileSync(path.join(app.root, 'test-cases/cases.csv'), 'utf8')).toContain('A-1');
        const bad = await raw(app.port, { method: 'POST', path: '/api/upload?name=run.sh', key, body: 'x' });
        expect(bad.status).toBe(500);
        expect(safeUploadName('..\\..\\x.xlsx')).toBe('x.xlsx');
        expect(safeUploadName('../../.hidden.csv')).toBe('hidden.csv');
        expect(() => safeUploadName('evil.exe')).toThrow();
    });

    it('reuses one app per project', async () => {
        const again = await startApp({ root });
        expect(again.url).toBe(app.url);
    });
});

describe('opening the app from the chat', () => {
    it('testpilot_status with openApp starts it and returns the address', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        try {
            const res = await c.call('testpilot_status', { openApp: true });
            expect(res.isError).toBeFalsy();
            expect(res.structuredContent.appUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?key=/);
            expect(res.content[0].text).toContain('The TestPilot app is open');
            const again = await c.call('testpilot_status', { openApp: true });
            expect(again.structuredContent.appUrl).toBe(res.structuredContent.appUrl);
            const { startApp: s } = await import('../src/ui-app/server.js');
            await (await s({ root })).close();
        } finally {
            await c.close();
        }
    });

    it('the page script has no template-literal syntax that would break the embedded HTML', () => {
        const html = appPageHtml();
        const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
        expect(script).not.toContain('`');
        expect(script).not.toContain('${');
        expect(html).not.toMatch(/<script[^>]+src=/);
    });
});
