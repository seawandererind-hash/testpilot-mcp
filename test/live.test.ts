import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectStore } from '../src/core/store.js';
import { parseAriaSnapshot, readExploration } from '../src/explore/web.js';
import { aiNodeItems } from '../src/live/ai-case.js';
import { caseItems, matchElement, planItem } from '../src/live/auto.js';
import { resolveStepValue } from '../src/live/engine.js';
import { defaultHeaded, encodeCommand, isRiskyTarget, isSensitiveTarget, LineBuffer, locatorExpression, parseDriverLine } from '../src/live/protocol.js';
import { mergeIntoExploration, type Recording, recordingToSpec, renderLiveSection, type VerifiedElement } from '../src/live/recording.js';
import { closeAllSessions, type DriverFactory, setDriverFactory } from '../src/live/session.js';
import { connect, tempRepo } from './helpers.js';

const HOME = ['- heading "Demo Shop" [level=1]', '- text: Email', '- textbox "Email"', '- text: Password', '- textbox "Password"', '- button "Sign in"', '- link "Products":', '  - /url: /products.html'].join('\n');
const PRODUCTS = ['- heading "Products" [level=1]', '- list:', '  - listitem:', '    - text: Red shoes', '    - button "Add to cart"', '  - listitem:', '    - text: Blue hat', '    - button "Add to cart"'].join('\n');

const SECRET = 'Sup3r-Secret-Pw!';

describe('live_test command protocol', () => {
    it('encodes one command per line and reads replies, ignoring noise', () => {
        expect(encodeCommand({ id: 3, op: 'snapshot' })).toBe('{"id":3,"op":"snapshot"}\n');
        expect(parseDriverLine('__TESTPILOT__{"id":3,"ok":true,"url":"http://x.test/"}')).toEqual({ id: 3, ok: true, url: 'http://x.test/' });
        expect(parseDriverLine('(node:1) Warning: something')).toBeUndefined();
        expect(parseDriverLine('__TESTPILOT__{not json')).toBeUndefined();
        expect(parseDriverLine('__TESTPILOT__{"hello":1}')).toBeUndefined();
        expect(parseDriverLine('__TESTPILOT__{"fatal":"Playwright is not installed"}')).toMatchObject({ id: 0, ok: false, fatal: 'Playwright is not installed' });
    });

    it('splits chunks into whole lines across reads', () => {
        const buf = new LineBuffer();
        expect(buf.push('__TESTPILOT__{"id":1,')).toEqual([]);
        expect(buf.push('"ok":true}\n__TESTPILOT__{"id":2,"ok":false}\r\npartial')).toEqual(['__TESTPILOT__{"id":1,"ok":true}', '__TESTPILOT__{"id":2,"ok":false}']);
        expect(buf.push(' line\n')).toEqual(['partial line']);
    });

    it('builds locators, preferring role + name', () => {
        expect(locatorExpression({ role: 'button', name: "Bob's cart" })).toBe("getByRole('button', { name: 'Bob\\'s cart' })");
        expect(locatorExpression({ role: 'link', name: 'Home', exact: true, nth: 1 })).toBe("getByRole('link', { name: 'Home', exact: true }).nth(1)");
        expect(locatorExpression({ label: 'Email' })).toBe("getByLabel('Email')");
        expect(locatorExpression({ testId: 'cart-count' })).toBe("getByTestId('cart-count')");
        expect(locatorExpression({ css: '#x' })).toBe("locator('#x')");
        expect(() => locatorExpression({})).toThrow();
    });

    it('flags payment, order, delete and send clicks, and secret fields', () => {
        for (const name of ['Pay now', 'Place order', 'Delete account', 'Remove item', 'Send', 'Transfer funds', 'Purchase', 'Confirm order']) expect(isRiskyTarget({ role: 'button', name }), name).toBe(true);
        expect(isRiskyTarget({ testId: 'delete-user' })).toBe(true);
        for (const name of ['Sign in', 'Add to cart', 'Products', 'Resend code later', 'Next']) expect(isRiskyTarget({ role: 'button', name }), name).toBe(false);
        expect(isSensitiveTarget({ role: 'textbox', name: 'Password' })).toBe(true);
        expect(isSensitiveTarget({ label: 'Card number' })).toBe(true);
        expect(isSensitiveTarget({ role: 'textbox', name: 'Email' })).toBe(false);
    });

    it('runs headless in CI and without a display', () => {
        expect(defaultHeaded({ CI: 'true' }, 'darwin')).toBe(false);
        expect(defaultHeaded({}, 'linux')).toBe(false);
        expect(defaultHeaded({ DISPLAY: ':0' }, 'linux')).toBe(true);
        expect(defaultHeaded({}, 'win32')).toBe(true);
    });

    it('resolves .env values by key name and refuses typed secrets', () => {
        const env = { TEST_USER_PASSWORD: SECRET, TEST_USER_EMAIL: 'qa@example.com' };
        expect(resolveStepValue({ action: 'fill', target: { role: 'textbox', name: 'Password' }, valueFromEnv: 'TEST_USER_PASSWORD' }, env)).toEqual({ ok: true, value: SECRET, recorded: { kind: 'env', name: 'TEST_USER_PASSWORD' }, shown: '•••' });
        expect(resolveStepValue({ action: 'fill', target: { role: 'textbox', name: 'Email' }, valueFromEnv: 'TEST_USER_EMAIL' }, env)).toMatchObject({ ok: true, shown: '(from .env TEST_USER_EMAIL)' });
        expect(resolveStepValue({ action: 'fill', target: { role: 'textbox', name: 'Password' }, value: 'typed' }, env)).toMatchObject({ ok: false });
        expect(resolveStepValue({ action: 'fill', valueFromEnv: 'MISSING_KEY' }, env)).toMatchObject({ ok: false });
        expect(resolveStepValue({ action: 'fill', valueFromEnv: 'not a key!' }, env)).toMatchObject({ ok: false });
    });
});

