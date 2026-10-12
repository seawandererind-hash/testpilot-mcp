import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAction, parseCheck } from '../src/generate/intents.js';
import { categorise, parseReport } from '../src/run/playwright.js';
import { answerWebSetup, connect, tempRepo } from './helpers.js';

describe('step reader', () => {
    it.each([
        ['Open the login page', { kind: 'open', target: 'login' }],
        ['Navigate to /checkout', { kind: 'open', path: '/checkout' }],
        ['Log in as admin', { kind: 'login', role: 'admin' }],
        ['Login with valid credentials', { kind: 'login', role: 'standard' }],
        ['Enter "qa@example.com" in the Email field', { kind: 'fill', field: 'Email', value: { kind: 'literal', value: 'qa@example.com' } }],
        ['Enter the password', { kind: 'fill', field: 'Password', value: { kind: 'env', name: 'TEST_USER_PASSWORD' } }],
        ['Enter password "wrong-one"', { kind: 'fill', field: 'Password', value: { kind: 'literal', value: 'wrong-one' } }],
        ['The user clicks the Sign in button', { kind: 'click', name: 'Sign in', role: 'button' }],
        ['Click Add to cart on Red shoes', { kind: 'click', name: 'Add to cart', within: 'Red shoes' }],
        ['Select "Express" from the Delivery dropdown', { kind: 'select', option: 'Express', field: 'Delivery' }],
        ['Tick the Remember me checkbox', { kind: 'check', name: 'Remember me', checked: true }],
        ['Press Enter', { kind: 'press', key: 'Enter' }],
        ['Search for "shoes"', { kind: 'search', text: 'shoes' }],
        ['Leave the email field empty', { kind: 'clear', field: 'email' }],
        ['Wait 5 seconds', { kind: 'wait' }],
        ['Reticulate the splines', { kind: 'unknown' }]
    ])('%s', (step, expected) => {
        expect(parseAction(step)[0]).toMatchObject(expected);
    });

    it('splits "Enter valid email and password" into two fills from .env', () => {
        expect(parseAction('Enter valid email and password')).toEqual([
            { kind: 'fill', field: 'Email', value: { kind: 'env', name: 'TEST_USER_EMAIL' } },
            { kind: 'fill', field: 'Password', value: { kind: 'env', name: 'TEST_USER_PASSWORD' } }
        ]);
    });

    it.each([
        ['Error message "Invalid email or password" is shown', { kind: 'text', text: 'Invalid email or password', visible: true }],
        ['Products page is displayed', { kind: 'heading', name: 'Products' }],
        ['User is redirected to the dashboard', { kind: 'heading', name: 'dashboard' }],
        ['Page title is "Checkout"', { kind: 'title', text: 'Checkout', exact: true }],
        ['URL contains /orders', { kind: 'url', part: '/orders' }],
        ['Cart count shows 1', { kind: 'count', name: 'Cart', value: '1' }],
        ['The Pay button is disabled', { kind: 'state', name: 'Pay', role: 'button', state: 'disabled' }],
        ['Everything works', { kind: 'unknown' }]
    ])('expected: %s', (text, expected) => {
        expect(parseCheck(text)[0]).toMatchObject(expected);
    });
});

