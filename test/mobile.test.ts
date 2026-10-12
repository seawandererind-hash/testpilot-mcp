import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectStore } from '../src/core/store.js';
import { parsePageSource, renderMobileExploration } from '../src/explore/mobile.js';
import { categoriseAppium, parseWdioResults, runWdio, testIdOf, type WdioResultFile } from '../src/run/wdio.js';
import { connect, tempRepo } from './helpers.js';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

type Connected = Awaited<ReturnType<typeof connect>>;

/** Answers the wizard for an Android + Appium + CSV setup up to (not including) SCAFFOLD. */
async function answerMobileSetup(c: Connected, overrides: Record<string, string | string[]> = {}): Promise<void> {
    const answers: Array<[string, string | string[]]> = [
        ['APP_TYPE', 'android'],
        ['FRAMEWORK', 'appium'],
        ['LANGUAGE', 'typescript'],
        ['PATTERN', 'pom'],
        ['EXECUTION_TARGET', 'local'],
        ['TEST_CASE_SOURCE', 'csv'],
        ['CI', 'github-actions'],
        ['REPORTING', ['html', 'junit']]
    ];
    for (const [step, answer] of answers) {
        const res = await c.call('wizard', { action: 'answer', step, answer: overrides[step] ?? answer });
        if (res.isError) throw new Error(`${step}: ${res.content[0].text}`);
    }
    await c.call('write_env_template');
}

async function scaffold(c: Connected): Promise<void> {
    const preview = await c.call('preview_scaffold');
    const done = await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken, userApproved: true });
    if (done.isError) throw new Error(done.content[0].text);
}