const recording: Recording = {
    id: 'SHOP-1',
    caseId: 'SHOP-1',
    title: 'Login with valid credentials',
    startUrl: 'http://localhost:4599/',
    startedAt: '2026-10-13T10:00:00.000Z',
    finishedAt: '2026-10-13T10:01:00.000Z',
    headed: true,
    steps: [
        { n: 1, at: 't', page: '/', action: 'fill', target: { role: 'textbox', name: 'Email' }, locator: "getByRole('textbox', { name: 'Email' })", value: { kind: 'env', name: 'TEST_USER_EMAIL' }, result: 'ok', urlAfter: 'http://localhost:4599/', fromCase: 'Enter the email' },
        { n: 2, at: 't', page: '/', action: 'fill', target: { role: 'textbox', name: 'Password' }, locator: "getByRole('textbox', { name: 'Password' })", value: { kind: 'env', name: 'TEST_USER_PASSWORD' }, result: 'ok', urlAfter: 'http://localhost:4599/' },
        { n: 3, at: 't', page: '/', action: 'click', target: { role: 'button', name: 'Nope' }, locator: "getByRole('button', { name: 'Nope' })", result: 'error', error: 'Timeout 10000ms exceeded.\ncall log', urlAfter: 'http://localhost:4599/' },
        { n: 4, at: 't', page: '/', action: 'click', target: { role: 'button', name: 'Sign in' }, locator: "getByRole('button', { name: 'Sign in' })", result: 'ok', urlAfter: 'http://localhost:4599/products.html' },
        { n: 5, at: 't', page: '/products.html', action: 'expectVisible', target: { role: 'heading', name: 'Products' }, locator: "getByRole('heading', { name: 'Products' })", result: 'ok', urlAfter: 'http://localhost:4599/products.html' },
        { n: 6, at: 't', page: '/products.html', action: 'expectUrl', value: { kind: 'literal', value: 'products.html' }, result: 'ok', urlAfter: 'http://localhost:4599/products.html' },
        { n: 7, at: 't', page: '/products.html', action: 'expectText', value: { kind: 'literal', value: 'Red shoes' }, result: 'ok', urlAfter: 'http://localhost:4599/products.html' }
    ]
};

describe('recording to Playwright spec', () => {
    it('writes a TypeScript spec with env values, relative URLs and failed steps as comments', () => {
        const spec = recordingToSpec(recording, { language: 'typescript', baseUrl: 'http://localhost:4599' });
        expect(spec).toContain("import { test, expect } from '@playwright/test';");
        expect(spec).toContain('function fromEnv(name: string): string {');
        expect(spec).toContain("test('SHOP-1: Login with valid credentials', async ({ page }) => {");
        expect(spec).toContain("    await page.goto('/');");
        expect(spec).toContain("    // Enter the email\n    await page.getByRole('textbox', { name: 'Email' }).fill(fromEnv('TEST_USER_EMAIL'));");
        expect(spec).toContain("await page.getByRole('textbox', { name: 'Password' }).fill(fromEnv('TEST_USER_PASSWORD'));");
        expect(spec).toContain('// Step 3 (click button "Nope") failed during recording and was left out: Timeout 10000ms exceeded.');
        expect(spec).not.toContain("name: 'Nope' }).click()");
        expect(spec).toContain("await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();");
        expect(spec).toContain('await expect(page).toHaveURL(/products\\.html/);');
        expect(spec).toContain("await expect(page.getByText('Red shoes').first()).toBeVisible();");
    });

    it('writes JavaScript as CommonJS or ESM, and absolute URLs for other origins', () => {
        const cjs = recordingToSpec(recording, { language: 'javascript', module: 'commonjs', baseUrl: 'http://other.test' });
        expect(cjs).toContain("const { test, expect } = require('@playwright/test');");
        expect(cjs).toContain('function fromEnv(name) {');
        expect(cjs).not.toContain(': string');
        expect(cjs).toContain("await page.goto('http://localhost:4599/');");
        const esm = recordingToSpec(recording, { language: 'javascript', module: 'esm' });
        expect(esm.startsWith("import { test, expect } from '@playwright/test';")).toBe(true);
    });

    it('leaves out the env helper when no .env value is used', () => {
        const spec = recordingToSpec({ ...recording, caseId: undefined, title: undefined, id: 'browse', steps: [recording.steps[5]] }, { language: 'typescript' });
        expect(spec).not.toContain('fromEnv');
        expect(spec).toContain("test('browse'");
    });
});

