import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectStore } from '../src/core/store.js';
import { RULE_EXPLANATIONS } from '../src/quality/a11y-rules.js';
import { type AxePageResult, renderA11yHtml, renderA11yMarkdown, renderA11ySpec, summarise, tagsFor, toA11yPage, wcagCriteria } from '../src/quality/accessibility.js';
import { classifySelector, type Exec, parseMavenOutput, parseTscOutput, runGate, scanSource } from '../src/quality/gate.js';
import { findJavaTests, findJsTests } from '../src/quality/source.js';
import { dynamicTextKind, planPages, renderVisualHtml, renderVisualSpec, snapshotName } from '../src/quality/visual.js';
import { connect, tempRepo } from './helpers.js';

const status = (checks: Array<{ id: string; status: string }>, id: string) => checks.find(c => c.id === id)?.status;

const TS_BAD = `import { expect, test } from '@playwright/test';

test('login', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Password').fill('Hunter2Secret');
    await page.waitForTimeout(3000);
    await page.locator('div.css-1x2y3z > span').click();
    expect(true).toBeTruthy();
});

test('empty', async () => {});

test('commented', async ({ page }) => {
    await page.goto('/x');
    // await expect(page.getByText('Done')).toBeVisible();
});

test.only('focused', async ({ page }) => {
    await expect(page).toHaveURL(/x/);
});

test.skip('later', async ({ page }) => {
    await expect(page).toHaveTitle('x');
});

test.fixme('TC-9 untranslated', async ({ page }) => {
    // TODO(testpilot): click the thing
});
`;

const TS_GOOD = `import { expect, test } from '../../src/fixtures/test';

test('SHOP-1 Login', { tag: ['@SHOP-1'] }, async ({ page, loginPage }) => {
    await loginPage.open();
    await page.getByLabel('Password').fill(requireEnv('TEST_USER_PASSWORD'));
    await page.getByLabel('Password').fill('wrong-one');
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
});

test('SMOKE-1 home', async ({ homePage }) => {
    await homePage.expectVisible();
});
`;

const JS_SAMPLE = `const { test, expect } = require('@playwright/test');

it('waits', async () => {
    await new Promise(r => setTimeout(r, 500));
    await page.click('//button[2]');
    const apiKey = 'abcd1234efgh';
});
test('ok', async ({ page }) => {
    test.skip(process.env.CI);
    await expect(page.locator('#main section div ul li')).toHaveCount(2);
});
`;

const JAVA_SAMPLE = `package tests;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

class LoginTest {
    @Test
    void loginWorks() throws InterruptedException {
        driver.findElement(By.id("password")).sendKeys("Sup3rSecret!");
        Thread.sleep(2000);
        driver.findElement(By.xpath("/html/body/div[2]/button")).click();
        assertTrue(true);
    }

    @Test
    @Disabled
    void notYet() {
        assertEquals(1, page.count());
    }

    @Test
    void realCheck() {
        assertEquals("Products", driver.getTitle());
        // assertTrue(driver.findElement(By.id("cart")).isDisplayed());
    }
}
`;