describe('triage', () => {
    it.each([
        ['locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for getByRole(\'button\', { name: \'Go\' })', 'locator'],
        ['strict mode violation: getByRole(\'button\') resolved to 2 elements', 'locator'],
        ['expect(locator).toHaveText(expected) failed\nExpected: "Basket"', 'assertion'],
        ['page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:1/', 'environment'],
        ['Missing APP_BASE_URL. Copy .env.example to .env and fill it in', 'environment'],
        ['Test timeout of 30000ms exceeded.', 'timing'],
        ['TypeError: loginPage.nope is not a function', 'script'],
        ['No user with role "admin" in test-data/users.json.', 'data']
    ])('%s → %s', (message, category) => {
        expect(categorise(message).category).toBe(category);
    });

    it('reads a Playwright JSON report, marks mixed repeats as flaky and hides secrets', () => {
        const report = {
            config: { rootDir: '/repo/tests' },
            suites: [
                {
                    title: 'login/SHOP-1.spec.ts',
                    file: 'login/SHOP-1.spec.ts',
                    specs: [
                        {
                            title: 'SHOP-1 Login',
                            file: 'login/SHOP-1.spec.ts',
                            line: 6,
                            tests: [
                                {
                                    projectName: 'chromium',
                                    status: 'flaky',
                                    annotations: [{ type: 'test_key', description: 'SHOP-1' }],
                                    results: [
                                        { status: 'failed', duration: 10, error: { message: 'expect(locator).toHaveValue failed\nExpected: "s3cret-pass"' }, attachments: [{ name: 'trace', path: '/repo/test-results/x/trace.zip', contentType: 'application/zip' }] },
                                        { status: 'passed', duration: 12 }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        };
        const [t] = parseReport(report, '/repo', s => s.replace('s3cret-pass', '[REDACTED]'), '/repo');
        expect(t).toMatchObject({ id: 'SHOP-1', status: 'flaky', runs: 2, passes: 1, file: 'tests/login/SHOP-1.spec.ts', category: 'assertion' });
        expect(t.error).not.toContain('s3cret');
        expect(t.attachments[0]).toEqual({ name: 'trace', path: 'test-results/x/trace.zip' });
    });
});

describe('plan and generate tools', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('needs an approved plan, then writes specs, page objects and fixtures', async () => {
        const root = tempRepo({
            'cases.csv': [
                'ID,Title,Module,Priority,Preconditions,Steps,Expected Result',
                'SHOP-1,Login with valid credentials,Login,High,,"1. Open the application\n2. Enter the email of the standard user\n3. Enter the password\n4. Click Sign in",Products page is displayed',
                'SHOP-2,Add a product to the cart,Cart,High,User is logged in,"1. Click Add to cart on Red shoes",Cart count shows 1',
                'SHOP-3,Reticulate,Cart,Low,,"1. Reticulate the splines",The splines are reticulated'
            ].join('\n')
        });
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerWebSetup(c, root, { TEST_CASE_SOURCE: 'csv' });
        const scaffold = await c.call('preview_scaffold');
        await c.call('scaffold_project', { confirmToken: scaffold.structuredContent.confirmToken, userApproved: true });
        await c.call('import_test_cases', { location: 'cases.csv' });
        await c.call('review_test_cases');

        expect((await c.call('preview_tests')).content[0].text).toContain('no automation plan');
        const plan = await c.call('automation_plan', { action: 'generate' });
        expect(plan.structuredContent.plan.waves[0].ids).toEqual(['SHOP-1', 'SHOP-2']);
        expect(readFileSync(path.join(root, 'plans/automation-plan.md'), 'utf8')).toContain('waiting for approval');
        expect((await c.call('preview_tests')).content[0].text).toContain('not approved');
        const refused = await c.call('automation_plan', { action: 'approve' });
        expect(refused.isError).toBe(true);
        await c.call('automation_plan', { action: 'approve', userApproved: true, approver: 'Surya' });
        expect(readFileSync(path.join(root, 'plans/automation-plan.md'), 'utf8')).toContain('approved** by Surya');

        const preview = await c.call('preview_tests');
        expect(preview.structuredContent.wave).toBe(1);
        const gen = await c.call('generate_tests', { confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        expect(gen.isError).toBeFalsy();
        const spec = readFileSync(path.join(root, 'tests/login/SHOP-1.spec.ts'), 'utf8');
        expect(spec).toContain("annotation: { type: 'test_key', description: 'SHOP-1' }");
        expect(spec).toContain("await loginPage.passwordField.fill(requireEnv('TEST_USER_PASSWORD'));");
        expect(spec).not.toContain('waitForTimeout');
        const cart = readFileSync(path.join(root, 'tests/cart/SHOP-2.spec.ts'), 'utf8');
        expect(cart).toContain("await loginPage.loginAs('standard');");
        expect(cart).toContain("await cartPage.addToCartButtonFor('Red shoes').click();");
        expect(cart).toContain('test.fixme(');
        const fixtures = readFileSync(path.join(root, 'src/fixtures/test.ts'), 'utf8');
        expect(fixtures).toContain('loginPage: LoginPage;');
        expect(fixtures).toContain('cartPage: async ({ page }, use) => {');

        // Wave 3 holds the low-priority case; generating it adds to the existing CartPage above the marker.
        const plan2 = await c.call('automation_plan', { action: 'show' });
        const later = plan2.structuredContent.plan.waves.find((w: { ids: string[] }) => w.ids.includes('SHOP-3'));
        const p3 = await c.call('preview_tests', { wave: later.number });
        expect(p3.structuredContent.files.find((f: { path: string }) => f.path === 'tests/cart/SHOP-3.spec.ts').status).toBe('new');
        const listed = await c.call('list_test_cases', { status: 'generated' });
        expect(listed.structuredContent.cases.map((x: { id: string }) => x.id)).toEqual(['SHOP-1', 'SHOP-2']);
    });
});