describe('merging live captures into exploration', () => {
    it('keeps the explore_app shape, adds new pages and marks used elements verified', () => {
        const home = parseAriaSnapshot(HOME);
        const products = parseAriaSnapshot(PRODUCTS);
        const existing = {
            exploredAt: '2026-10-01T00:00:00.000Z',
            start: 'http://localhost:4599/',
            pages: [{ url: 'http://localhost:4599/', path: '/', status: 200, title: 'Demo Shop', elements: [{ role: 'link', name: 'Old link', locator: "getByRole('link', { name: 'Old link' })", count: 1 }], testIds: [], headings: ['Demo Shop'] }]
        };
        const { doc, verified, addedPages } = mergeIntoExploration(
            existing,
            [
                { url: 'http://localhost:4599/', path: '/', title: 'Demo Shop', elements: home.elements, headings: home.headings, testIds: [] },
                { url: 'http://localhost:4599/products.html', path: '/products.html', title: 'Products', elements: products.elements, headings: products.headings, testIds: [{ attr: 'data-testid', value: 'product', tag: 'li', text: 'Red shoes' }] }
            ],
            recording.steps,
            '2026-10-13T10:02:00.000Z'
        );
        expect(addedPages).toEqual(['/products.html']);
        expect(verified).toBe(4);
        expect(doc.exploredAt).toBe('2026-10-01T00:00:00.000Z');
        const homePage = doc.pages.find(p => p.path === '/')!;
        expect(homePage.elements.map(e => e.name)).toEqual(expect.arrayContaining(['Old link', 'Email', 'Password', 'Sign in']));
        const signIn = homePage.elements.find(e => e.name === 'Sign in') as VerifiedElement;
        expect(signIn).toMatchObject({ role: 'button', locator: "getByRole('button', { name: 'Sign in' })", verified: true, verifiedAt: '2026-10-13T10:02:00.000Z' });
        expect((homePage.elements.find(e => e.name === 'Old link') as VerifiedElement).verified).toBeUndefined();
        expect((doc.pages.find(p => p.path === '/products.html')!.elements.find(e => e.role === 'heading') as VerifiedElement).verified).toBe(true);
        // The original document is not changed.
        expect(existing.pages[0].elements).toHaveLength(1);

        // readExploration (used by generate_tests) reads the merged file as ordinary explored pages.
        const store = new ProjectStore(tempRepo());
        store.write('.testpilot/exploration/pages.json', JSON.stringify(doc));
        expect(readExploration(store).find(p => p.path === '/')!.elements.some(e => e.name === 'Password')).toBe(true);
    });

    it('replaces only its own README section', () => {
        const first = renderLiveSection('# App exploration\n\nExplorer notes.\n', [{ url: 'u', path: '/', status: 200, title: 'Home', elements: [{ role: 'button', name: 'Go', locator: "getByRole('button', { name: 'Go' })", count: 1, verified: true } as VerifiedElement], testIds: [], headings: [] }]);
        expect(first).toContain('Explorer notes.');
        expect(first).toContain("| button | Go | `page.getByRole('button', { name: 'Go' })` |");
        const second = renderLiveSection(first, []);
        expect(second).toContain('Explorer notes.');
        expect(second).not.toContain('| button | Go |');
        expect(second.match(/testpilot:live_test:start/g)).toHaveLength(1);
    });
});

