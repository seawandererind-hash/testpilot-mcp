import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { junitFromRun } from '../src/report/report.js';
import type { RunSummary, TestOutcome } from '../src/run/playwright.js';
import { answerWebSetup, connect, tempRepo } from './helpers.js';

function outcome(id: string, status: TestOutcome['status'], extra: Partial<TestOutcome> = {}): TestOutcome {
    return { id, title: `${id} ${status} case`, file: 'tests/shop.spec.ts', line: 3, project: 'chromium', status, runs: 1, passes: status === 'passed' ? 1 : 0, durationMs: 1200, attachments: [], ...extra };
}

function saveRun(root: string, tests: TestOutcome[]): RunSummary {
    const run: RunSummary = {
        startedAt: '2026-10-12T09:00:00.000Z',
        finishedAt: '2026-10-12T09:01:00.000Z',
        command: 'npx playwright test',
        exitCode: tests.some(t => t.status === 'failed') ? 1 : 0,
        repeat: 1,
        stats: {
            total: tests.length,
            passed: tests.filter(t => t.status === 'passed').length,
            failed: tests.filter(t => t.status === 'failed').length,
            flaky: tests.filter(t => t.status === 'flaky').length,
            skipped: tests.filter(t => t.status === 'skipped').length,
            durationMs: 60_000
        },
        tests,
        byCategory: {}
    };
    mkdirSync(path.join(root, '.testpilot/runs'), { recursive: true });
    writeFileSync(path.join(root, '.testpilot/runs/latest.json'), JSON.stringify(run));
    return run;
}

describe('junit export', () => {
    it('puts the test-case id in a test_key property and escapes text', () => {
        const xml = junitFromRun({
            startedAt: '2026-10-12T09:00:00.000Z',
            finishedAt: '',
            command: '',
            exitCode: 1,
            repeat: 1,
            stats: { total: 2, passed: 1, failed: 1, flaky: 0, skipped: 0, durationMs: 2000 },
            tests: [outcome('SHOP-1', 'passed'), outcome('SHOP-2', 'failed', { title: 'SHOP-2 <cart> & "checkout"', error: 'Expected: 1\u0007\nReceived: 0', category: 'assertion' })],
            byCategory: {}
        });
        expect(xml).toContain('<property name="test_key" value="SHOP-1"/>');
        expect(xml).toContain('name="SHOP-2 &lt;cart&gt; &amp; &quot;checkout&quot;"');
        expect(xml).toContain('<failure message="Expected: 1" type="assertion">');
        expect(xml).not.toContain('\u0007');
        expect(xml).toMatch(/tests="2" failures="1"/);
    });
});

