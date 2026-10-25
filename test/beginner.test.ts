import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { answerStep, closestOption } from '../src/core/wizard.js';
import { ProjectStore } from '../src/core/store.js';
import { detectRepo } from '../src/core/detect.js';
import { classifyAppRef } from '../src/core/app-target.js';
import { APP_TYPE_OPTIONS } from '../src/catalog/frameworks.js';
import { DEMO_SITE } from '../src/demo/assets.js';
import { startDemoServer, stopDemoServer } from '../src/demo/server.js';
import type { ExploredPage } from '../src/explore/web.js';
import { parseAction, parseCheck } from '../src/generate/intents.js';
import { buildHealthReport, renderHealthMarkdown, starterCases, starterCasesCsv } from '../src/health/check.js';
import { lookupTerm } from '../src/knowledge/glossary.js';
import { compareReports } from '../src/tools/quickstart.js';
import { connect, tempRepo } from './helpers.js';

function page(p: Partial<ExploredPage> & { path: string }): ExploredPage {
    return { url: `http://localhost:4000${p.path}`, status: 200, title: '', elements: [], testIds: [], headings: [], ...p };
}

describe('plain-language wizard answers', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('takes "not sure", everyday words and small typos, and explains each step in plain words', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;

        const first = await c.call('wizard', { action: 'next' });
        expect(first.content[0].text).toMatch(/In plain words/);
        expect(first.content[0].text).toMatch(/not sure/);

        const app = await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'website' });
        expect(app.isError).toBeFalsy();
        expect(app.structuredContent.saved).toMatch(/Web app/);

        const fw = await c.call('wizard', { action: 'answer', step: 'FRAMEWORK', answer: 'playright' });
        expect(fw.structuredContent.saved).toBe('Framework: Playwright');

        const lang = await c.call('wizard', { action: 'answer', step: 'LANGUAGE', answer: 'I don\'t know' });
        expect(lang.structuredContent.saved).toMatch(/TypeScript/);

        const pattern = await c.call('wizard', { action: 'answer', step: 'PATTERN', answer: 'you choose' });
        expect(pattern.structuredContent.saved).toMatch(/Page Object Model/);

        const source = await c.call('wizard', { action: 'answer', step: 'TEST_CASE_SOURCE', answer: 'I don\'t have any' });
        expect(source.structuredContent.saved).toMatch(/None yet/);

        const reports = await c.call('wizard', { action: 'answer', step: 'REPORTING', answer: 'not sure' });
        expect(reports.structuredContent.saved).toBe('Reports: html, junit');

        const wrong = await c.call('wizard', { action: 'answer', step: 'FRAMEWORK', answer: 'xyzzy-runner' });
        expect(wrong.isError).toBeFalsy(); // free text is still allowed for frameworks TestPilot does not know
    });

    it('stops an app file being given for a web app, and adds https:// to a bare address', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'web' });

        const apk = await c.call('wizard', { action: 'answer', step: 'APP_UNDER_TEST', answer: 'builds/shop.apk' });
        expect(apk.isError).toBe(true);
        expect(apk.content[0].text).toMatch(/Android app file.*go back and change the app type/s);

        const bare = await c.call('wizard', { action: 'answer', step: 'APP_UNDER_TEST', answer: 'staging.example.com/shop' });
        expect(bare.isError).toBeFalsy();
        expect(readFileSync(path.join(root, '.testpilot/config.yaml'), 'utf8')).toContain('https://staging.example.com/shop');

        await c.call('wizard', { action: 'back', step: 'APP_TYPE' });
        await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'android phone' });
        const url = await c.call('wizard', { action: 'answer', step: 'APP_UNDER_TEST', answer: 'https://staging.example.com' });
        expect(url.isError).toBe(true);
        expect(url.content[0].text).toMatch(/website address, but the app type is a phone app/);
    });

    it('matches typos only when one option is clearly meant', () => {
        expect(closestOption('androd', APP_TYPE_OPTIONS)).toBe('android');
        expect(closestOption('zzz', APP_TYPE_OPTIONS)).toBeUndefined();
        expect(classifyAppRef('localhost:3000', 'web')).toMatchObject({ kind: 'url', ref: 'http://localhost:3000' });
        expect(classifyAppRef('com.example.shop', 'android').kind).toBe('package-id');
    });
});

