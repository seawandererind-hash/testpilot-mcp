import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { recommendStack } from '../src/catalog/frameworks.js';
import type { Config } from '../src/core/schema.js';
import { ProjectStore } from '../src/core/store.js';
import { bddSpecFor } from '../src/run/playwright.js';
import { categoriseJava, mavenArgs, parseMavenResults } from '../src/run/maven.js';
import { answerWebSetup, connect, tempRepo } from './helpers.js';

const CASES = [
    'ID,Title,Module,Priority,Preconditions,Steps,Expected Result',
    'SHOP-1,Login with valid credentials,Login,High,,"1. Open the application\n2. Enter the email of the standard user\n3. Enter the password\n4. Click Sign in",Products page is displayed',
    'SHOP-2,Add a product to the cart,Cart,High,User is logged in,"1. Click Add to cart on Red shoes",Cart count shows 1'
].join('\n');

function hasMaven(): boolean {
    try {
        execSync('mvn -v', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Wizard → scaffold → import → plan → generate wave 1, returning the files generate_tests wrote. */
async function scaffoldAndGenerate(c: Awaited<ReturnType<typeof connect>>, root: string, overrides: Record<string, string | string[]>): Promise<string[]> {
    await answerWebSetup(c, root, { TEST_CASE_SOURCE: 'csv', ...overrides });
    const scaffold = await c.call('preview_scaffold');
    const written = await c.call('scaffold_project', { confirmToken: scaffold.structuredContent.confirmToken, userApproved: true });
    if (written.isError) throw new Error(written.content[0].text);
    await c.call('import_test_cases', { location: 'cases.csv' });
    await c.call('review_test_cases');
    await c.call('automation_plan', { action: 'generate' });
    await c.call('automation_plan', { action: 'approve', userApproved: true, approver: 'Surya' });
    const preview = await c.call('preview_tests');
    const gen = await c.call('generate_tests', { confirmToken: preview.structuredContent.confirmToken, userApproved: true });
    if (gen.isError) throw new Error(gen.content[0].text);
    return gen.structuredContent.written as string[];
}

describe('the language is the user\'s choice', () => {
    it('recommends the language already in the repository, never forcing TypeScript', () => {
        expect(recommendStack('web', ['java'])).toMatchObject({ framework: 'selenium', language: 'java' });
        expect(recommendStack('web', ['javascript'])).toMatchObject({ framework: 'playwright', language: 'javascript' });
        expect(recommendStack('web', [])).toMatchObject({ framework: 'playwright', language: 'typescript' });
        expect(recommendStack('web', ['python']).reason).toContain('The choice is yours');
    });

    it('offers TypeScript, JavaScript and Java for a web app', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        try {
            await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'web' });
            const next = await c.call('wizard', { action: 'answer', step: 'FRAMEWORK', answer: 'selenium' });
            const options = next.structuredContent.next.options.map((o: { value: string }) => o.value);
            expect(options).toContain('java');
            const text = next.content[0].text;
            expect(text).toContain("your team's choice");
        } finally {
            await c.close();
        }
    });
});