describe('auto mode planning', () => {
    const tc = {
        id: 'SHOP-1',
        title: 'Login',
        preconditions: [],
        steps: [{ action: 'Open the application' }, { action: 'Enter the email of the standard user' }, { action: 'Enter the password' }, { action: 'Click Sign in' }],
        expected: 'Products page is displayed',
        tags: [],
        source: { type: 'csv', importedAt: 'x' }
    };

    it('maps a case onto the live page and asks for help when unsure', () => {
        const home = parseAriaSnapshot(HOME).elements;
        const items = caseItems(tc);
        const ctx = { isFirst: false, atStart: true, startUrl: 'http://localhost:4599/' };
        expect(planItem(items[0], home, ctx)).toMatchObject({ kind: 'skip' });
        expect(planItem(items[1], home, ctx)).toEqual({ kind: 'steps', steps: [{ action: 'fill', target: { role: 'textbox', name: 'Email' }, valueFromEnv: 'TEST_USER_EMAIL' }] });
        expect(planItem(items[2], home, ctx)).toEqual({ kind: 'steps', steps: [{ action: 'fill', target: { role: 'textbox', name: 'Password' }, valueFromEnv: 'TEST_USER_PASSWORD' }] });
        expect(planItem(items[3], home, ctx)).toEqual({ kind: 'steps', steps: [{ action: 'click', target: { role: 'button', name: 'Sign in' } }] });
        expect(planItem(items[4], parseAriaSnapshot(PRODUCTS).elements, ctx)).toEqual({ kind: 'steps', steps: [{ action: 'expectVisible', target: { role: 'heading', name: 'Products' } }] });
        // "Add to cart" appears twice, so auto mode does not guess which one.
        expect(matchElement('Add to cart', ['button'], parseAriaSnapshot(PRODUCTS).elements)).toBeUndefined();
        expect(planItem({ text: 'Click Add to cart', kind: 'action', intent: { kind: 'click', name: 'Add to cart' } }, parseAriaSnapshot(PRODUCTS).elements, ctx)).toMatchObject({ kind: 'help' });
        expect(planItem({ text: 'x', kind: 'action', intent: { kind: 'unknown', text: 'x' } }, home, ctx)).toMatchObject({ kind: 'help' });
    });
});

describe('plain-English AI steps without a model key', () => {
    it('matches simple steps and hands the rest to the chat AI', () => {
        expect(aiNodeItems({ gotoUrl: '/products.html' })[0].intent).toEqual({ kind: 'open', target: '/products.html', path: '/products.html' });
        expect(aiNodeItems({ aiTap: 'Sign in' })[0].intent).toMatchObject({ kind: 'click', name: 'Sign in' });
        expect(aiNodeItems({ aiInput: { prompt: 'Password', value: '${TEST_USER_PASSWORD}' } })[0].intent).toEqual({ kind: 'fill', field: 'Password', value: { kind: 'env', name: 'TEST_USER_PASSWORD' } });
        expect(aiNodeItems({ aiKeyboardPress: { keyName: 'Enter' } })[0].intent).toEqual({ kind: 'press', key: 'Enter' });
        expect(aiNodeItems({ aiAssert: 'The URL contains /products' })[0]).toMatchObject({ kind: 'check', intent: { kind: 'url' } });
        expect(aiNodeItems({ aiAct: 'Search for "mug" and add the first result to the basket' })[0].help).toContain('several actions');
        expect(aiNodeItems({ aiQuery: 'the total as a number' })[0].help).toContain('reads information');
        expect(aiNodeItems({ sleep: 1000 })[0].skip).toBeTruthy();
        expect(aiNodeItems({ launch: 'x' })[0].help).toBeTruthy();
        const home = parseAriaSnapshot(HOME).elements;
        expect(planItem(aiNodeItems({ gotoUrl: '/' })[0], home, { isFirst: true, atStart: true, startUrl: 'http://localhost:4599/' })).toMatchObject({ kind: 'skip' });
        expect(planItem(aiNodeItems({ gotoUrl: '/products.html' })[0], home, { isFirst: true, atStart: true, startUrl: 'http://localhost:4599/' })).toMatchObject({ kind: 'steps' });
    });
});

/** A pretend browser for the demo shop, so the tool can be tested without Playwright. */
function fakeDriver(log: Array<Record<string, unknown>>): DriverFactory {
    return async (_store, options) => {
        let url = options.url.replace(/\/?$/, '/');
        let alive = true;
        const view = () => ({ url, title: url.endsWith('products.html') ? 'Products' : 'Demo Shop', snapshot: url.endsWith('products.html') ? PRODUCTS : HOME, testIds: [], screenshot: path.join(options.outDir, 'shot.png') });
        return {
            ready: { id: 0, ok: true, ready: true, headed: false, headedFallback: options.headed ? 'no display' : undefined, ...view() },
            handle: {
                get alive() {
                    return alive;
                },
                async send(command) {
                    log.push(command as Record<string, unknown>);
                    if (command.op === 'step') {
                        const name = command.target?.name;
                        if (command.target && !(view().snapshot.includes(`"${name}"`))) return { id: 1, ok: false, error: `Timeout: ${name} not found (value was ${command.value})`, ...view() };
                        if (command.action === 'click' && name === 'Sign in') url = url.replace(/[^/]*$/, 'products.html');
                    }
                    return { id: 1, ok: true, ...view() };
                },
                async close() {
                    alive = false;
                },
                kill() {
                    alive = false;
                }
            }
        };
    };
}