describe('explain_testing', () => {
    it('explains testing words in plain language', async () => {
        expect(lookupTerm('what is a flaky test?')?.term).toBe('Flaky test');
        expect(lookupTerm('POM')?.term).toBe('Page Object Model');
        expect(lookupTerm('CI')?.term).toBe('CI (continuous integration)');
        const root = tempRepo();
        const c = await connect(root, 'modern');
        const res = await c.call('explain_testing', { term: 'staging' });
        expect(res.content[0].text).toMatch(/private copy of the app/);
        const all = await c.call('explain_testing', {});
        expect(all.structuredContent.terms.length).toBeGreaterThan(20);
        await c.close();
    });
});

describe('health check', () => {
    it('turns a walk through the app into plain findings', () => {
        const pages = [
            page({
                path: '/',
                title: 'Shop',
                loadMs: 4200,
                consoleErrors: ['Failed to load resource: the server responded with a status of 404', 'Uncaught warning X'],
                failedRequests: [{ url: 'http://localhost:4000/api/cart', status: 500 }, { url: 'http://localhost:4000/logo.png', status: 404 }],
                brokenImages: ['http://localhost:4000/logo.png'],
                imagesWithoutAlt: 2,
                phoneOverflow: true,
                links: [{ href: 'http://localhost:4000/old', text: 'Old offers' }]
            }),
            page({ path: '/old', status: 404, foundOn: 'http://localhost:4000/' }),
            page({ path: '/about', title: '', pageErrors: ['TypeError: x is undefined'] })
        ];
        const report = buildHealthReport(pages, [{ url: 'http://localhost:4000/gone', status: 404, foundOn: 'http://localhost:4000/about' }], 'http://localhost:4000');
        const titles = report.findings.map(f => f.title);
        expect(titles).toEqual(expect.arrayContaining(['2 links lead nowhere', 'Programming errors on 1 page', '1 background request failed', 'Broken images on 1 page', '1 slow page', 'Too wide for a phone on 1 page', 'Images without a text description', '1 page without a title']));
        // The missing logo is reported once (as a broken image), and the browser's copy of the 404 is not repeated.
        expect(titles.some(t => /file the pages ask for/.test(t))).toBe(false);
        expect(report.findings.find(f => /Error messages in the browser/.test(f.title))?.where[0]).toMatch(/Uncaught warning X/);
        expect(report.verdict).toMatch(/Found 3 problems to fix/);
        const md = renderHealthMarkdown(report);
        expect(md).toMatch(/## Problems to fix/);
        expect(md).toMatch(/What it means/);
        expect(md).toMatch(/linked from \/about/);
    });

    it('says what got fixed and what is new since last time', () => {
        const before = buildHealthReport([page({ path: '/', title: 'A', phoneOverflow: true })], [{ url: 'http://localhost:4000/x', status: 404, foundOn: 'http://localhost:4000/' }], 's');
        const after = buildHealthReport([page({ path: '/', title: 'A', loadMs: 5000 })], [{ url: 'http://localhost:4000/x', status: 404, foundOn: 'http://localhost:4000/' }], 's');
        const diff = compareReports(before, after);
        expect(diff.fixed.join()).toMatch(/Too wide/);
        expect(diff.fresh.join()).toMatch(/slow page/);
        expect(diff.fresh.join()).not.toMatch(/links? lead/);
    });

    it('drafts starter tests that the test writer can translate completely', () => {
        const pages = [
            page({
                path: '/',
                title: 'Demo Shop',
                elements: [{ role: 'link', name: 'Products', locator: '', count: 1 }, { role: 'link', name: 'Help', locator: '', count: 2 }],
                links: [{ href: 'http://localhost:4000/products', text: 'Products' }, { href: 'http://localhost:4000/help', text: 'Help' }]
            }),
            page({ path: '/products', title: 'Products', elements: [{ role: 'heading', name: 'All products', locator: '', count: 1 }] }),
            page({ path: '/help', title: 'Bob\'s help', elements: [{ role: 'heading', name: 'Help centre', locator: '', count: 1 }] }),
            page({ path: '/broken', status: 500 })
        ];
        const cases = starterCases(pages);
        expect(cases.map(c => c.title)).toEqual(['Demo Shop page opens', 'Products page opens', 'Bob\'s help page opens', '"Products" link opens the right page']);
        // A title with a quote mark falls back to the heading; "Help" is on the page twice, so it gets no link test.
        expect(cases[2].expected).toBe('Help centre page is displayed');
        for (const c of cases) {
            for (const step of c.steps) expect(parseAction(step).map(i => i.kind)).not.toContain('unknown');
            expect(parseCheck(c.expected).map(i => i.kind)).not.toContain('unknown');
        }
        expect(starterCasesCsv(cases)).toContain('"1. Open /\n2. Click Products link"');
    });
});

describe('test_my_app', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    // Windows takes a few seconds to report a refused connection, so this test gets more than the default 5 s.
    it('asks for an address, refuses the live site, hands apps to the wizard and asks before writing', { timeout: 60_000 }, async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;

        const none = await c.call('test_my_app', {});
        expect(none.isError).toBe(true);
        // No address from the user: a general request, so the wizard asks what kind of app it is first.
        expect(none.content[0].text).toMatch(/do not ask for it here.*wizard.*what kind of app/s);
        expect(existsSync(path.join(root, '.testpilot/config.yaml'))).toBe(false);

        const prod = await c.call('test_my_app', { url: 'https://www.mybank.com' });
        expect(prod.isError).toBe(true);
        expect(prod.content[0].text).toMatch(/live site/);

        const apk = await c.call('test_my_app', { url: 'C:\\Users\\me\\shop.apk' });
        expect(apk.isError).toBe(true);
        expect(apk.content[0].text).toMatch(/Android app, not a website.*wizard/s);

        const down = await c.call('test_my_app', { url: 'http://127.0.0.1:9' });
        expect(down.isError).toBe(true);
        expect(down.content[0].text).toMatch(/could not open/);

        const site = path.join(root, 'site');
        mkdirSync(site, { recursive: true });
        for (const [name, content] of Object.entries(DEMO_SITE)) writeFileSync(path.join(site, name), content);
        const shop = await startDemoServer(site, 4760);
        try {
            const ask = await c.call('test_my_app', { url: shop.url });
            expect(ask.isError).toBe(true);
            expect(ask.content[0].text).toMatch(/Approval needed.*Set up testing for/s);
            expect(ask.content[0].text).toMatch(/recommended setup: Web.*Playwright.*TypeScript.*choose .* yourself/s);
            expect(existsSync(path.join(root, 'playwright.config.ts'))).toBe(false);
            // Nothing is saved before the yes, so the wizard still asks the kind of app first.
            expect(existsSync(path.join(root, '.testpilot/config.yaml'))).toBe(false);
            expect(existsSync(path.join(root, '.env.example'))).toBe(false);
            const before = await c.call('testpilot_status');
            expect(before.structuredContent.nextStep.step).toBe('APP_TYPE');
            expect(before.content[0].text).toMatch(/first question is what kind of app/);
        } finally {
            await stopDemoServer(site);
        }
    });

    it('keeps the earlier setup when the quick start is declined', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'web' });
        const configBefore = readFileSync(path.join(root, '.testpilot/config.yaml'), 'utf8');
        const stateBefore = readFileSync(path.join(root, '.testpilot/state.json'), 'utf8');
        const site = path.join(root, 'site');
        mkdirSync(site, { recursive: true });
        for (const [name, content] of Object.entries(DEMO_SITE)) writeFileSync(path.join(site, name), content);
        const shop = await startDemoServer(site, 4761);
        try {
            const ask = await c.call('test_my_app', { url: shop.url });
            expect(ask.content[0].text).toMatch(/Approval needed/);
            expect(readFileSync(path.join(root, '.testpilot/config.yaml'), 'utf8')).toBe(configBefore);
            expect(readFileSync(path.join(root, '.testpilot/state.json'), 'utf8')).toBe(stateBefore);
            const status = await c.call('testpilot_status');
            expect(status.structuredContent.nextStep.step).toBe('FRAMEWORK');
        } finally {
            await stopDemoServer(site);
        }
    });

    it('says when the quick start picked the setup, and how to choose again', async () => {
        const root = tempRepo();
        const store = new ProjectStore(root);
        const detection = detectRepo(root);
        for (const [step, answer] of [['APP_TYPE', 'web'], ['FRAMEWORK', 'playwright'], ['LANGUAGE', 'typescript']] as const) answerStep(store, detection, step, answer, 'testpilot (quick start)');
        const c = await connect(root, 'legacy');
        close = c.close;
        const status = await c.call('testpilot_status');
        expect(status.content[0].text).toMatch(/quick start chose these for the user without asking: Web.*Playwright.*TypeScript.*"back" and step "APP_TYPE"/s);
        await c.call('wizard', { action: 'back', step: 'APP_TYPE' });
        await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'android' });
        const after = await c.call('testpilot_status');
        expect(after.content[0].text).not.toMatch(/quick start chose/);
    });

    it('refuses on a folder set up for a phone app', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'android' });
        const res = await c.call('test_my_app', { url: 'https://staging.example.com' });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/already set up for a android app/);
    });
});