describe('Playwright in JavaScript', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('scaffolds CommonJS files and generates .spec.js tests with require()', async () => {
        const root = tempRepo({ 'cases.csv': CASES });
        const c = await connect(root, 'legacy');
        close = c.close;
        const written = await scaffoldAndGenerate(c, root, { LANGUAGE: 'javascript' });
        expect(existsSync(path.join(root, 'playwright.config.js'))).toBe(true);
        expect(existsSync(path.join(root, 'playwright.config.ts'))).toBe(false);
        expect(existsSync(path.join(root, 'tsconfig.json'))).toBe(false);
        const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies['@playwright/test']).toBeDefined();
        expect(pkg.devDependencies.typescript).toBeUndefined();
        expect(pkg.scripts.test).toBe('playwright test');
        expect(written).toContain('tests/login/SHOP-1.spec.js');
        const spec = readFileSync(path.join(root, 'tests/login/SHOP-1.spec.js'), 'utf8');
        expect(spec).toContain("const { expect, test } = require('../../src/fixtures/test');");
        expect(spec).toContain("requireEnv('TEST_USER_PASSWORD')");
        expect(spec).not.toContain('import ');
        const fixtures = readFileSync(path.join(root, 'src/fixtures/test.js'), 'utf8');
        expect(fixtures).toContain("const { LoginPage } = require('../pages/LoginPage');");
        expect(fixtures).toContain('loginPage: async ({ page }, use) => {');
        expect(fixtures).not.toContain('fixture-types');
        expect(readFileSync(path.join(root, 'src/pages/LoginPage.js'), 'utf8')).toContain('module.exports = { LoginPage };');
        expect(readFileSync(path.join(root, '.agents/skills/write-playwright-test/SKILL.md'), 'utf8')).toContain("require('../../src/fixtures/test')");
    });
});

describe('Cucumber BDD with Playwright', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('writes feature files and step definitions and runs bddgen before Playwright', async () => {
        const root = tempRepo({ 'cases.csv': CASES });
        const c = await connect(root, 'legacy');
        close = c.close;
        const written = await scaffoldAndGenerate(c, root, { PATTERN: 'bdd' });
        const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies['playwright-bdd']).toBeDefined();
        expect(pkg.scripts.test).toBe('bddgen && playwright test');
        const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
        expect(config).toContain("defineBddConfig({ features: 'features/**/*.feature', steps: ['steps/**/*.ts', 'src/fixtures/test.ts']");
        expect(readFileSync(path.join(root, 'src/fixtures/test.ts'), 'utf8')).toContain("import { test as base } from 'playwright-bdd';");
        expect(existsSync(path.join(root, 'features/smoke.feature'))).toBe(true);
        expect(existsSync(path.join(root, 'tests/smoke/home.spec.ts'))).toBe(false);
        expect(written).toContain('features/login/SHOP-1.feature');
        expect(written).toContain('steps/generated.steps.ts');
        const feature = readFileSync(path.join(root, 'features/cart/SHOP-2.feature'), 'utf8');
        expect(feature).toContain('@SHOP-2 @cart @p1');
        expect(feature).toContain('Given User is logged in');
        expect(feature).toContain('Then Cart count shows 1');
        const steps = readFileSync(path.join(root, 'steps/generated.steps.ts'), 'utf8');
        expect(steps).toContain("const { Given, When, Then } = createBdd(test);");
        expect(steps).toContain("Given('User is logged in', async ({ loginPage }) => {");
        expect(steps).toContain("Then('Cart count shows 1', async ({}) => {");
        expect(steps).toContain('// TODO(testpilot): check that the Cart shows 1');
        expect(feature).toContain('@fixme');
        expect(steps).toContain('// testpilot:steps');
        expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.features-gen/');
        expect(bddSpecFor('features/login/SHOP-1.feature')).toBe('.features-gen/features/login/SHOP-1.feature.spec.js');
        expect(bddSpecFor('tests/x.spec.ts')).toBe('tests/x.spec.ts');
    });
});