describe('appium-ts scaffold', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('previews an Android project with the driver install and the manual setup steps', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerMobileSetup(c);
        expect(readFileSync(path.join(root, '.env.example'), 'utf8')).toMatch(/^APP_PATH=$/m);

        const preview = await c.call('preview_scaffold');
        expect(preview.isError).toBeFalsy();
        const files = preview.structuredContent.files.map((f: { path: string }) => f.path);
        for (const file of [
            'wdio.conf.ts',
            'wdio.browserstack.conf.ts',
            'tsconfig.json',
            'src/screens/BaseScreen.ts',
            'src/screens/HomeScreen.ts',
            'src/reporting/testpilot-reporter.ts',
            'src/reporting/mask-secrets.ts',
            'src/utils/env.ts',
            'src/utils/users.ts',
            'src/utils/pending.ts',
            'test/specs/smoke.spec.ts',
            'test-data/users.json',
            'package.json'
        ]) {
            expect(files).toContain(file);
        }
        expect(preview.structuredContent.installCommands).toEqual(['npm install', 'npx appium driver install uiautomator2@8.7.0']);
        expect(preview.structuredContent.manualSetup).toMatch(/^1\. Android: install a JDK/);
        expect(preview.structuredContent.manualSetup).not.toContain('BrowserStack');
        expect(preview.content[0].text).toContain('The user also needs to do these steps themselves');

        await scaffold(c);
        const conf = readFileSync(path.join(root, 'wdio.conf.ts'), 'utf8');
        expect(conf).toContain("'appium:automationName': 'UiAutomator2'");
        expect(conf).not.toContain('XCUITest');
        expect(conf).toContain("addProperty('test_key', key)");
        expect(conf).toContain('maskSecretsInReports');
        const base = readFileSync(path.join(root, 'src/screens/BaseScreen.ts'), 'utf8');
        expect(base).toContain('android=new UiSelector().text(');
        expect(base).not.toContain('driver.isIOS');
        expect(base).not.toMatch(/\{\{|\}\}/);
        const home = readFileSync(path.join(root, 'src/screens/HomeScreen.ts'), 'utf8');
        expect(home).toContain('// testpilot:locators');
        expect(home).toContain('// testpilot:actions');
        const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies).toMatchObject({ webdriverio: '9.32.0', '@wdio/cli': '9.32.0', appium: '3.8.0' });
        expect(pkg.devDependencies['@wdio/browserstack-service']).toBeUndefined();
        expect(pkg.scripts.test).toBe('wdio run wdio.conf.ts');

        // The app step fills the shared default in .env.example (never .env).
        const app = await c.call('wizard', { action: 'answer', step: 'APP_UNDER_TEST', answer: 'apps/app-debug.apk' });
        expect(app.isError).toBeFalsy();
        expect(readFileSync(path.join(root, '.env.example'), 'utf8')).toMatch(/^APP_PATH=apps\/app-debug\.apk$/m);
        expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toMatch(/^apps\/$/m);
    });

    it('adds the BrowserStack service and skips local drivers for an iOS cloud project', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerMobileSetup(c, { APP_TYPE: 'ios', EXECUTION_TARGET: 'browserstack' });
        const preview = await c.call('preview_scaffold');
        expect(preview.structuredContent.installCommands).toEqual(['npm install']);
        expect(preview.structuredContent.manualSetup).toContain('BROWSERSTACK_APP_ID');
        expect(preview.structuredContent.manualSetup).not.toContain('Xcode');
        await scaffold(c);
        const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies['@wdio/browserstack-service']).toBe('9.39.4');
        const bs = readFileSync(path.join(root, 'wdio.browserstack.conf.ts'), 'utf8');
        expect(bs).toContain("const APPIUM_VERSION = '3.5.2'");
        expect(bs).toContain('process.env.BROWSERSTACK_APP_ID');
        expect(bs).not.toMatch(/\bbs:\/\/[a-f0-9]{8,}/);
        const base = readFileSync(path.join(root, 'src/screens/BaseScreen.ts'), 'utf8');
        expect(base).toContain('-ios predicate string:');
        expect(base).not.toContain('UiSelector');
    });

    it('explains how to start Appium when no server answers', async () => {
        const root = tempRepo({ 'node_modules/webdriverio/package.json': '{"name":"webdriverio","version":"9.32.0"}', 'apps/app-debug.apk': '' });
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerMobileSetup(c);
        await scaffold(c);
        await c.call('wizard', { action: 'answer', step: 'APP_UNDER_TEST', answer: 'apps/app-debug.apk' });
        // Port 9 (discard) has no Appium server on it.
        writeFileSync(path.join(root, '.env'), 'APPIUM_SERVER_URL=http://127.0.0.1:9\n');
        const res = await c.call('explore_app', { userApproved: true, approver: 'QA lead' });
        expect(res.isError).toBeFalsy();
        expect(res.structuredContent).toMatchObject({ opened: false, appiumReachable: false, server: 'http://127.0.0.1:9' });
        expect(res.content[0].text).toContain('npm run appium');
        expect(res.content[0].text).toContain('npx appium driver install uiautomator2@8.7.0');
        expect(res.content[0].text).toContain('adb devices');
    });
});