/**
 * The whole quick start in a real browser: install, health check, starter tests, generate, run twice.
 * Needs network for npm install. Run with TESTPILOT_E2E=1 (and PLAYWRIGHT_BROWSERS_PATH where browsers are pre-installed).
 */
describe.skipIf(!process.env.TESTPILOT_E2E)('test_my_app in a real browser', () => {
    it('finds the broken link and image, writes starter tests and runs them green twice', { timeout: 600_000 }, async () => {
        const root = tempRepo();
        const site = path.join(root, '..', `${path.basename(root)}-site`);
        mkdirSync(site, { recursive: true });
        for (const [name, content] of Object.entries(DEMO_SITE)) writeFileSync(path.join(site, name), content);
        writeFileSync(path.join(site, 'index.html'), readFileSync(path.join(site, 'index.html'), 'utf8').replace('</body>', '<a href="/old-offers.html">Old offers</a><img src="/missing.png"></body>'));
        const shop = await startDemoServer(site, 4770);
        const c = await connect(root, 'legacy');
        try {
            const start = await c.call('test_my_app', { url: shop.url, userApproved: true, approver: 'e2e' });
            expect(start.isError, start.content[0].text).toBeFalsy();
            expect(start.content[0].text).toMatch(/1 link leads nowhere/);
            expect(start.content[0].text).toMatch(/Broken images/);
            expect(readFileSync(path.join(root, 'test-cases/starter-tests.csv'), 'utf8')).toContain('START-1');
            const made = await c.call('test_my_app', { action: 'make-tests', userApproved: true });
            expect(made.isError, made.content[0].text).toBeFalsy();
            expect(made.structuredContent.run.stats.failed).toBe(0);
            expect(made.structuredContent.run.stats.passed).toBeGreaterThanOrEqual(3);
            const again = await c.call('test_my_app', { action: 'check' });
            expect(again.content[0].text).toMatch(/0 fixed, 0 new/);
        } finally {
            await c.close();
            await stopDemoServer(site);
        }
    });
});