describe('Selenium with Java', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('scaffolds a Maven project, generates TestNG tests and leaves package.json alone', async () => {
        const root = tempRepo({ 'cases.csv': CASES });
        const before = readFileSync(path.join(root, 'package.json'), 'utf8');
        const c = await connect(root, 'legacy');
        close = c.close;
        const written = await scaffoldAndGenerate(c, root, { FRAMEWORK: 'selenium', LANGUAGE: 'java' });
        expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(before);
        const pkgDir = 'com/demoapp/tests';
        expect(readFileSync(path.join(root, 'pom.xml'), 'utf8')).toContain('<artifactId>selenium-java</artifactId>');
        expect(existsSync(path.join(root, 'testng.xml'))).toBe(true);
        expect(existsSync(path.join(root, `src/main/java/${pkgDir}/pages/BasePage.java`))).toBe(true);
        expect(existsSync(path.join(root, `src/test/java/${pkgDir}/TestPilotListener.java`))).toBe(true);
        expect(written).toContain(`src/test/java/${pkgDir}/tests/login/SHOP_1Test.java`);
        const test = readFileSync(path.join(root, `src/test/java/${pkgDir}/tests/login/SHOP_1Test.java`), 'utf8');
        expect(test).toContain('package com.demoapp.tests.tests.login;');
        expect(test).toContain('groups = {"SHOP-1", "login", "p1"}');
        expect(test).toContain('Env.require("TEST_USER_PASSWORD")');
        expect(test).not.toContain('Thread.sleep');
        const cart = readFileSync(path.join(root, `src/test/java/${pkgDir}/tests/cart/SHOP_2Test.java`), 'utf8');
        expect(cart).toContain('loginPage.loginAs("standard");');
        expect(readFileSync(path.join(root, `src/main/java/${pkgDir}/pages/LoginPage.java`), 'utf8')).toContain('public final By');
        expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('target/');
        const skill = readFileSync(path.join(root, '.agents/skills/write-selenium-test/SKILL.md'), 'utf8');
        expect(skill).toContain('mvn test -Dgroups=');
        if (hasMaven()) {
            execSync('mvn -B -q -DskipTests test-compile', { cwd: root, stdio: 'pipe', timeout: 5 * 60_000 });
        }
    }, 6 * 60_000);

    it('generates Cucumber features and GeneratedSteps.java for the BDD pattern', async () => {
        const root = tempRepo({ 'cases.csv': CASES });
        const c = await connect(root, 'legacy');
        close = c.close;
        const written = await scaffoldAndGenerate(c, root, { FRAMEWORK: 'selenium', LANGUAGE: 'java', PATTERN: 'bdd' });
        expect(existsSync(path.join(root, 'testng.xml'))).toBe(false);
        expect(existsSync(path.join(root, 'src/test/java/com/demoapp/tests/bdd/CucumberTestRunner.java'))).toBe(true);
        expect(readFileSync(path.join(root, 'src/test/resources/cucumber.properties'), 'utf8')).toContain('not @testpilot-todo');
        expect(written).toContain('src/test/resources/features/cart/SHOP-2.feature');
        expect(written).toContain('src/test/java/com/demoapp/tests/bdd/steps/GeneratedSteps.java');
        const steps = readFileSync(path.join(root, 'src/test/java/com/demoapp/tests/bdd/steps/GeneratedSteps.java'), 'utf8');
        expect(steps).toContain('@Given("User is logged in")');
        expect(steps).toContain('@Then("Cart count shows 1")');
        expect(steps).toContain('// testpilot:steps');
        expect(readFileSync(path.join(root, 'pom.xml'), 'utf8')).toContain('cucumber-testng');
        if (hasMaven()) {
            execSync('mvn -B -q -DskipTests test-compile', { cwd: root, stdio: 'pipe', timeout: 5 * 60_000 });
        }
    }, 6 * 60_000);
});