describe('live_test tool (fake browser)', () => {
    afterEach(async () => {
        await closeAllSessions();
        setDriverFactory(undefined);
    });

    function liveRepo() {
        return tempRepo({
            '.testpilot/config.yaml': 'appType: web\nstack:\n  framework: playwright\n  language: typescript\napp:\n  kind: url\n  ref: http://localhost:4599\n',
            '.env': `TEST_USER_EMAIL=qa@example.com\nTEST_USER_PASSWORD=${SECRET}\n`,
            '.testpilot/test-cases/normalized/SHOP-1.json': JSON.stringify({ id: 'SHOP-1', title: 'Login with valid credentials', steps: [{ action: 'Open the application' }, { action: 'Enter the email of the standard user' }, { action: 'Enter the password' }, { action: 'Click Sign in' }], expected: 'Products page is displayed', source: { type: 'csv', importedAt: 'x' } })
        });
    }

    it('drives start, steps and finish, never returning the password', async () => {
        const log: Array<Record<string, unknown>> = [];
        setDriverFactory(fakeDriver(log));
        const root = liveRepo();
        const c = await connect(root, 'modern');
        const texts: string[] = [];
        const call = async (args: Record<string, unknown>) => {
            const r = await c.call('live_test', args);
            texts.push(r.content[0].text);
            return r;
        };
        try {
            expect((await call({ action: 'step', step: { action: 'click', target: { role: 'button', name: 'Sign in' } } })).isError).toBe(true);
            const start = await call({ action: 'start', name: 'login', headed: true });
            expect(start.isError).toBeFalsy();
            expect(start.content[0].text).toContain('could not open a window (no display)');
            expect(start.structuredContent.elements).toContainEqual({ role: 'textbox', name: 'Email', locator: "page.getByRole('textbox', { name: 'Email' })" });
            expect((await call({ action: 'start' })).isError).toBe(true);

            await call({ action: 'step', step: { action: 'fill', target: { role: 'textbox', name: 'Email' }, valueFromEnv: 'TEST_USER_EMAIL' } });
            const typed = await call({ action: 'step', step: { action: 'fill', target: { role: 'textbox', name: 'Password' }, value: 'nope' } });
            expect(typed.isError).toBe(true);
            const pwd = await call({ action: 'step', step: { action: 'fill', target: { role: 'textbox', name: 'Password' }, valueFromEnv: 'TEST_USER_PASSWORD' } });
            expect(pwd.content[0].text).toContain('typed •••');
            expect(log.at(-1)).toMatchObject({ op: 'step', action: 'fill', value: SECRET });
            const failed = await call({ action: 'step', step: { action: 'fill', target: { role: 'textbox', name: 'Missing' }, valueFromEnv: 'TEST_USER_PASSWORD' } });
            expect(failed.structuredContent.ok).toBe(false);
            const click = await call({ action: 'step', step: { action: 'click', target: { role: 'button', name: 'Sign in' } } });
            expect(click.structuredContent.page.url).toBe('http://localhost:4599/products.html');
            expect(click.structuredContent.changes.addedHeadings).toEqual(['Products']);
            await call({ action: 'step', step: { action: 'expectVisible', target: { role: 'heading', name: 'Products' } } });

            const risky = await call({ action: 'step', step: { action: 'click', target: { role: 'button', name: 'Delete account' } } });
            expect(risky.isError).toBe(true);
            expect(risky.content[0].text).toContain('Approval needed');
            const css = await call({ action: 'step', step: { action: 'click', target: { css: '#cart' } } });
            expect(css.content[0].text).toContain('raw CSS selector');

            const preview = await call({ action: 'finish' });
            expect(preview.isError).toBeFalsy();
            expect(preview.structuredContent.spec.path).toBe('tests/recorded/login.spec.ts');
            expect(preview.structuredContent.spec.content).toContain("fill(fromEnv('TEST_USER_PASSWORD'))");
            expect(existsSync(path.join(root, 'tests/recorded/login.spec.ts'))).toBe(false);
            const rec = JSON.parse(readFileSync(path.join(root, '.testpilot/live/recordings/login.json'), 'utf8')) as Recording;
            expect(rec.steps.map(s => s.result)).toEqual(['ok', 'ok', 'error', 'ok', 'ok', 'error']);
            expect(rec.steps[1].value).toEqual({ kind: 'env', name: 'TEST_USER_PASSWORD' });
            expect(readFileSync(path.join(root, '.testpilot/exploration/README.md'), 'utf8')).toContain('Verified in a live browser');
            expect(readFileSync(path.join(root, '.testpilot/decisions.md'), 'utf8')).toContain('Recorded login in a live browser');

            const noApproval = await call({ action: 'finish', name: 'login', confirmToken: preview.structuredContent.confirmToken });
            expect(noApproval.isError).toBe(true);
            const written = await call({ action: 'finish', name: 'login', confirmToken: preview.structuredContent.confirmToken, userApproved: true });
            expect(written.isError).toBeFalsy();
            expect(readFileSync(path.join(root, 'tests/recorded/login.spec.ts'), 'utf8')).toBe(preview.structuredContent.spec.content);
            expect((await call({ action: 'snapshot' })).isError).toBe(true);
        } finally {
            await c.close();
        }
        for (const text of texts) expect(text).not.toContain(SECRET);
        for (const file of ['.testpilot/live/recordings/login.json', '.testpilot/exploration/pages.json', '.testpilot/audit.log.jsonl']) expect(readFileSync(path.join(root, file), 'utf8')).not.toContain(SECRET);
    });

    it('performs a case by itself in auto mode', async () => {
        setDriverFactory(fakeDriver([]));
        const root = liveRepo();
        const c = await connect(root, 'legacy');
        try {
            await c.call('live_test', { action: 'start', caseId: 'SHOP-1' });
            const auto = await c.call('live_test', { action: 'auto' });
            expect(auto.isError).toBeFalsy();
            expect(auto.structuredContent.needsHelp).toBeNull();
            expect(auto.structuredContent.done.filter((d: { action?: string }) => d.action).map((d: { action: string }) => d.action)).toEqual(['fill', 'fill', 'click', 'expectVisible']);
            expect(auto.content[0].text).not.toContain(SECRET);
            const fin = await c.call('live_test', { action: 'finish' });
            expect(fin.structuredContent.spec.content).toContain('// Click Sign in');
        } finally {
            await c.close();
        }
    });

    it('carries out a plain-English AI test with no model key, then writes a normal spec', async () => {
        const log: Array<Record<string, unknown>> = [];
        setDriverFactory(fakeDriver(log));
        const root = tempRepo({
            '.testpilot/config.yaml': 'appType: web\nstack:\n  framework: playwright\n  language: typescript\napp:\n  kind: url\n  ref: http://localhost:4599\n',
            '.env': `TEST_USER_EMAIL=qa@example.com\nTEST_USER_PASSWORD=${SECRET}\n`,
            'ai-tests/cases/web/shop.yaml': [
                'cases:',
                '  - name: SHOP-9 sign in and see products',
                '    steps:',
                '      - gotoUrl: /',
                '      - aiInput: { prompt: the Email field, value: qa@example.com }',
                '      - aiAct: Fill in the password and press the sign in button',
                '      - aiWaitFor: The "Products" heading is shown',
                '      - aiQuery: Return the product names as a list',
                '      - sleep: 500',
                '  - name: SHOP-10 other',
                '    steps:',
                '      - aiAssert: something'
            ].join('\n')
        });
        const c = await connect(root, 'modern');
        try {
            const drive = await c.call('ai_tests', { action: 'drive', file: 'cases/web/shop.yaml' });
            expect(drive.isError, drive.content[0].text).toBeFalsy();
            expect(drive.content[0].text).toContain('no AI model key is needed');
            expect(drive.structuredContent.next).toEqual({ tool: 'live_test', action: 'start', aiFile: 'ai-tests/cases/web/shop.yaml', aiCase: 'SHOP-9 sign in and see products' });
            expect(drive.structuredContent.steps.map((s: { by: string }) => s.by)).toEqual(['TestPilot', 'TestPilot', 'you', 'TestPilot', 'you', 'nothing to do']);
            expect((await c.call('ai_tests', { action: 'drive', file: 'cases/web/shop.yaml', caseName: 'nope' })).content[0].text).toContain('SHOP-10 other');

            const start = await c.call('live_test', { action: 'start', aiFile: 'shop', aiCase: 'SHOP-9' });
            expect(start.isError, start.content[0].text).toBeFalsy();
            expect(start.content[0].text).toContain('you are the AI');
            const first = await c.call('live_test', { action: 'auto' });
            expect(first.structuredContent.nextItem).toBe(2);
            expect(first.content[0].text).toContain('several actions');
            expect(log.filter(l => l.op === 'step').map(l => l.action)).toEqual(['fill']);
            // The chat AI does the compound step itself.
            await c.call('live_test', { action: 'step', step: { action: 'fill', target: { role: 'textbox', name: 'Password' }, valueFromEnv: 'TEST_USER_PASSWORD' } });
            const click = await c.call('live_test', { action: 'step', image: true, step: { action: 'click', target: { role: 'button', name: 'Sign in' } } });
            expect(click.structuredContent.ok).toBe(true);
            const second = await c.call('live_test', { action: 'auto', startAt: 3 });
            expect(second.structuredContent.nextItem).toBe(4);
            expect(second.content[0].text).toContain('reads information off the screen');
            const last = await c.call('live_test', { action: 'auto', startAt: 5 });
            expect(last.structuredContent.needsHelp).toBeNull();
            const preview = await c.call('live_test', { action: 'finish' });
            expect(preview.structuredContent.spec.path).toBe('tests/recorded/shop-9-sign-in-and-see-products.spec.ts');
            const spec = preview.structuredContent.spec.content as string;
            expect(spec).toContain('SHOP-9 sign in and see products');
            expect(spec).toContain("fill(fromEnv('TEST_USER_PASSWORD'))");
            expect(spec).toContain("getByText('Products')");
            expect(spec).not.toContain(SECRET);
        } finally {
            await c.close();
        }
    });

    it('points mobile apps to explore_app and Java projects to generate_tests', async () => {
        setDriverFactory(fakeDriver([]));
        const mobile = tempRepo({ '.testpilot/config.yaml': 'appType: android\n' });
        const c = await connect(mobile, 'modern');
        try {
            const res = await c.call('live_test', { action: 'start' });
            expect(res.content[0].text).toContain('explore_app');
            expect(res.structuredContent.started).toBe(false);
        } finally {
            await c.close();
        }
        const java = tempRepo({ '.testpilot/config.yaml': 'appType: web\nstack:\n  framework: selenium\n  language: java\napp:\n  kind: url\n  ref: http://localhost:4599\n' });
        const j = await connect(java, 'modern');
        try {
            await j.call('live_test', { action: 'start', name: 'java-login' });
            await j.call('live_test', { action: 'step', step: { action: 'click', target: { role: 'button', name: 'Sign in' } } });
            const fin = await j.call('live_test', { action: 'finish' });
            expect(fin.structuredContent.spec).toBeNull();
            expect(fin.content[0].text).toContain('generate_tests will use the verified locators');
        } finally {
            await j.close();
        }
    });

    it('refuses production-looking addresses unless allowed', async () => {
        setDriverFactory(fakeDriver([]));
        const root = tempRepo({ '.testpilot/config.yaml': 'appType: web\n' });
        const c = await connect(root, 'modern');
        try {
            const res = await c.call('live_test', { action: 'start', url: 'https://www.shop.com/' });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('does not look like a test environment');
        } finally {
            await c.close();
        }
    });
});