describe('publish_results', () => {
    let root: string;
    afterEach(() => vi.unstubAllGlobals());

    async function ready(env = '') {
        root = tempRepo();
        const c = await connect(root, 'modern');
        await answerWebSetup(c, root);
        if (env) writeFileSync(path.join(root, '.env'), `TEST_USER_EMAIL=qa@example.com\nTEST_USER_PASSWORD=not-a-real-password\n${env}`);
        return c;
    }

    it('writes a Markdown and a self-contained HTML report', async () => {
        const c = await ready();
        saveRun(root, [outcome('TC-001', 'passed'), outcome('TC-002', 'failed', { error: 'expect(locator).toHaveText(expected) failed\n<script>alert(1)</script>', category: 'assertion', advice: 'Check the app.' }), outcome('TC-003', 'flaky', { runs: 3, passes: 2 })]);
        const res = await c.call('publish_results', { action: 'report' });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain('1 passed, 1 failed, 1 flaky');
        const html = readFileSync(path.join(root, '.testpilot/reports/latest.html'), 'utf8');
        expect(html).toContain('<title>Test report:');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/https?:\/\/(?!playwright)/);
        const mdText = readFileSync(path.join(root, '.testpilot/reports/latest.md'), 'utf8');
        expect(mdText).toContain('## Failures');
        expect(mdText).toContain('passed 2 of 3 runs');
        await c.close();
    });

    it('previews the CI pipeline, then writes it only with the token and approval', async () => {
        const c = await ready();
        const preview = await c.call('publish_results', { action: 'ci' });
        expect(preview.isError).toBeFalsy();
        const token = preview.structuredContent.confirmToken as string;
        expect(token).toMatch(/^ci-/);
        expect(preview.structuredContent.secretNames).toContain('TEST_USER_PASSWORD');
        expect(preview.structuredContent.variableNames).toContain('APP_BASE_URL');
        expect(existsSync(path.join(root, '.github/workflows/ui-tests.yml'))).toBe(false);

        const wrongToken = await c.call('publish_results', { action: 'ci', confirmToken: 'ci-nope', userApproved: true });
        expect(wrongToken.isError).toBe(true);
        const unapproved = await c.call('publish_results', { action: 'ci', confirmToken: token });
        expect(existsSync(path.join(root, '.github/workflows/ui-tests.yml'))).toBe(false);
        expect(unapproved.content[0].text).toMatch(/approv/i);

        const applied = await c.call('publish_results', { action: 'ci', confirmToken: token, userApproved: true, approver: 'Surya' });
        expect(applied.isError).toBeFalsy();
        const yml = readFileSync(path.join(root, '.github/workflows/ui-tests.yml'), 'utf8');
        expect(yml).toContain('TEST_USER_PASSWORD: ${{ secrets.TEST_USER_PASSWORD }}');
        expect(yml).toContain('APP_BASE_URL: ${{ vars.APP_BASE_URL }}');
        expect(yml).toContain('if: ${{ !cancelled() }}');
        expect(yml).toContain('npx playwright install --with-deps chromium');
        expect(yml).not.toMatch(/not-a-real-password/);
        expect(readFileSync(path.join(root, '.testpilot/decisions.md'), 'utf8')).toContain('github-actions pipeline');

        const again = await c.call('publish_results', { action: 'ci' });
        expect(again.content[0].text).toContain('already up to date');
        await c.close();
    });

    it.each(['azure-devops', 'gitlab', 'jenkins'])('renders a %s pipeline without leaking values', async provider => {
        const c = await ready();
        const preview = await c.call('publish_results', { action: 'ci', provider });
        expect(preview.isError).toBeFalsy();
        const text = preview.content[0].text;
        expect(text).toContain('TEST_USER_PASSWORD');
        expect(text).not.toContain('not-a-real-password');
        // Every Handlebars tag was rendered; only the pipeline's own ${{ }} expressions remain.
        expect(text).not.toMatch(/(?<!\$)\{\{/);
        await c.close();
    });

    it('sends results to TestRail after approval, matching C-ids only', async () => {
        const c = await ready('TESTRAIL_URL=https://acme.testrail.io\nTESTRAIL_USER=qa@example.com\nTESTRAIL_API_KEY=tr-secret-key-123\n');
        saveRun(root, [outcome('C101', 'passed'), outcome('C102', 'failed', { error: 'boom', category: 'assertion' }), outcome('TC-009', 'passed')]);
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit) => {
                calls.push({ url, init });
                if (url.includes('add_run')) return new Response(JSON.stringify({ id: 77, url: 'https://acme.testrail.io/index.php?/runs/view/77' }), { status: 200 });
                return new Response('[]', { status: 200 });
            })
        );

        const missing = await c.call('publish_results', { action: 'sync', target: 'testrail' });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain('projectId');

        const preview = await c.call('publish_results', { action: 'sync', target: 'testrail', projectId: '3' });
        expect(preview.isError).toBeFalsy();
        expect(preview.structuredContent.results).toEqual([
            { id: 'C101', status: 'passed' },
            { id: 'C102', status: 'failed' }
        ]);
        expect(preview.structuredContent.skipped[0]).toContain('TC-009');
        expect(calls).toHaveLength(0);

        const refused = await c.call('publish_results', { action: 'sync', target: 'testrail', projectId: '3', confirmToken: preview.structuredContent.confirmToken });
        expect(calls).toHaveLength(0);
        expect(refused.content[0].text).toMatch(/approv/i);

        const sent = await c.call('publish_results', { action: 'sync', target: 'testrail', projectId: '3', confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        expect(sent.isError).toBeFalsy();
        expect(sent.content[0].text).toContain('Sent 2 result(s) to testrail');
        expect(sent.content[0].text).toContain('R77');
        expect(sent.content[0].text).not.toContain('tr-secret-key-123');
        expect(calls[0].url).toBe('https://acme.testrail.io/index.php?/api/v2/add_run/3');
        expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ case_ids: [101, 102], include_all: false });
        const results = JSON.parse(String(calls[1].init.body)).results;
        expect(results.map((r: { case_id: number; status_id: number }) => [r.case_id, r.status_id])).toEqual([
            [101, 1],
            [102, 5]
        ]);
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('qa@example.com:tr-secret-key-123').toString('base64')}`);
        await c.close();
    });

    it('sends results to Xray as JUnit and explains a rejected key without echoing it', async () => {
        const c = await ready('XRAY_CLIENT_ID=client-1\nXRAY_CLIENT_SECRET=xray-secret-456\nJIRA_BASE_URL=https://acme.atlassian.net\n');
        saveRun(root, [outcome('SHOP-1', 'passed'), outcome('SHOP-2', 'flaky', { runs: 2, passes: 1 })]);
        let authStatus = 200;
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit) => {
                calls.push({ url, init });
                if (url.endsWith('/authenticate')) return authStatus === 200 ? new Response('"jwt-token"', { status: 200 }) : new Response('{"error":"bad client_secret","client_secret":"xray-secret-456"}', { status: 401 });
                return new Response(JSON.stringify({ id: '1', key: 'SHOP-99' }), { status: 200 });
            })
        );
        const preview = await c.call('publish_results', { action: 'sync', target: 'xray' });
        expect(preview.isError).toBeFalsy();
        expect(preview.structuredContent.options.projectKey).toBe('SHOP');
        const token = preview.structuredContent.confirmToken;

        const sent = await c.call('publish_results', { action: 'sync', target: 'xray', confirmToken: token, userApproved: true });
        expect(sent.isError).toBeFalsy();
        expect(sent.content[0].text).toContain('SHOP-99');
        expect(sent.content[0].text).toContain('https://acme.atlassian.net/browse/SHOP-99');
        expect(calls[1].url).toBe('https://xray.cloud.getxray.app/api/v2/import/execution/junit?projectKey=SHOP');
        expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token');
        expect(String(calls[1].init.body)).toContain('<property name="test_key" value="SHOP-2"/>');

        authStatus = 401;
        const rejected = await c.call('publish_results', { action: 'sync', target: 'xray', confirmToken: token, userApproved: true });
        expect(rejected.isError).toBe(true);
        expect(rejected.content[0].text).toContain('credentials were rejected');
        expect(rejected.content[0].text).not.toContain('xray-secret-456');
        await c.close();
    });

    it('asks in a form when the client supports it and stops when the user declines', async () => {
        root = tempRepo();
        let asked = '';
        const c = await connect(root, 'modern', {
            elicit: params => {
                asked = params.message;
                return undefined;
            }
        });
        await answerWebSetup(c, root);
        writeFileSync(path.join(root, '.env'), 'TEST_USER_EMAIL=qa@example.com\nTEST_USER_PASSWORD=x\nTESTRAIL_URL=https://acme.testrail.io\nTESTRAIL_USER=qa@example.com\nTESTRAIL_API_KEY=k-123456\n');
        saveRun(root, [outcome('C5', 'passed')]);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const preview = await c.call('publish_results', { action: 'sync', target: 'testrail', projectId: '1' });
        const res = await c.call('publish_results', { action: 'sync', target: 'testrail', projectId: '1', confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        expect(asked).toContain('Send 1 test result(s)');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(res.content[0].text).toMatch(/did not approve/);
        await c.close();
    });
});
