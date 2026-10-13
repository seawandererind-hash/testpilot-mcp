import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { flakyStats } from '../src/heal/flaky.js';
import { extractFailedLocator, pageElements, rankCandidates, similarity, snapshotFromErrorContext } from '../src/heal/locators.js';
import { healRuntime } from '../src/heal/runtime.js';
import { buildStory, plainStep, readTrace } from '../src/heal/trace.js';
import { readZip } from '../src/heal/zip.js';
import { createZip } from '../src/remote/zip.js';
import type { RunSummary, TestOutcome } from '../src/run/playwright.js';
import { connect, tempRepo } from './helpers.js';

// Shaped from a real Playwright 1.56 run against examples/demo-shop with the button renamed to "Log in".
const ERROR = "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Sign in' })\n";
const ERROR_CONTEXT = `# Page snapshot

\`\`\`yaml
- generic [ref=e1]:
  - heading "Demo Shop" [level=1] [ref=e2]
  - generic [ref=e3]:
    - text: Email
    - textbox "Email" [active] [ref=e4]: qa@example.com
    - text: Password
    - textbox "Password" [ref=e5]
    - button "Log in" [ref=e6]
  - link "Products" [ref=e7] [cursor=pointer]:
    - /url: /products.html
\`\`\``;

function jsonl(lines: object[]): Buffer {
    return Buffer.from(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function traceZip(root: string, opts: { status?: number; password?: boolean } = {}): Buffer {
    const page = `${root}/src/pages/LoginPage.ts`;
    const runner = [
        { version: 8, type: 'context-options', origin: 'testRunner', browserName: '', options: {}, platform: 'linux', wallTime: 1, monotonicTime: 1, sdkLanguage: 'javascript' },
        { type: 'before', callId: 'hook@1', stepId: 'hook@1', startTime: 1776, class: 'Test', method: 'hook', title: 'Before Hooks', params: {}, stack: [] },
        { type: 'before', callId: 'pw:api@34', stepId: 'pw:api@34', parentId: 'hook@1', startTime: 1912, class: 'Test', method: 'pw:api', title: 'Create page', params: {}, stack: [] },
        { type: 'after', callId: 'pw:api@34', endTime: 1972, annotations: [] },
        { type: 'after', callId: 'hook@1', endTime: 1972, annotations: [] },
        { type: 'before', callId: 'pw:api@35', stepId: 'pw:api@35', startTime: 1975, class: 'Test', method: 'pw:api', title: 'Navigate to "/"', params: { url: '/' }, stack: [{ file: page, line: 8, column: 36 }] },
        { type: 'after', callId: 'pw:api@35', endTime: 2013, annotations: [] },
        {
            type: 'before',
            callId: 'pw:api@36',
            stepId: 'pw:api@36',
            startTime: 2016,
            class: 'Test',
            method: 'pw:api',
            title: opts.password ? 'Fill "hunter2-secret" getByLabel(\'Password\')' : 'Fill "qa@example.com" getByLabel(\'Email\')',
            params: { selector: 'internal:label="Email"i' },
            stack: [{ file: page, line: 10, column: 26 }]
        },
        { type: 'after', callId: 'pw:api@36', endTime: 2088, annotations: [] },
        { type: 'before', callId: 'pw:api@37', stepId: 'pw:api@37', startTime: 2092, class: 'Test', method: 'pw:api', title: "Click getByRole('button', { name: 'Sign in' })", params: { selector: 'internal:role=button[name="Sign in"i]' }, stack: [{ file: page, line: 11, column: 27 }] },
        { type: 'after', callId: 'pw:api@37', endTime: 7107, annotations: [], error: { name: '', message: ERROR } }
    ];
    const library = [
        { type: 'console', messageType: 'error', text: 'stats failed to load', args: [], location: { url: 'http://localhost:4599/', lineNumber: 7, columnNumber: 16 }, time: 2138, pageId: 'page@1' },
        { type: 'console', messageType: 'log', text: 'just a log', time: 2139, pageId: 'page@1' },
        { type: 'event', time: 2140, class: 'BrowserContext', method: 'pageError', params: { error: { error: { message: 'boom is not defined', name: 'ReferenceError' } } }, pageId: 'page@1' },
        { type: 'frame-snapshot', snapshot: { html: ['HTML', {}] } }
    ];
    const res = (url: string, status: number, failure?: string) => ({ type: 'resource-snapshot', snapshot: { pageref: 'page@1', request: { method: 'GET', url }, response: { status, ...(failure ? { _failureText: failure } : {}) } } });
    const network = [res('http://localhost:4599/', 200), res('http://localhost:4599/api/stats', opts.status ?? 404), res('http://localhost:1/x', -1, 'net::ERR_UNSAFE_PORT'), res('http://localhost:4599/favicon.ico', 404)];
    return createZip([
        { path: 'test.trace', data: jsonl(runner) },
        { path: '0-trace.trace', data: jsonl(library) },
        { path: '0-trace.network', data: jsonl(network) },
        { path: 'resources/page.jpeg', data: Buffer.alloc(10) }
    ]);
}

describe('zip reader', () => {
    it('reads stored and deflated entries through the central directory', () => {
        const big = Buffer.from('a'.repeat(5000));
        const zip = readZip(createZip([{ path: 'small.txt', data: Buffer.from('hi') }, { path: 'dir/big.txt', data: big }]));
        expect(zip.names).toEqual(['small.txt', 'dir/big.txt']);
        expect(zip.read('small.txt')?.toString()).toBe('hi');
        expect(zip.read('dir/big.txt')?.equals(big)).toBe(true);
        expect(zip.read('missing')).toBeUndefined();
        expect(() => readZip(Buffer.from('not a zip at all, sorry'))).toThrow(/not a ZIP/);
    });
});

describe('locators', () => {
    it('reads the locator a failed action waited for', () => {
        expect(extractFailedLocator(ERROR)?.locator).toMatchObject({ kind: 'role', role: 'button', value: 'Sign in' });
        expect(extractFailedLocator("locator.fill: Timeout\n  - waiting for locator('#login').getByLabel(\"E-mail\", { exact: true })")?.locator).toMatchObject({ kind: 'label', value: 'E-mail', exact: true });
        expect(extractFailedLocator("waiting for getByTestId('login-btn').first()")?.locator).toMatchObject({ kind: 'testid', value: 'login-btn' });
        expect(extractFailedLocator("waiting for locator('button:has-text(\"Sign in\")')")?.locator).toMatchObject({ kind: 'css', value: 'button:has-text("Sign in")' });
        expect(extractFailedLocator("Error: strict mode violation: getByRole('link', { name: 'Shop' }) resolved to 2 elements")).toMatchObject({ strict: true });
        expect(extractFailedLocator('Expected: 3\nReceived: 2')).toBeUndefined();
    });

    it('compares names like a person would', () => {
        expect(similarity('Sign in', 'Log in')).toBeGreaterThanOrEqual(0.85);
        expect(similarity('Add to cart', 'Add to basket')).toBeGreaterThanOrEqual(0.85);
        expect(similarity('Email', 'Email address')).toBeGreaterThan(0.6);
        expect(similarity('Sign in', 'Products')).toBeLessThan(0.3);
    });

    it('ranks the renamed button first and notices when the element is there after all', () => {
        const elements = pageElements(snapshotFromErrorContext(ERROR_CONTEXT)!);
        const failed = extractFailedLocator(ERROR)!.locator;
        const ranked = rankCandidates(failed, elements);
        expect(ranked.present).toBe(false);
        expect(ranked.candidates[0]).toMatchObject({ locator: { kind: 'role', role: 'button', value: 'Log in' }, reason: "The button is now called 'Log in' instead of 'Sign in'." });
        expect(ranked.candidates[0].confidence).toBeGreaterThan(0.8);
        expect(rankCandidates({ kind: 'role', method: 'getByRole', role: 'link', value: 'products' }, elements).present).toBe(true);
        expect(rankCandidates({ kind: 'label', method: 'getByLabel', value: 'E-mail' }, elements).candidates[0].locator).toEqual({ kind: 'label', value: 'Email' });
    });
});

describe('trace reader and stories', () => {
    it('lists the test steps, the failing one, console errors and failed requests', () => {
        const trace = readTrace(traceZip('/repo'), '/repo');
        expect(trace.actions.map(a => a.plain)).toEqual(['Opened /', 'Typed "qa@example.com" into the field labelled \'Email\'', "Clicked the button 'Sign in'"]);
        expect(trace.failedIndex).toBe(2);
        expect(trace.actions[2]).toMatchObject({ durationMs: 5015, at: 'src/pages/LoginPage.ts:11' });
        expect(trace.consoleErrors).toEqual(['stats failed to load', 'Uncaught error: boom is not defined']);
        expect(trace.failedRequests.map(r => `${r.url} ${r.status}`)).toEqual(['http://localhost:4599/api/stats 404', 'http://localhost:1/x -1']);
        expect(trace.pageUrl).toBe('http://localhost:4599/');
    });

    it('hides values typed into sensitive fields', () => {
        expect(plainStep('Fill "hunter2" getByLabel(\'Password\')')).toBe("Typed a hidden value into the field labelled 'Password'");
        expect(readTrace(traceZip('/repo', { password: true }), '/repo').actions[1].plain).not.toContain('hunter2');
        expect(plainStep('Expect "toHaveURL"')).toBe('Checked the page address');
    });

    const outcome: TestOutcome = {
        id: 'SHOP-1',
        title: 'SHOP-1 user can sign in',
        file: 'tests/login.spec.ts',
        line: 4,
        project: 'chromium',
        status: 'failed',
        runs: 1,
        passes: 0,
        durationMs: 5200,
        error: ERROR,
        category: 'locator',
        attachments: [{ name: 'trace', path: 'test-results/login/trace.zip' }]
    };

    it('tells a locator story when the button was renamed', () => {
        const story = buildStory(outcome, readTrace(traceZip('/repo'), '/repo'), snapshotFromErrorContext(ERROR_CONTEXT));
        expect(story.category).toBe('locator');
        expect(story.story).toContain("Clicked the button 'Sign in' (failed here after waiting 5.0 s)");
        expect(story.story).toContain("the button 'Log in'");
        expect(story.story).toContain("The button is now called 'Log in' instead of 'Sign in'.");
        expect(story.story).toContain('npx playwright show-trace test-results/login/trace.zip');
    });

    it('blames the server, not the locator, when the API answered 500', () => {
        const story = buildStory(outcome, readTrace(traceZip('/repo', { status: 500 }), '/repo'), snapshotFromErrorContext(ERROR_CONTEXT));
        expect(story.category).toBe('app-bug');
        expect(story.story).toContain('HTTP 500 for GET localhost:4599/api/stats');
    });
});

describe('flaky history', () => {
    it('computes pass rate, flips and a score', () => {
        const run = (at: string, tests: Array<[string, TestOutcome['status'], number, number]>): RunSummary => ({
            startedAt: at,
            finishedAt: at,
            command: '',
            exitCode: 0,
            repeat: 1,
            stats: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0 },
            byCategory: {},
            tests: tests.map(([id, status, runs, passes]) => ({ id, title: `${id} t`, file: 'tests/a.spec.ts', status, runs, passes, durationMs: 1, attachments: [] }))
        });
        const stats = flakyStats([
            run('2026-10-01T00:00:00Z', [['A-1', 'passed', 1, 1], ['A-2', 'passed', 1, 1], ['A-3', 'flaky', 4, 2]]),
            run('2026-10-02T00:00:00Z', [['A-1', 'failed', 1, 0], ['A-2', 'passed', 1, 1]]),
            run('2026-10-03T00:00:00Z', [['A-1', 'passed', 1, 1], ['A-2', 'passed', 1, 1]])
        ]);
        const by = Object.fromEntries(stats.map(s => [s.id, s]));
        expect(by['A-1']).toMatchObject({ runs: 3, passes: 2, flips: 2, recent: 'PFP', flaky: true });
        expect(by['A-2']).toMatchObject({ flaky: false, score: 0 });
        expect(by['A-3']).toMatchObject({ flaky: true, recent: '~', passRate: 0.5 });
        expect(by['A-3'].score).toBeGreaterThan(by['A-2'].score);
    });
});

// ---- the tool, end to end without a browser ---------------------------------------------

const CONFIG = (language = 'typescript', framework = 'playwright') => `schemaVersion: 1\nproject:\n  testRoot: .\nappType: web\nstack:\n  framework: ${framework}\n  language: ${language}\napp:\n  kind: url\n  ref: http://localhost:4599\n`;
const PAGE = `import type { Page } from '@playwright/test';

export class LoginPage {
    constructor(private readonly page: Page) {}
    readonly path = '/';
    get signIn() { return this.page.getByRole("button", { name: "Sign in" }); }
}
`;
const SPEC = `import { test } from '@playwright/test';

test('SHOP-1 user can sign in', async ({ page }) => {});
test('SHOP-2 products open', async ({ page }) => {});
`;

function project(language = 'typescript', framework = 'playwright'): string {
    return tempRepo({
        '.testpilot/config.yaml': CONFIG(language, framework),
        'src/pages/LoginPage.ts': PAGE,
        'tests/login.spec.ts': SPEC,
        'node_modules/@playwright/test/package.json': JSON.stringify({ name: '@playwright/test', version: '1.56.1' }),
        'test-results/login/error-context.md': ERROR_CONTEXT
    });
}

function saveRun(root: string, tests: TestOutcome[], at = '2026-10-12T09:00:00.000Z'): void {
    const run: RunSummary = { startedAt: at, finishedAt: at, command: 'npx playwright test', exitCode: 1, repeat: 1, stats: { total: tests.length, passed: 0, failed: 1, flaky: 0, skipped: 0, durationMs: 1 }, tests, byCategory: {} };
    mkdirSync(path.join(root, '.testpilot/runs'), { recursive: true });
    writeFileSync(path.join(root, '.testpilot/runs/latest.json'), JSON.stringify(run));
    writeFileSync(path.join(root, `.testpilot/runs/${at.replace(/[-:]/g, '').replace(/\..+$/, '')}.json`), JSON.stringify(run));
}

function failedSignIn(root: string, extra: Partial<TestOutcome> = {}): TestOutcome {
    writeFileSync(path.join(root, 'test-results/login/trace.zip'), traceZip(root));
    return {
        id: 'SHOP-1',
        title: 'SHOP-1 user can sign in',
        file: 'tests/login.spec.ts',
        line: 3,
        project: 'chromium',
        status: 'failed',
        runs: 1,
        passes: 0,
        durationMs: 5200,
        error: ERROR,
        category: 'locator',
        attachments: [
            { name: 'error-context', path: 'test-results/login/error-context.md' },
            { name: 'trace', path: 'test-results/login/trace.zip' }
        ],
        ...extra
    };
}

/** A fake Playwright: writes a JSON report where SHOP-1 has the given status. */
function fakePlaywright(status: 'passed' | 'failed', calls: string[][] = []) {
    return async (cwd: string, argv: string[]) => {
        calls.push(argv);
        const report = {
            config: { rootDir: path.join(cwd, 'tests') },
            suites: [
                {
                    title: 'login.spec.ts',
                    file: 'login.spec.ts',
                    specs: [{ title: 'SHOP-1 user can sign in', file: 'login.spec.ts', line: 3, tests: [{ projectName: 'chromium', status: status === 'passed' ? 'expected' : 'unexpected', results: [{ status, duration: 10, ...(status === 'failed' ? { error: { message: ERROR } } : {}) }] }] }]
                }
            ]
        };
        mkdirSync(path.join(cwd, 'test-results'), { recursive: true });
        writeFileSync(path.join(cwd, 'test-results/results.json'), JSON.stringify(report));
        return { command: argv.join(' '), ok: status === 'passed', exitCode: status === 'passed' ? 0 : 1, tail: '' };
    };
}

describe('heal_tests tool', () => {
    const original = { ...healRuntime };
    afterEach(() => Object.assign(healRuntime, original));

    it('proposes, applies after approval, re-runs only the affected test and keeps the fix', async () => {
        const root = project();
        saveRun(root, [failedSignIn(root), { ...failedSignIn(root), id: 'SHOP-9', title: 'SHOP-9 total is right', error: 'Error: expect(locator).toHaveText(expected) failed\nExpected: "3"\nReceived: "2"', category: 'assertion' }]);
        const c = await connect(root, 'legacy');
        const proposed = await c.call('heal_tests', { action: 'propose' });
        expect(proposed.isError).toBeFalsy();
        const [p] = proposed.structuredContent.proposals;
        expect(p).toMatchObject({ oldLocator: "getByRole('button', { name: 'Sign in' })", newLocator: "getByRole('button', { name: 'Log in' })", pageSource: 'error-context' });
        expect(p.edits).toEqual([{ file: 'src/pages/LoginPage.ts', line: 6, endLine: 6, old: '    get signIn() { return this.page.getByRole("button", { name: "Sign in" }); }', new: '    get signIn() { return this.page.getByRole("button", { name: "Log in" }); }' }]);
        expect(p.diff).toContain('+++ b/src/pages/LoginPage.ts');
        expect(proposed.structuredContent.skipped[0]).toMatchObject({ testId: 'SHOP-9' });
        expect(proposed.structuredContent.skipped[0].reason).toMatch(/assertion failure.*real bug/);
        expect(existsSync(path.join(root, '.testpilot/heal/proposals.json'))).toBe(true);

        const calls: string[][] = [];
        healRuntime.run = fakePlaywright('passed', calls);
        const unapproved = await c.call('heal_tests', { action: 'apply', ids: [p.id] });
        expect(unapproved.isError).toBe(true);
        expect(readFileSync(path.join(root, 'src/pages/LoginPage.ts'), 'utf8')).toContain('"Sign in"');
        expect(calls).toHaveLength(0);

        const applied = await c.call('heal_tests', { action: 'apply', ids: [p.id], userApproved: true, approver: 'Sam' });
        expect(applied.isError).toBeFalsy();
        expect(applied.structuredContent.outcomes[0]).toMatchObject({ healed: true, results: [{ id: 'SHOP-1', before: 'failed', after: 'passed' }] });
        expect(calls[0]).toEqual(['npx', 'playwright', 'test', 'tests/login.spec.ts', '--grep', '(^|\\s|@)(SHOP-1)(\\s|$)', '--project', 'chromium']);
        expect(readFileSync(path.join(root, 'src/pages/LoginPage.ts'), 'utf8')).toContain('{ name: "Log in" }');
        expect(readFileSync(path.join(root, '.testpilot/decisions.md'), 'utf8')).toMatch(/Healed a locator.*\| Sam \|/);
        expect(readFileSync(path.join(root, '.testpilot/heal/history.jsonl'), 'utf8')).toContain('"result":"healed"');
        expect(readFileSync(path.join(root, '.testpilot/audit.log.jsonl'), 'utf8')).toContain('healed getByRole');
        const again = await c.call('heal_tests', { action: 'apply', ids: [p.id], userApproved: true });
        expect(again.content[0].text).toMatch(/already healed/);
        await c.close();
    });

    it('reverts the change when the test still fails', async () => {
        const root = project();
        saveRun(root, [failedSignIn(root)]);
        const c = await connect(root, 'legacy');
        const { structuredContent } = await c.call('heal_tests', { action: 'propose' });
        healRuntime.run = fakePlaywright('failed');
        const applied = await c.call('heal_tests', { action: 'apply', ids: [structuredContent.proposals[0].id], userApproved: true });
        expect(applied.structuredContent.outcomes[0].healed).toBe(false);
        expect(applied.content[0].text).toMatch(/back as they were/);
        expect(readFileSync(path.join(root, 'src/pages/LoginPage.ts'), 'utf8')).toBe(PAGE);
        expect(readFileSync(path.join(root, '.testpilot/heal/history.jsonl'), 'utf8')).toContain('"result":"reverted"');
        await c.close();
    });

    it('opens the page when Playwright saved no page state', async () => {
        const root = project();
        saveRun(root, [{ ...failedSignIn(root), attachments: [] }]);
        const urls: string[] = [];
        healRuntime.snapshot = async (_store, _cwd, url) => {
            urls.push(url);
            return { url, snapshot: '- button "Log in"\n- link "Products"', testIds: [] };
        };
        const c = await connect(root, 'legacy');
        const res = await c.call('heal_tests', { action: 'propose' });
        expect(urls).toEqual(['http://localhost:4599/']);
        expect(res.structuredContent.proposals[0]).toMatchObject({ newLocator: "getByRole('button', { name: 'Log in' })", pageSource: 'live page' });
        await c.close();
    });

    it('explains failures from the trace and writes failures.md', async () => {
        const root = project();
        saveRun(root, [failedSignIn(root)]);
        const c = await connect(root, 'modern');
        const res = await c.call('heal_tests', { action: 'explain' });
        expect(res.structuredContent.stories[0]).toMatchObject({ category: 'locator', at: 'src/pages/LoginPage.ts:11', waitedMs: 5015 });
        const md = readFileSync(path.join(root, '.testpilot/reports/failures.md'), 'utf8');
        expect(md).toContain("The button is now called 'Log in' instead of 'Sign in'.");
        expect(md).toContain('GET localhost:4599/api/stats → 404');
        await c.close();
    });

    it('lists flaky tests, then quarantines and releases one after approval', async () => {
        const root = project();
        const pass: TestOutcome = { ...failedSignIn(root), status: 'passed', passes: 1, error: undefined, category: undefined, attachments: [] };
        saveRun(root, [pass], '2026-10-10T09:00:00.000Z');
        saveRun(root, [failedSignIn(root)], '2026-10-11T09:00:00.000Z');
        saveRun(root, [pass], '2026-10-12T09:00:00.000Z');
        const c = await connect(root, 'legacy');
        const flaky = await c.call('heal_tests', { action: 'flaky' });
        expect(flaky.structuredContent.runs).toBe(3);
        expect(flaky.structuredContent.flaky[0]).toMatchObject({ id: 'SHOP-1', flips: 2, recent: 'PFP' });
        expect(readFileSync(path.join(root, '.testpilot/reports/flaky.md'), 'utf8')).toContain('| SHOP-1 user can sign in [chromium] |');

        const ask = await c.call('heal_tests', { action: 'quarantine', ids: ['SHOP-1'] });
        expect(ask.isError).toBe(true);
        expect(ask.content[0].text).toContain("+test('SHOP-1 user can sign in @quarantine'");
        const done = await c.call('heal_tests', { action: 'quarantine', ids: ['SHOP-1'], reason: 'Times out on CI', userApproved: true });
        expect(done.content[0].text).toContain('--grep-invert @quarantine');
        expect(readFileSync(path.join(root, 'tests/login.spec.ts'), 'utf8')).toContain("test('SHOP-1 user can sign in @quarantine'");
        expect(JSON.parse(readFileSync(path.join(root, '.testpilot/quarantine.json'), 'utf8')).tests[0]).toMatchObject({ id: 'SHOP-1', reason: 'Times out on CI' });
        expect(readFileSync(path.join(root, '.testpilot/heal/tickets/SHOP-1.md'), 'utf8')).toMatch(/Passed 2 of 3 attempts/);

        const release = await c.call('heal_tests', { action: 'unquarantine', ids: ['SHOP-1'], userApproved: true });
        expect(release.isError).toBeFalsy();
        expect(readFileSync(path.join(root, 'tests/login.spec.ts'), 'utf8')).toBe(SPEC);
        expect(JSON.parse(readFileSync(path.join(root, '.testpilot/quarantine.json'), 'utf8')).tests).toEqual([]);
        await c.close();
    });

    it('installs Playwright agents after approval and reports new files, or says which version is needed', async () => {
        const root = project();
        const calls: string[][] = [];
        healRuntime.run = async (cwd, argv) => {
            calls.push(argv);
            mkdirSync(path.join(cwd, '.claude/agents'), { recursive: true });
            writeFileSync(path.join(cwd, '.claude/agents/playwright-test-healer.md'), '# healer');
            return { command: argv.join(' '), ok: true, exitCode: 0, tail: '' };
        };
        const c = await connect(root, 'legacy');
        expect((await c.call('heal_tests', { action: 'install-agents' })).isError).toBe(true);
        const res = await c.call('heal_tests', { action: 'install-agents', loop: 'vscode', userApproved: true });
        expect(calls).toEqual([['npx', 'playwright', 'init-agents', '--loop=vscode']]);
        expect(res.structuredContent.created).toEqual(['.claude/agents/playwright-test-healer.md']);
        writeFileSync(path.join(root, 'node_modules/@playwright/test/package.json'), JSON.stringify({ version: '1.49.0' }));
        const old = await c.call('heal_tests', { action: 'install-agents', userApproved: true });
        expect(old.content[0].text).toMatch(/need Playwright 1\.56\.0 or newer; this project has 1\.49\.0/);
        await c.close();
    });

    it('gives Java projects a friendly answer for propose but still explains', async () => {
        const root = project('java', 'selenium-java');
        saveRun(root, [failedSignIn(root)]);
        const c = await connect(root, 'legacy');
        const res = await c.call('heal_tests', { action: 'propose' });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/Selenium with Java/);
        expect((await c.call('heal_tests', { action: 'explain' })).isError).toBeFalsy();
        await c.close();
    });
});