/**
 * Real browser, real demo site. Run with TESTPILOT_E2E=1 and TESTPILOT_E2E_PW_DIR set to a folder
 * whose node_modules has @playwright/test (and a browser installed for it).
 */
describe.skipIf(!process.env.TESTPILOT_E2E)('live_test in a real browser', () => {
    let http: Server | undefined;
    afterEach(async () => {
        await closeAllSessions();
        http?.close();
    });

    it('records a login on the demo shop and the recorded spec passes', async () => {
        const site = path.resolve('examples/demo-shop/site');
        http = createHttpServer((req, res) => {
            const file = path.join(site, req.url === '/' ? 'index.html' : (req.url ?? '').split('?')[0]);
            if (!file.startsWith(site) || !existsSync(file)) return void res.writeHead(404).end();
            res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(file));
        });
        await new Promise<void>(r => http!.listen(0, '127.0.0.1', r));
        const port = (http.address() as { port: number }).port;
        const base = `http://127.0.0.1:${port}`;
        const root = tempRepo({
            '.testpilot/config.yaml': `appType: web\nstack:\n  framework: playwright\n  language: typescript\napp:\n  kind: url\n  ref: ${base}\n`,
            '.env': `TEST_USER_EMAIL=qa@example.com\nTEST_USER_PASSWORD=${SECRET}\n`,
            'playwright.config.ts': `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', reporter: 'list', use: { baseURL: '${base}' } });\n`
        });
        symlinkSync(path.join(path.resolve(process.env.TESTPILOT_E2E_PW_DIR ?? '.'), 'node_modules'), path.join(root, 'node_modules'), 'dir');
        const c = await connect(root, 'modern');
        try {
            const start = await c.call('live_test', { action: 'start', headed: false });
            expect(start.isError, start.content[0].text).toBeFalsy();
            const steps = [
                { action: 'fill', target: { role: 'textbox', name: 'Email' }, valueFromEnv: 'TEST_USER_EMAIL' },
                { action: 'fill', target: { role: 'textbox', name: 'Password' }, valueFromEnv: 'TEST_USER_PASSWORD' },
                { action: 'click', target: { role: 'button', name: 'Sign in' } },
                { action: 'expectVisible', target: { role: 'heading', name: 'Products' } }
            ];
            for (const step of steps) {
                const res = await c.call('live_test', { action: 'step', step });
                expect(res.structuredContent?.ok, res.content[0].text).toBe(true);
                expect(res.content[0].text).not.toContain(SECRET);
            }
            const preview = await c.call('live_test', { action: 'finish', name: 'login' });
            const written = await c.call('live_test', { action: 'finish', name: 'login', confirmToken: preview.structuredContent.confirmToken, userApproved: true });
            expect(written.isError, written.content[0].text).toBeFalsy();
        } finally {
            await c.close();
        }
        mkdirSync(path.join(root, 'test-results'), { recursive: true });
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'e2e', version: '1.0.0' }));
        // Async on purpose: the demo site is served from this process.
        const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
            const child = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test'], { cwd: root, env: { ...process.env, TEST_USER_EMAIL: 'qa@example.com', TEST_USER_PASSWORD: SECRET } });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', d => (stdout += d.toString()));
            child.stderr.on('data', d => (stderr += d.toString()));
            child.on('close', status => resolve({ status, stdout, stderr }));
        });
        expect(run.status, run.stdout + run.stderr).toBe(0);
        expect(run.stdout).toContain('1 passed');
    }, 180_000);

    it('carries out a plain-English AI test with no model key, and the saved spec passes', async () => {
        const site = path.resolve('examples/demo-shop/site');
        http = createHttpServer((req, res) => {
            const file = path.join(site, req.url === '/' ? 'index.html' : (req.url ?? '').split('?')[0]);
            if (!file.startsWith(site) || !existsSync(file)) return void res.writeHead(404).end();
            res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(file));
        });
        await new Promise<void>(r => http!.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
        const root = tempRepo({
            '.testpilot/config.yaml': `appType: web\nstack:\n  framework: playwright\n  language: typescript\napp:\n  kind: url\n  ref: ${base}\n`,
            '.env': `TEST_USER_EMAIL=qa@example.com\nTEST_USER_PASSWORD=${SECRET}\n`,
            'playwright.config.ts': `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', reporter: 'list', use: { baseURL: '${base}' } });\n`,
            'ai-tests/cases/web/login.yaml': [
                'cases:',
                '  - name: SHOP-1 sign in shows the products',
                '    steps:',
                '      - gotoUrl: /',
                '      - aiInput: { prompt: Email, value: "${TEST_USER_EMAIL}" }',
                '      - aiAct: Type the password and click Sign in',
                '      - aiAssert: The "Products" heading is shown',
                '      - aiQuery: Return how many Add to cart buttons there are, as a number'
            ].join('\n')
        });
        symlinkSync(path.join(path.resolve(process.env.TESTPILOT_E2E_PW_DIR ?? '.'), 'node_modules'), path.join(root, 'node_modules'), 'dir');
        const c = await connect(root, 'modern');
        try {
            const drive = await c.call('ai_tests', { action: 'drive', file: 'login' });
            expect(drive.isError, drive.content[0].text).toBeFalsy();
            const start = await c.call('live_test', { ...drive.structuredContent.next, headed: false, image: true });
            expect(start.isError, start.content[0].text).toBeFalsy();
            expect(start.content.some(p => p.type === 'image')).toBe(true);
            const first = await c.call('live_test', { action: 'auto' });
            expect(first.structuredContent.nextItem, first.content[0].text).toBe(2);
            // Here the chat's AI works out the two actions of the compound step from the element list.
            for (const step of [
                { action: 'fill', target: { role: 'textbox', name: 'Password' }, valueFromEnv: 'TEST_USER_PASSWORD' },
                { action: 'click', target: { role: 'button', name: 'Sign in' } }
            ]) {
                const res = await c.call('live_test', { action: 'step', step });
                expect(res.structuredContent?.ok, res.content[0].text).toBe(true);
            }
            const second = await c.call('live_test', { action: 'auto', startAt: 3 });
            expect(second.structuredContent.nextItem, second.content[0].text).toBe(4);
            const look = await c.call('live_test', { action: 'snapshot', image: true });
            expect(look.structuredContent.elements.filter((e: { name: string }) => e.name === 'Add to cart')).toHaveLength(1);
            expect(look.structuredContent.elements.find((e: { name: string }) => e.name === 'Add to cart').count).toBe(2);
            const preview = await c.call('live_test', { action: 'finish' });
            expect(preview.structuredContent.spec.path).toBe('tests/recorded/shop-1-sign-in-shows-the-products.spec.ts');
            const written = await c.call('live_test', { action: 'finish', name: 'shop-1-sign-in-shows-the-products', confirmToken: preview.structuredContent.confirmToken, userApproved: true });
            expect(written.isError, written.content[0].text).toBeFalsy();
        } finally {
            await c.close();
        }
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'e2e', version: '1.0.0' }));
        const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
            const child = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test'], { cwd: root, env: { ...process.env, TEST_USER_EMAIL: 'qa@example.com', TEST_USER_PASSWORD: SECRET } });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', d => (stdout += d.toString()));
            child.stderr.on('data', d => (stderr += d.toString()));
            child.on('close', status => resolve({ status, stdout, stderr }));
        });
        expect(run.status, run.stdout + run.stderr).toBe(0);
        expect(run.stdout).toContain('1 passed');
        expect(readFileSync(path.join(root, 'tests/recorded/shop-1-sign-in-shows-the-products.spec.ts'), 'utf8')).not.toContain(SECRET);
    }, 180_000);
});