describe('Maven runner', () => {
    const config = { stack: { pattern: 'pom' }, project: {} } as unknown as Config;

    it('selects by TestNG groups or Cucumber tags', () => {
        expect(mavenArgs({ ids: ['SHOP-1', 'SHOP-2'], tag: '@smoke', bdd: false })).toEqual(['mvn', '-B', 'test', '-Dgroups=SHOP-1,SHOP-2,smoke']);
        expect(mavenArgs({ ids: ['SHOP-1', 'SHOP-2'], tag: 'smoke', bdd: true })).toEqual(['mvn', '-B', 'test', '-Dcucumber.filter.tags=(@SHOP-1 or @SHOP-2) and @smoke']);
        expect(mavenArgs({ ids: [], bdd: true })).toEqual(['mvn', '-B', 'test']);
    });

    it('reads TestPilotListener results, marks mixed repeats as flaky and triages errors', () => {
        const root = tempRepo();
        const store = new ProjectStore(root);
        const runs = [
            [
                { title: 'SHOP-1 Login', className: 'com.demoapp.tests.tests.login.SHOP_1Test', status: 'passed' as const, durationMs: 100 },
                { title: 'SHOP-2 Cart', className: 'com.demoapp.tests.tests.cart.SHOP_2Test', status: 'failed' as const, error: 'org.openqa.selenium.NoSuchElementException: no such element: cart-count', screenshot: 'target/screenshots/SHOP_2Test.png' },
                { title: 'SHOP-3 Later', className: 'com.demoapp.tests.tests.cart.SHOP_3Test', status: 'skipped' as const, error: 'org.testng.SkipException: TODO' }
            ],
            [
                { title: 'SHOP-1 Login', className: 'com.demoapp.tests.tests.login.SHOP_1Test', status: 'failed' as const, error: 'java.lang.AssertionError: expected [Products] but found [Login]' },
                { title: 'SHOP-2 Cart', className: 'com.demoapp.tests.tests.cart.SHOP_2Test', status: 'failed' as const, error: 'NoSuchElementException' }
            ]
        ];
        const out = parseMavenResults(runs, config, s => s, root, root);
        const byId = Object.fromEntries(out.map(o => [o.id, o]));
        expect(byId['SHOP-1'].status).toBe('flaky');
        expect(byId['SHOP-1'].file).toBe('src/test/java/com/demoapp/tests/tests/login/SHOP_1Test.java');
        expect(byId['SHOP-2']).toMatchObject({ status: 'failed', category: 'locator', attachments: [{ name: 'screenshot', path: 'target/screenshots/SHOP_2Test.png' }] });
        expect(byId['SHOP-3'].status).toBe('skipped');
        expect(categoriseJava('org.openqa.selenium.SessionNotCreatedException: Could not start a new session').category).toBe('environment');
        expect(categoriseJava('java.lang.NullPointerException').category).toBe('script');
        expect(categoriseJava('org.openqa.selenium.TimeoutException: Expected condition failed').category).toBe('locator');
    });
});

describe('repo-specific agents', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('writes QA agents for Claude Code and Cursor and adds the Playwright MCP for web apps', async () => {
        const root = tempRepo({ 'cases.csv': CASES });
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerWebSetup(c, root, { TEST_CASE_SOURCE: 'csv', FRAMEWORK: 'selenium', LANGUAGE: 'java', PATTERN: 'bdd' });
        const scaffold = await c.call('preview_scaffold');
        await c.call('scaffold_project', { confirmToken: scaffold.structuredContent.confirmToken, userApproved: true });
        for (const dir of ['.claude/agents', '.cursor/agents']) {
            for (const name of ['qa-test-writer', 'qa-test-runner', 'qa-page-object-curator', 'qa-test-case-reviewer', 'qa-framework-guide']) {
                expect(existsSync(path.join(root, dir, `${name}.md`)), `${dir}/${name}.md`).toBe(true);
            }
        }
        const writer = readFileSync(path.join(root, '.claude/agents/qa-test-writer.md'), 'utf8');
        expect(writer).toMatch(/^---\nname: qa-test-writer\n/);
        expect(writer).toContain('Selenium');
        expect(writer).toContain('mvn test -Dcucumber.filter.tags=@<ID>');
        expect(writer).toContain('Secrets live only in `.env`');
        expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('qa-test-writer');
        for (const file of ['.cursor/mcp.json', '.mcp.json']) {
            const servers = JSON.parse(readFileSync(path.join(root, file), 'utf8')).mcpServers;
            expect(servers.testpilot).toBeDefined();
            expect(servers.playwright.args).toContain('@playwright/mcp@0.0.83');
        }
    });
});