describe('quality gate rules', () => {
    it('flags every problem in a TypeScript spec', () => {
        const out = scanSource(TS_BAD, 'ts', [{ key: 'TEST_USER_PASSWORD', value: 'Hunter2Secret' }]);
        expect(out.tests).toBe(6);
        expect(out.needsFinishing).toBe(1);
        const byId = Object.fromEntries(out.checks.map(c => [c.id, c]));
        expect(byId['no-fixed-waits']).toMatchObject({ status: 'fail', lines: [6] });
        expect(byId['no-hardcoded-values'].status).toBe('fail');
        expect(byId['no-hardcoded-values'].reason).toContain('TEST_USER_PASSWORD');
        expect(byId['no-hardcoded-values'].reason).not.toContain('Hunter2Secret');
        expect(byId['real-assertions'].status).toBe('fail');
        expect(byId['real-assertions'].reason).toContain('"login" checks a fixed value on line 8');
        expect(byId['real-assertions'].reason).toContain('"empty" (line 11) is empty');
        expect(byId['real-assertions'].reason).toContain('commented out');
        expect(byId['real-assertions'].reason).not.toContain('untranslated');
        expect(byId['no-leftovers'].status).toBe('fail');
        expect(byId['no-leftovers'].reason).toContain('.only on line 18');
        expect(byId['no-leftovers'].reason).toContain('"later" (line 22) is skipped without a reason');
        expect(byId['no-leftovers'].reason).toContain('1 test(s) marked fixme need finishing');
        expect(byId['stable-locators']).toMatchObject({ status: 'fail' });
        expect(byId['stable-locators'].reason).toContain('auto-generated class name');
    });

    it('passes a clean generated spec, including deliberate wrong passwords and helper assertions', () => {
        const out = scanSource(TS_GOOD, 'ts', [{ key: 'TEST_USER_PASSWORD', value: 'Hunter2Secret' }]);
        for (const c of out.checks) expect(c.status, `${c.id}: ${c.reason}`).toBe('pass');
    });

    it('reads JavaScript specs', () => {
        const out = scanSource(JS_SAMPLE, 'js');
        expect(out.tests).toBe(2);
        expect(status(out.checks, 'no-fixed-waits')).toBe('fail');
        expect(status(out.checks, 'no-hardcoded-values')).toBe('fail');
        expect(out.checks.find(c => c.id === 'no-hardcoded-values')!.reason).not.toContain('abcd1234efgh');
        expect(out.checks.find(c => c.id === 'real-assertions')!.reason).toContain('"waits" (line 3) has no assertion');
        expect(out.checks.find(c => c.id === 'no-leftovers')!.reason).toContain('test.skip on line 9 gives no reason');
        const locators = out.checks.find(c => c.id === 'stable-locators')!;
        expect(locators.status).toBe('fail');
        expect(locators.reason).toContain('position-based XPath');
        expect(locators.reason).toContain('long CSS chain');
    });

    it('reads JUnit tests', () => {
        const tests = findJavaTests(JAVA_SAMPLE);
        expect(tests.map(t => t.title)).toEqual(['loginWorks', 'notYet', 'realCheck']);
        expect(tests[1].disabled).toEqual({ reason: false });
        const out = scanSource(JAVA_SAMPLE, 'java');
        expect(status(out.checks, 'no-fixed-waits')).toBe('fail');
        expect(status(out.checks, 'no-hardcoded-values')).toBe('fail');
        const asserts = out.checks.find(c => c.id === 'real-assertions')!;
        expect(asserts.status).toBe('fail');
        expect(asserts.reason).toContain('"loginWorks" checks a fixed value');
        expect(asserts.reason).toContain('"realCheck" has a commented-out assertion');
        expect(out.checks.find(c => c.id === 'no-leftovers')!.reason).toContain('"notYet" (line 15) is disabled without a reason');
        expect(status(out.checks, 'stable-locators')).toBe('fail');
    });

    it('finds tests with template titles and ignores annotations inside tests', () => {
        const tests = findJsTests("for (const p of PAGES) {\n    test(`a11y: ${p}`, async ({ page }) => {\n        test.skip(!p, 'no page');\n        await expect(page).toHaveTitle('x');\n    });\n}\n");
        expect(tests).toHaveLength(1);
        expect(tests[0].title).toBe('a11y: ${p}');
    });

    it.each([
        ['//button', 'warn'],
        ['/html/body/div[3]', 'fail'],
        ['.sc-abc123 button', 'fail'],
        ['li:nth-child(2)', 'warn'],
        ['main section div ul', 'warn'],
        ['img[src*="avatar" i], img[alt*="avatar" i]', undefined],
        ['#login button', undefined]
    ])('selector %s → %s', (selector, level) => {
        expect(classifySelector(selector)?.level).toBe(level);
    });

    it('maps compiler output to files', () => {
        const tsc = parseTscOutput("tests/a.spec.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/pages/X.ts(1,1): error TS2304: Cannot find name 'y'.\n", '/repo/e2e', abs => path.relative('/repo', abs));
        expect(tsc.get('e2e/tests/a.spec.ts')).toEqual([{ line: 3, message: "TS2322: Type 'string' is not assignable to type 'number'." }]);
        expect(tsc.has('e2e/src/pages/X.ts')).toBe(true);
        const mvn = parseMavenOutput('[ERROR] /repo/src/test/java/LoginTest.java:[12,9] cannot find symbol\n', abs => path.relative('/repo', abs));
        expect(mvn.get('src/test/java/LoginTest.java')).toEqual([{ line: 12, message: 'cannot find symbol' }]);
    });
});