describe('appium test generation', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('writes screens and Mocha specs with explored selectors, env values and pending TODOs', async () => {
        const root = tempRepo({
            'cases.csv': [
                'ID,Title,Module,Priority,Preconditions,Steps,Expected Result',
                'SHOP-1,Login with valid credentials,Login,High,,"1. Open the application\n2. Enter the email of the standard user\n3. Enter the password\n4. Tap Sign in",Products screen is displayed',
                'SHOP-2,Add a product to the cart,Cart,High,User is logged in,"1. Tap Add to cart on Red shoes\n2. Tick the Gift wrap checkbox",Cart count shows 1',
                'SHOP-3,Remember the login,Login,Medium,,"1. Tick the Remember me checkbox\n2. Go back",The SIGN IN button is enabled'
            ].join('\n')
        });
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerMobileSetup(c);
        await scaffold(c);
        // What explore_app saves after reading the first screen.
        const explored = parsePageSource(fixture('uiautomator2-login.xml'));
        mkdirSync(path.join(root, '.testpilot/exploration'), { recursive: true });
        writeFileSync(
            path.join(root, '.testpilot/exploration/screens.json'),
            JSON.stringify({ platform: 'android', screens: [{ name: 'Login', platform: 'android', contexts: ['NATIVE_APP'], headings: [], elements: explored.elements }] })
        );
        await c.call('import_test_cases', { location: 'cases.csv' });
        await c.call('review_test_cases');
        await c.call('automation_plan', { action: 'generate' });
        await c.call('automation_plan', { action: 'approve', userApproved: true, approver: 'QA lead' });

        const preview = await c.call('preview_tests', { ids: ['SHOP-1', 'SHOP-2'] });
        expect(preview.isError).toBeFalsy();
        expect(preview.structuredContent.files.map((f: { path: string }) => f.path)).toEqual(
            expect.arrayContaining(['src/screens/LoginScreen.ts', 'src/screens/CartScreen.ts', 'test/specs/login/SHOP-1.spec.ts', 'test/specs/cart/SHOP-2.spec.ts'])
        );
        const gen = await c.call('generate_tests', { ids: ['SHOP-1', 'SHOP-2'], confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        expect(gen.isError).toBeFalsy();
        expect(gen.content[0].text).toContain('pendingUntilDone');

        const login = readFileSync(path.join(root, 'test/specs/login/SHOP-1.spec.ts'), 'utf8');
        expect(login).toContain("it('SHOP-1 Login with valid credentials @SHOP-1 @login @p1', async () => {");
        expect(login).toContain("await loginScreen.type(loginScreen.emailField, requireEnv('TEST_USER_EMAIL'));");
        expect(login).toContain("await loginScreen.type(loginScreen.passwordField, requireEnv('TEST_USER_PASSWORD'));");
        expect(login).toContain('await loginScreen.tap(loginScreen.signInButton);');
        expect(login).toContain('await productsScreen.waitForScreen();');
        expect(login).not.toContain('pendingUntilDone');

        const screen = readFileSync(path.join(root, 'src/screens/LoginScreen.ts'), 'utf8');
        // Accessibility id first, then resource-id; never XPath by position.
        expect(screen).toContain("return $('~login-button');");
        expect(screen).toContain("return $('id=com.example.shop:id/email');");
        expect(screen).toContain("return $('id=com.example.shop:id/password');");
        expect(screen).not.toMatch(/\[\d+\]/);
        expect(screen).toContain('async loginAs(role = \'standard\')');

        const cart = readFileSync(path.join(root, 'test/specs/cart/SHOP-2.spec.ts'), 'utf8');
        expect(cart).toContain("it('SHOP-2 Add a product to the cart @SHOP-2 @cart @p1', async function () {");
        expect(cart).toContain("pendingUntilDone(this, '1 step(s) still need code: check that the Cart shows 1');");
        expect(cart).toContain("await loginScreen.loginAs('standard');");
        expect(cart).toContain("await cartScreen.tap(cartScreen.addToCartButtonFor('Red shoes'));");
        expect(cart).toContain('await cartScreen.setChecked(cartScreen.giftWrapCheckbox, true);');
        expect(cart).toContain('// TODO(testpilot): check that the Cart shows 1');
        const cartScreen = readFileSync(path.join(root, 'src/screens/CartScreen.ts'), 'utf8');
        expect(cartScreen).toContain("return this.inItem(text, 'Add to cart');");
        expect(cartScreen).toContain('Not seen during exploration');

        for (const file of [login, cart, screen, cartScreen]) {
            expect(file).not.toMatch(/\bpause\(|setTimeout|waitForTimeout/);
            expect(file).not.toContain('not-a-real');
        }

        // A later case adds to the existing LoginScreen above its markers and keeps what is there.
        const later = await c.call('preview_tests', { ids: ['SHOP-3'] });
        const status = Object.fromEntries(later.structuredContent.files.map((f: { path: string; status: string }) => [f.path, f.status]));
        expect(status['src/screens/LoginScreen.ts']).toBe('merge');
        await c.call('generate_tests', { ids: ['SHOP-3'], confirmToken: later.structuredContent.confirmToken, userApproved: true });
        const merged = readFileSync(path.join(root, 'src/screens/LoginScreen.ts'), 'utf8');
        expect(merged).toContain("return this.byText('Remember me');");
        expect(merged.indexOf('get rememberMeCheckbox()')).toBeLessThan(merged.indexOf('// testpilot:locators'));
        expect(merged.match(/get signInButton\(\)/g)).toHaveLength(1);
        const remember = readFileSync(path.join(root, 'test/specs/login/SHOP-3.spec.ts'), 'utf8');
        expect(remember).toContain('await loginScreen.setChecked(loginScreen.rememberMeCheckbox, true);');
        expect(remember).toContain('await driver.back();');
        expect(remember).toContain('await expect(loginScreen.signInButton).toBeEnabled();');
    });
});

describe('page source parser', () => {
    it('reads a UiAutomator2 screen: accessibility id, then resource-id, then text; no secrets, no XPath', () => {
        const { platform, elements } = parsePageSource(fixture('uiautomator2-login.xml'));
        expect(platform).toBe('android');
        const by = (label: string) => elements.find(e => e.label === label);
        expect(by('SIGN IN')).toMatchObject({ role: 'button', selector: '~login-button', strategy: 'accessibility id', resourceId: 'com.example.shop:id/sign_in' });
        expect(by('Email')).toMatchObject({ role: 'textbox', selector: 'id=com.example.shop:id/email', strategy: 'id' });
        expect(by('Password')).toMatchObject({ role: 'textbox', secure: true, selector: 'id=com.example.shop:id/password' });
        expect(by('Password')?.text).toBeUndefined();
        expect(JSON.stringify(elements)).not.toContain('••••');
        expect(by('Remember me')).toMatchObject({ role: 'checkbox', selector: 'android=new UiSelector().text("Remember me")', strategy: 'text' });
        expect(by('Forgot password?')).toMatchObject({ role: 'button' });
        expect(by('Continue')).toMatchObject({ selector: 'id=com.example.shop:id/social_login', count: 2 });
        expect(by('Terms & Conditions')).toBeDefined();
        expect(by('app-logo')).toMatchObject({ role: 'image', selector: '~app-logo' });
        // Layout containers and the decorative image without an id are left out.
        expect(elements.filter(e => e.role === 'image')).toHaveLength(1);
        expect(elements.some(e => /Layout/.test(e.type))).toBe(false);
        expect(elements.every(e => !e.selector.startsWith('/') && !e.selector.includes('xpath'))).toBe(true);
    });

    it('reads an XCUITest screen with its navigation title, cells, tabs and repeated buttons', () => {
        const { platform, elements, title, headings } = parsePageSource(fixture('xcuitest-products.xml'));
        expect(platform).toBe('ios');
        expect(title).toBe('Products');
        expect(headings).toEqual(['Products']);
        const by = (label: string) => elements.find(e => e.label === label);
        expect(by('Add to cart')).toMatchObject({ role: 'button', selector: '~add-to-cart', count: 2 });
        expect(by('Search products')).toMatchObject({ role: 'searchbox', selector: '~search-field' });
        expect(by('In stock only')).toMatchObject({ role: 'switch', selector: '~in-stock-only' });
        expect(by('Cart, 2 items')).toMatchObject({ role: 'tab', selector: '~Cart' });
        expect(by('Blue "Runner" jacket')).toMatchObject({ role: 'text', selector: '~Blue "Runner" jacket' });
        expect(elements.some(e => e.role === 'cell')).toBe(false);
        expect(elements.some(e => e.role === 'image')).toBe(false);
    });

    it('reads Windows (UI Automation) and macOS (Mac2) sources', () => {
        const win = parsePageSource(
            `<Window Name="Sign in - Demo" AutomationId="MainWindow" ClassName="Window" IsEnabled="True" IsOffscreen="False">
               <Edit Name="User name" AutomationId="UserBox" IsEnabled="True" IsOffscreen="False"/>
               <Edit Name="Password" AutomationId="PasswordBox" IsPassword="True" IsEnabled="True" IsOffscreen="False"/>
               <Button Name="Sign in" IsEnabled="False" IsOffscreen="False"/>
               <Pane ClassName="Spacer"/>
             </Window>`
        );
        expect(win.platform).toBe('windows');
        expect(win.title).toBe('Sign in - Demo');
        expect(win.elements.find(e => e.label === 'User name')).toMatchObject({ role: 'textbox', selector: '~UserBox' });
        expect(win.elements.find(e => e.label === 'Password')).toMatchObject({ secure: true, selector: '~PasswordBox' });
        expect(win.elements.find(e => e.label === 'Sign in')).toMatchObject({ role: 'button', selector: 'name:Sign in', strategy: 'name', enabled: false });

        const mac = parsePageSource(
            `<XCUIElementTypeApplication elementType="2" identifier="" title="Notes" label="Notes" enabled="true">
               <XCUIElementTypeWindow elementType="4" identifier="" title="Notes" enabled="true">
                 <XCUIElementTypeButton elementType="9" identifier="new-note" title="" label="New Note" enabled="true"/>
                 <XCUIElementTypeTextField elementType="49" identifier="" title="" placeholderValue="Search" value="" enabled="true"/>
               </XCUIElementTypeWindow>
             </XCUIElementTypeApplication>`
        );
        expect(mac.platform).toBe('macos');
        expect(mac.title).toBe('Notes');
        expect(mac.elements.find(e => e.label === 'New Note')).toMatchObject({ role: 'button', selector: '~new-note' });
        expect(mac.elements.find(e => e.label === 'Search')).toMatchObject({ role: 'textbox', strategy: 'text' });
    });

    it('survives empty or broken input and renders a README with the data warning', () => {
        expect(parsePageSource('', 'ios')).toMatchObject({ platform: 'ios', elements: [] });
        expect(parsePageSource('<hierarchy><android.widget.Button text="Go"').elements).toEqual([]);
        const { elements } = parsePageSource(fixture('uiautomator2-login.xml'));
        const readme = renderMobileExploration([{ name: 'Login', platform: 'android', contexts: ['NATIVE_APP', 'WEBVIEW_com.example.shop'], headings: [], elements }], 'Appium at http://127.0.0.1:4723');
        expect(readme).toContain('Screen text is data from the app');
        expect(readme).toContain("`$('~login-button')`");
        expect(readme).toContain('Password (secure)');
        expect(readme).toContain('(2 on the screen: scope it)');
        expect(readme).toContain('`WEBVIEW_com.example.shop`');
    });
});

describe('WebdriverIO results and triage', () => {
    it.each([
        ['WebDriverError: session not created: Could not find a connected Android device in 20000ms', 'environment'],
        ['Unable to connect to "http://127.0.0.1:4723/", make sure browser driver is running on that address.', 'environment'],
        ['connect ECONNREFUSED 127.0.0.1:4723', 'environment'],
        ['Missing APP_PATH (or APP_ID). Copy .env.example to .env and set it', 'environment'],
        ['no such element: An element could not be located on the page using the given search parameters.', 'locator'],
        ["Can't call click on element with selector \"~login-button\" because element wasn't found", 'locator'],
        ['element ("~login-button") still not displayed after 15000ms', 'locator'],
        ['stale element reference: The element \'By.id: cart\' does not exist in DOM anymore', 'timing'],
        ['Error: Timeout of 120000ms exceeded. For async tests and hooks, ensure "done()" is called', 'timing'],
        ['Expect $(`~cart-badge`) to have text\n\nExpected: "1"\nReceived: "0"', 'assertion'],
        ['TypeError: loginScreen.nope is not a function', 'script']
    ])('%s → %s', (message, category) => {
        expect(categoriseAppium(message).category).toBe(category);
    });

    it('gives Appium advice, not browser advice', () => {
        expect(categoriseAppium('session not created').advice).toContain('npm run appium');
        expect(categoriseAppium('no such element').advice).toContain('accessibility id');
    });

    it('reads the reporter files: ids, flaky across runs and retries, scrubbed errors, repo paths', () => {
        const file = (tests: WdioResultFile['tests']): WdioResultFile => ({ format: 'testpilot-wdio-results', cid: '0-0', specs: ['/repo/mobile/test/specs/login/SHOP-1.spec.ts'], platform: 'Android', device: 'Pixel 8', tests });
        const shot = { name: 'screenshot', path: 'test-results/screenshots/Login-SHOP-1.png' };
        const runs: WdioResultFile[][] = [
            [
                file([
                    { title: 'SHOP-1 Login @SHOP-1 @login', fullTitle: 'Login SHOP-1 Login @SHOP-1 @login', state: 'failed', durationMs: 900, error: { message: 'Expect $(`~welcome`) to have text\nExpected: "hi s3cret-pass"\nReceived: "hi"' }, attachments: [shot] },
                    { title: 'SHOP-2 Logout @SHOP-2', state: 'passed', durationMs: 300, retries: 1 },
                    { title: 'SHOP-3 Later @SHOP-3', state: 'pending' }
                ])
            ],
            [file([{ title: 'SHOP-1 Login @SHOP-1 @login', fullTitle: 'Login SHOP-1 Login @SHOP-1 @login', state: 'failed', durationMs: 800, error: { message: 'no such element' }, attachments: [shot] }])]
        ];
        const tests = parseWdioResults(runs, s => s.replaceAll('s3cret-pass', '[REDACTED]'), '/repo', '/repo/mobile');
        const one = tests.find(t => t.id === 'SHOP-1')!;
        expect(one).toMatchObject({ status: 'failed', runs: 2, passes: 0, file: 'mobile/test/specs/login/SHOP-1.spec.ts', project: 'Android · Pixel 8', category: 'assertion', durationMs: 1700 });
        expect(one.error).toContain('[REDACTED]');
        expect(one.error).not.toContain('s3cret');
        expect(one.attachments).toEqual([{ name: 'screenshot', path: 'mobile/test-results/screenshots/Login-SHOP-1.png' }]);
        expect(tests.find(t => t.id === 'SHOP-2')).toMatchObject({ status: 'flaky', runs: 2, passes: 1, error: 'Passed after 1 retry' });
        expect(tests.find(t => t.id === 'SHOP-3')).toMatchObject({ status: 'skipped', runs: 0 });
        expect(tests.find(t => t.id === 'SHOP-3')?.error).toBeUndefined();
        expect(testIdOf('C1234 Checkout works')).toBe('C1234');
        expect(testIdOf('Checkout works @PROJ-77 @smoke')).toBe('PROJ-77');
    });

    it('runs wdio once per stability run with spec and grep filters and keeps the console when there are no results', async () => {
        const root = tempRepo({ '.env': 'TEST_USER_PASSWORD=s3cret-pass\n' });
        const store = new ProjectStore(root);
        const calls: string[][] = [];
        let n = 0;
        const summary = await runWdio(
            store,
            { cwd: root, configFile: 'wdio.conf.ts', specs: ['test/specs/login/SHOP-1.spec.ts'], grep: '@(SHOP-1)(\\s|$)', repeat: 2, timeoutMs: 60_000, resultsDir: 'test-results/testpilot' },
            async (_cwd, argv) => {
                calls.push(argv);
                n++;
                mkdirSync(path.join(root, 'test-results/testpilot'), { recursive: true });
                const state = n === 1 ? 'failed' : 'passed';
                const result: WdioResultFile = { cid: '0-0', specs: [path.join(root, 'test/specs/login/SHOP-1.spec.ts')], platform: 'Android', tests: [{ title: 'SHOP-1 Login @SHOP-1', state, error: state === 'failed' ? { message: 'stale element reference' } : undefined }] };
                writeFileSync(path.join(root, 'test-results/testpilot/results-0-0.json'), JSON.stringify(result));
                return { command: argv.join(' '), ok: n > 1, exitCode: n === 1 ? 1 : 0, tail: 'typed s3cret-pass' };
            }
        );
        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual(['npx', 'wdio', 'run', 'wdio.conf.ts', '--spec', 'test/specs/login/SHOP-1.spec.ts', '--mochaOpts.grep', '@(SHOP-1)(\\s|$)']);
        expect(summary.stats).toMatchObject({ total: 1, flaky: 1 });
        expect(summary.tests[0]).toMatchObject({ id: 'SHOP-1', status: 'flaky', category: 'timing', file: 'test/specs/login/SHOP-1.spec.ts' });
        expect(summary.reportFile).toBe('test-results/testpilot');
        expect(summary.consoleTail).toBeUndefined();

        const empty = await runWdio(store, { cwd: root, configFile: 'wdio.conf.ts', specs: [], repeat: 1, timeoutMs: 60_000, resultsDir: 'missing' }, async () => ({ command: 'wdio', ok: false, exitCode: 1, tail: 'Unable to connect to "http://127.0.0.1:4723/" as s3cret-pass' }));
        expect(empty.tests).toEqual([]);
        expect(empty.consoleTail).toContain('Unable to connect');
        expect(empty.consoleTail).not.toContain('s3cret');
    });
});