describe('quality gate run', () => {
    it('compiles once with an injected runner, writes the report and never prints .env values', async () => {
        const root = tempRepo({
            'tests/a.spec.ts': TS_BAD,
            'tests/b.spec.ts': TS_GOOD,
            'tsconfig.json': '{}',
            'node_modules/typescript/package.json': '{"name":"typescript"}',
            '.env': 'TEST_USER_PASSWORD=Hunter2Secret\n'
        });
        const store = new ProjectStore(root);
        const calls: string[][] = [];
        const exec: Exec = async (_cwd, argv) => {
            calls.push(argv);
            return { exitCode: 2, output: "tests/a.spec.ts(5,10): error TS2345: Argument of type 'number' is not assignable.\n" };
        };
        const out = await runGate(store, store.readConfig(), { files: ['tests/a.spec.ts', 'tests/b.spec.ts'], run: false, timeoutMs: 1000 }, exec);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(['npx', 'tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json']);
        expect(out.verdict).toBe('needs-work');
        expect(status(out.files[0].checks, 'compiles')).toBe('fail');
        expect(out.files[1].verdict).toBe('pass');
        const report = store.read('.testpilot/reports/quality-gate.md')!;
        expect(report).toContain('## tests/a.spec.ts (FAIL)');
        expect(report).not.toContain('Hunter2Secret');
    });

    it('runs through the tool: node --check for JavaScript, default file discovery, read-only', async () => {
        const root = tempRepo({ 'tests/ok.spec.js': "const { test, expect } = require('@playwright/test');\ntest('x', async ({ page }) => { await expect(page).toHaveTitle('x'); });\n", 'tests/broken.spec.js': "test('x', async () => {\n  const = 1;\n});\n" });
        const c = await connect(root, 'modern');
        try {
            const res = await c.call('quality_scan', { action: 'gate' });
            expect(res.isError).toBeFalsy();
            const files = res.structuredContent.files as Array<{ file: string; checks: Array<{ id: string; status: string; reason: string }> }>;
            expect(files.map(f => f.file)).toEqual(['tests/broken.spec.js', 'tests/ok.spec.js']);
            const compile = files[0].checks.find(x => x.id === 'compiles')!;
            expect(compile.status).toBe('fail');
            expect(compile.reason).toContain('SyntaxError');
            expect(files[1].checks.find(x => x.id === 'compiles')!.status).toBe('pass');
            expect(res.structuredContent.reportFile).toBe('.testpilot/reports/quality-gate.md');
        } finally {
            await c.close();
        }
    });
});

const FIXTURE = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures/quality/axe-products.json'), 'utf8')) as AxePageResult & { passes: unknown[]; incomplete: unknown[]; testEngine: { version: string } };
const RAW: AxePageResult = { url: FIXTURE.url, title: 'Products', status: 200, axeVersion: FIXTURE.testEngine.version, passes: FIXTURE.passes.length, incomplete: FIXTURE.incomplete.length, violations: FIXTURE.violations };

describe('accessibility', () => {
    it('explains at least the 25 most common rules', () => {
        const required = ['color-contrast', 'image-alt', 'label', 'button-name', 'link-name', 'html-has-lang', 'document-title', 'landmark-one-main', 'region', 'heading-order', 'aria-allowed-attr', 'aria-required-attr', 'aria-roles', 'aria-valid-attr-value', 'aria-hidden-focus', 'duplicate-id-aria', 'frame-title', 'list', 'listitem', 'meta-viewport', 'select-name', 'input-button-name', 'autocomplete-valid', 'target-size', 'page-has-heading-one'];
        for (const id of required) expect(RULE_EXPLANATIONS[id], id).toBeDefined();
        expect(Object.keys(RULE_EXPLANATIONS).length).toBeGreaterThanOrEqual(50);
        for (const [id, e] of Object.entries(RULE_EXPLANATIONS)) expect(`${e.title}${e.who}${e.fix}`, id).not.toMatch(/—/);
    });

    it('turns saved axe results into plain-language issues, worst first', () => {
        const page = toA11yPage(RAW);
        expect(page.path).toBe('/products.html');
        expect(page.issues.map(i => i.rule)).toEqual(['html-has-lang', 'region', 'landmark-one-main']);
        const lang = page.issues[0];
        expect(lang).toMatchObject({ impact: 'serious', title: 'Page language is not set', builtInExplanation: true, elements: 1, wcag: ['3.1.1'], bestPractice: false });
        expect(lang.fix).toContain('lang="en"');
        expect(page.issues[1]).toMatchObject({ rule: 'region', bestPractice: true, elements: 3 });
        expect(page.issues[1].examples[0]).toEqual({ selector: 'h1', html: '<h1>Products</h1>' });
    });

    it('falls back to axe help text for rules without a built-in explanation', () => {
        const page = toA11yPage({ url: 'http://localhost/x', violations: [{ id: 'made-up-rule', impact: 'critical', help: 'Things must be nice', description: 'Ensures things are nice', tags: ['wcag2a', 'wcag412'], nodes: [{ target: ['#a'], html: '<div id="a">' + 'x'.repeat(400) + '</div>' }] }] });
        expect(page.issues[0]).toMatchObject({ title: 'Things must be nice', who: 'Ensures things are nice', builtInExplanation: false, wcag: ['4.1.2'] });
        expect(page.issues[0].examples[0].html.length).toBeLessThanOrEqual(200);
    });

    it('renders readable HTML and Markdown reports', () => {
        const pages = [toA11yPage(RAW), toA11yPage({ url: 'http://localhost:4599/', title: 'Home <script>', violations: [] }), toA11yPage({ url: 'http://localhost:4599/down', error: 'net::ERR_CONNECTION_REFUSED' })];
        const meta = { level: 'AA' as const, tags: tagsFor('AA', true), scannedAt: '2026-10-13T10:00:00Z', axeVersion: '4.13.0' };
        const s = summarise(pages);
        expect(s).toMatchObject({ pages: 3, pagesWithIssues: 1, issues: 3, byImpact: { critical: 0, serious: 1, moderate: 2, minor: 0 } });
        const html = renderA11yHtml(pages, meta);
        expect(html).toContain('European Accessibility Act');
        expect(html).toContain('28 June 2025');
        expect(html).toContain('prefers-color-scheme: dark');
        expect(html).toContain('name="viewport"');
        expect(html).toContain('Page language is not set');
        expect(html).toContain('Home &lt;script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).toContain('Could not open this page');
        const md = renderA11yMarkdown(pages, meta);
        expect(md).toContain('| serious | Page language is not set | `html-has-lang` | 1 | 1 |');
        expect(md).toContain('`<html lang="en">`');
        expect(md).toContain('European Accessibility Act');
    });

    it('builds tags per level and writes a CI spec for TypeScript and CommonJS', () => {
        expect(tagsFor('AA', false)).toEqual(['wcag2a', 'wcag21a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
        expect(tagsFor('A', false)).toEqual(['wcag2a', 'wcag21a']);
        expect(wcagCriteria(['wcag2aa', 'wcag143', 'wcag1410'])).toEqual(['1.4.3', '1.4.10']);
        const ts = renderA11ySpec(['/', '/products.html'], ['wcag2a'], 'ts', true);
        expect(ts).toContain("import AxeBuilder from '@axe-core/playwright';");
        expect(ts).toContain("const PAGES = ['/', '/products.html'];");
        expect(ts).toContain("v.impact === 'serious' || v.impact === 'critical'");
        const cjs = renderA11ySpec(['/'], ['wcag2a'], 'js', false);
        expect(cjs).toContain("const AxeBuilder = require('@axe-core/playwright').default;");
        expect(scanSource(ts, 'ts').checks.every(c => c.status === 'pass')).toBe(true);
    });
});

describe('visual', () => {
    it('recognises text that changes between runs', () => {
        for (const t of ['12:45', 'Updated 9:05 pm', '2026-10-13', '13/10/2026', 'Oct 13, 2026', '3 Mar', '5 minutes ago', 'just now', 'yesterday']) expect(dynamicTextKind(t), t).toBeDefined();
        for (const t of ['Add to cart', 'Red shoes', '3 items', 'Version 2']) expect(dynamicTextKind(t), t).toBeUndefined();
    });

    it('writes mask locators with the reason for each', () => {
        const pages = planPages(
            [
                { requested: 'http://localhost:4599/', masks: [] },
                {
                    requested: 'http://localhost:4599/news?x=1',
                    title: 'News',
                    masks: [
                        { selector: 'time, [datetime]', reason: 'shows a date or time, which changes between runs', count: 2 },
                        { selector: '#clock', hasText: String.raw`\b\d{1,2}:\d{2}\b`, reason: 'its text looks like a clock time, which changes between runs', count: 1 }
                    ]
                },
                { requested: 'http://other.test/', masks: [] }
            ],
            'http://localhost:4599'
        );
        expect(pages.map(p => [p.target, p.name])).toEqual([
            ['/', 'home'],
            ['/news?x=1', 'news'],
            ['http://other.test/', 'home-2']
        ]);
        const ts = renderVisualSpec(pages, 'ts', true, { fullPage: true, maxDiffPixelRatio: 0.0001 });
        expect(ts).toContain("await expect(page).toHaveScreenshot('news.png', {");
        expect(ts).toContain("animations: 'disabled',");
        expect(ts).toContain("caret: 'hide',");
        expect(ts).toContain('maxDiffPixelRatio: 0.0001,');
        expect(ts).toContain('// shows a date or time, which changes between runs (2 on the page)');
        expect(ts).toContain("page.locator('time, [datetime]'),");
        expect(ts).toContain(String.raw`page.locator('#clock').filter({ hasText: /\b\d{1,2}:\d{2}\b/i }),`);
        expect(ts).toContain("await page.goto('http://other.test/');");
        const gate = scanSource(ts, 'ts');
        expect(gate.tests).toBe(3);
        expect(gate.checks.every(c => c.status === 'pass')).toBe(true);
        const js = renderVisualSpec(pages, 'js', false, { fullPage: false, maxDiffPixelRatio: 0.01 });
        expect(js).toContain("const { expect, test } = require('@playwright/test');");
        expect(js).toContain('fullPage: false,');
        expect(snapshotName('/Products/All.html')).toBe('products-all-html');
    });

    it('renders the side-by-side report with relative image paths', () => {
        const html = renderVisualHtml(
            [
                { name: 'home', path: '/', title: 'Demo Shop', expected: '.testpilot/reports/visual/home-expected.png', actual: '.testpilot/reports/visual/home-actual.png', diff: '.testpilot/reports/visual/home-diff.png', missingBaseline: false },
                { name: 'news', path: '/news', actual: '.testpilot/reports/visual/news-actual.png', missingBaseline: true }
            ],
            [{ path: '/products', name: 'products' }],
            { ranAt: '2026-10-13T10:00:00Z', reportFile: '.testpilot/reports/visual.html', command: 'npx playwright test tests/visual.spec.ts', notes: [] }
        );
        expect(html).toContain('src="visual/home-expected.png"');
        expect(html).toContain('src="visual/home-diff.png"');
        expect(html).toContain('No approved screenshot yet');
        expect(html).toContain('<code>/products</code>');
        expect(html).not.toContain('data:image');
    });
});

describe('quality_scan tool', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('gives a friendly message for Java projects and needs a mode for visual', async () => {
        const root = tempRepo({ '.testpilot/config.yaml': 'stack:\n  framework: selenium\n  language: java\n' });
        const c = await connect(root, 'legacy');
        close = c.close;
        const a11y = await c.call('quality_scan', { action: 'accessibility' });
        expect(a11y.isError).toBe(true);
        expect(a11y.content[0].text).toContain('axe-core\'s Selenium integration');
        const vis = await c.call('quality_scan', { action: 'visual', mode: 'setup' });
        expect(vis.content[0].text).toContain('Playwright for JavaScript or TypeScript');
    });

    it('returns the install command when axe is missing, and asks before installing', async () => {
        const root = tempRepo({ 'node_modules/@playwright/test/package.json': '{"name":"@playwright/test","main":"index.js"}', 'node_modules/@playwright/test/index.js': '', 'playwright.config.ts': '', '.env.example': 'APP_BASE_URL=http://localhost:4599\n' });
        const c = await connect(root, 'modern');
        close = c.close;
        const res = await c.call('quality_scan', { action: 'accessibility' });
        expect(res.isError).toBeFalsy();
        expect(res.structuredContent).toMatchObject({ installed: false, installCommand: 'npm i -D @axe-core/playwright' });
        const install = await c.call('quality_scan', { action: 'accessibility', install: true });
        expect(install.isError).toBe(true);
        expect(install.content[0].text).toContain('Approval needed');
    });

    it('refuses production-looking addresses and previews the CI spec before writing it', async () => {
        const root = tempRepo({ 'node_modules/@playwright/test/package.json': '{"name":"@playwright/test","main":"index.js"}', 'node_modules/@playwright/test/index.js': '', 'node_modules/@axe-core/playwright/package.json': '{"name":"@axe-core/playwright","main":"index.js"}', 'node_modules/@axe-core/playwright/index.js': '', 'playwright.config.ts': '' });
        const c = await connect(root, 'modern');
        close = c.close;
        const prod = await c.call('quality_scan', { action: 'accessibility', urls: ['https://www.example.com/'] });
        expect(prod.isError).toBe(true);
        expect(prod.content[0].text).toContain('does not look like a test environment');
        const preview = await c.call('quality_scan', { action: 'accessibility', writeSpec: true, urls: ['http://localhost:4599/', 'http://localhost:4599/cart'] });
        expect(preview.isError).toBeFalsy();
        const store = new ProjectStore(root);
        expect(store.exists('tests/accessibility.spec.ts')).toBe(false);
        const token = preview.structuredContent.confirmToken as string;
        const noApproval = await c.call('quality_scan', { action: 'accessibility', writeSpec: true, confirmToken: token });
        expect(noApproval.content[0].text).toContain('Approval needed');
        const written = await c.call('quality_scan', { action: 'accessibility', writeSpec: true, confirmToken: token, userApproved: true });
        expect(written.isError).toBeFalsy();
        expect(store.read('tests/accessibility.spec.ts')).toContain("const PAGES = ['http://localhost:4599/', 'http://localhost:4599/cart'];");
        expect(store.read('.testpilot/decisions.md')).toContain('Added accessibility checks for CI');
    });
});
