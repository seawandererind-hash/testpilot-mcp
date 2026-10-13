import { INTEGRATION_KEYS } from '../catalog/env-keys.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot } from '../scaffold/engine.js';
import { type CapabilityPlan, type CloudProvider, emptyPlan, findPlaywrightConfig, type PlanOutcome, planEnvExample, planPackageAdditions, playwrightLang } from './shared.js';

/** Pinned: latest stable releases at least two weeks old when checked (2026-10-13). */
export const BROWSERSTACK_SDK_VERSION = '1.71.1';
export const SAUCECTL_VERSION = '0.214.0';

const LABEL: Record<CloudProvider, string> = { browserstack: 'BrowserStack', saucelabs: 'Sauce Labs', lambdatest: 'LambdaTest' };

/** A browser to run on, in Playwright's own names (chromium, firefox, webkit) plus Edge. */
type Browser = 'chromium' | 'firefox' | 'webkit' | 'edge';

/** The configured browsers, or a sensible cross-browser default (Chrome on Windows 11, Safari/WebKit on macOS, Edge). */
export function cloudBrowsers(config: Config): Browser[] {
    const chosen = (config.execution.browsers ?? []).map(b => b.toLowerCase()).filter((b): b is Browser => ['chromium', 'firefox', 'webkit', 'edge'].includes(b));
    if (chosen.length > 1 || (chosen.length === 1 && chosen[0] !== 'chromium')) return chosen;
    return ['chromium', 'webkit', 'edge'];
}

export function browserstackYml(config: Config, browsers: Browser[]): string {
    const platform: Record<Browser, string[]> = {
        chromium: ['  - os: Windows', '    osVersion: 11', '    browserName: chrome', '    browserVersion: latest'],
        edge: ['  - os: Windows', '    osVersion: 11', '    browserName: edge', '    browserVersion: latest'],
        firefox: ['  - os: Windows', '    osVersion: 11', '    browserName: playwright-firefox', '    browserVersion: latest'],
        webkit: ['  - os: OS X', '    osVersion: Ventura', '    browserName: playwright-webkit', '    browserVersion: latest']
    };
    return [
        `# ${CREATED_HEADER}`,
        '# BrowserStack settings for the browserstack-node-sdk. Run: npm run test:browserstack',
        '# Docs: https://www.browserstack.com/docs/automate/playwright/getting-started/nodejs/test-runner',
        '# Credentials are NOT stored here: the SDK reads BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY',
        '# from the environment: export them in your terminal before the run (CI: add them as secrets).',
        `projectName: ${JSON.stringify(config.project.name ?? 'Web tests')}`,
        'buildName: testpilot',
        "buildIdentifier: '#${BUILD_NUMBER}'",
        'framework: playwright',
        'platforms:',
        ...browsers.flatMap(b => platform[b]),
        '# Tests running at the same time on each platform (your plan limits the total).',
        'parallelsPerPlatform: 1',
        '# Opens a secure tunnel so cloud browsers can reach localhost or a test site inside your network.',
        'browserstackLocal: true',
        'debug: false',
        'networkLogs: false',
        'consoleLogs: errors',
        'testObservability: true',
        ''
    ].join('\n');
}

export function sauceConfig(config: Config, browsers: Browser[], configFile: string): string {
    const projects = new Set(config.execution.browsers ?? []);
    const suite: Record<Browser, { name: string; platform: string; browser: string }> = {
        chromium: { name: 'Chromium Windows 11', platform: 'Windows 11', browser: 'chromium' },
        edge: { name: 'Chromium Windows 11 (Edge is not offered for Playwright on Sauce Labs)', platform: 'Windows 11', browser: 'chromium' },
        firefox: { name: 'Firefox Windows 11', platform: 'Windows 11', browser: 'firefox' },
        webkit: { name: 'WebKit macOS 13', platform: 'macOS 13', browser: 'webkit' }
    };
    const unique = browsers.filter((b, i) => browsers.findIndex(o => suite[o].browser === suite[b].browser) === i);
    return [
        `# ${CREATED_HEADER}`,
        '# Sauce Labs settings for saucectl. Run: npm run test:saucelabs',
        '# Docs: https://docs.saucelabs.com/web-apps/automated-testing/playwright/yaml/',
        '# Credentials are NOT stored here: saucectl reads SAUCE_USERNAME and SAUCE_ACCESS_KEY from the environment.',
        'apiVersion: v1alpha',
        'kind: playwright',
        'sauce:',
        '  region: us-west-1',
        '  concurrency: 2',
        'playwright:',
        '  version: package.json',
        `  configFile: ${configFile}`,
        'rootDir: ./',
        'suites:',
        ...unique.flatMap(b => [
            `  - name: ${JSON.stringify(suite[b].name)}`,
            `    platformName: ${JSON.stringify(suite[b].platform)}`,
            '    screenResolution: "1440x900"',
            '    params:',
            `      browserName: ${JSON.stringify(suite[b].browser)}`,
            ...(projects.has(suite[b].browser) ? [`      project: ${JSON.stringify(suite[b].browser)}`] : [])
        ]),
        'reporters:',
        '  spotlight:',
        '    enabled: true',
        ''
    ].join('\n');
}

export function lambdatestConfig(config: Config, browsers: Browser[], baseConfig: string, typescript: boolean, authState?: string): string {
    const signIn = authState
        ? `        // Signs in once on a cloud browser (tests/auth.setup); the other projects reuse the saved state.
        { name: 'setup', testMatch: /.*\\.setup\\.(ts|js)/, use: { browserName: 'chromium', connectOptions: lambdatest('Chrome', 'Windows 11') } },\n`
        : '';
    const reuse = authState ? `, storageState: '${authState}'` : '';
    const deps = authState ? ", dependencies: ['setup']" : '';
    const caps: Record<Browser, { name: string; browserName: string; platform: string; engine: string }> = {
        chromium: { name: 'lambdatest-chrome', browserName: 'Chrome', platform: 'Windows 11', engine: 'chromium' },
        edge: { name: 'lambdatest-edge', browserName: 'MicrosoftEdge', platform: 'Windows 11', engine: 'chromium' },
        firefox: { name: 'lambdatest-firefox', browserName: 'pw-firefox', platform: 'Windows 11', engine: 'firefox' },
        webkit: { name: 'lambdatest-webkit', browserName: 'pw-webkit', platform: 'MacOS Ventura', engine: 'webkit' }
    };
    const name = baseConfig.split('/').pop()!;
    const base = `./${typescript ? name.replace(/\.(ts|mts)$/, '') : name}`;
    return `// ${CREATED_HEADER}
${typescript ? '' : '// @ts-check\n'}// Runs the same tests on LambdaTest cloud browsers. Run: npm run test:lambdatest
// Docs: https://www.lambdatest.com/support/docs/playwright-testing/
// Credentials come from LT_USERNAME and LT_ACCESS_KEY in the environment (.env locally, secrets in CI); never put them here.
import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

import base from '${base}';

dotenv.config({ path: ['.env', '.env.example'], quiet: true });

function lambdatest(browserName${typescript ? ': string' : ''}, platform${typescript ? ': string' : ''}) {
    const capabilities = {
        browserName,
        browserVersion: 'latest',
        'LT:Options': {
            platform,
            build: process.env.LT_BUILD_NAME ?? 'testpilot',
            name: ${JSON.stringify(config.project.name ?? 'Web tests')},
            user: process.env.LT_USERNAME,
            accessKey: process.env.LT_ACCESS_KEY,
            network: false,
            video: true,
            console: true,
            // Set LT_TUNNEL=true and start the LambdaTest tunnel to reach localhost or an internal test site.
            tunnel: process.env.LT_TUNNEL === 'true'
        }
    };
    return { wsEndpoint: \`wss://cdp.lambdatest.com/playwright?capabilities=\${encodeURIComponent(JSON.stringify(capabilities))}\` };
}

export default defineConfig({
    ...base,
    // Cloud runs share your plan's parallel sessions.
    workers: 2,
    projects: [
${signIn}${browsers.map(b => `        { name: '${caps[b].name}', use: { browserName: '${caps[b].engine}', connectOptions: lambdatest('${caps[b].browserName}', '${caps[b].platform}')${reuse} }${deps} },`).join('\n')}
    ]
});
`;
}

export function planCloudGrid(store: ProjectStore, config: Config, providerArg?: CloudProvider): PlanOutcome {
    const lang = playwrightLang(config, 'Cloud browser runs');
    if ('error' in lang) return lang;
    if (config.appType && config.appType !== 'web') return { error: `Cloud browser grids run web tests. This project is ${config.appType}${['android', 'ios', 'android-ios', 'hybrid'].includes(config.appType) ? '; mobile cloud runs are set up by the Appium template (wdio.browserstack.conf.ts)' : ''}.` };
    const target = config.execution.target;
    const provider: CloudProvider = providerArg ?? (target === 'saucelabs' || target === 'lambdatest' || target === 'browserstack' ? target : 'browserstack');
    const browsers = cloudBrowsers(config);
    const configFile = findPlaywrightConfig(store, config);
    if (!configFile) return { error: 'No playwright.config in the test folder yet. Run scaffold_project first.' };
    const configName = configFile.split('/').pop()!;
    const label = LABEL[provider];
    const plan: CapabilityPlan = emptyPlan(
        'cloud-grid',
        `Run on ${label}`,
        `Runs the same Playwright tests on ${label} cloud browsers (${browsers.join(', ')}), without changing the tests. Your keys stay in .env; config files only name the environment variables.`,
        `Set up ${label} cloud runs for ${browsers.join(', ')}`
    );
    const keys = INTEGRATION_KEYS[provider];
    if (provider === 'browserstack') {
        plan.files.push(compareWithDisk(store, inTestRoot(config, 'browserstack.yml'), browserstackYml(config, browsers)));
        plan.files.push(planPackageAdditions(store, config, { 'browserstack-node-sdk': BROWSERSTACK_SDK_VERSION }, { 'test:browserstack': 'npx browserstack-node-sdk playwright test' }));
        plan.notes.push('Run `npm run test:browserstack`. Results and videos appear in BrowserStack Automate. browserstackLocal: true lets cloud browsers reach a site that is only on your machine or network.');
    } else if (provider === 'saucelabs') {
        plan.files.push(compareWithDisk(store, inTestRoot(config, '.sauce/config.yml'), sauceConfig(config, browsers, configName)));
        plan.files.push(planPackageAdditions(store, config, { saucectl: SAUCECTL_VERSION }, { 'test:saucelabs': 'saucectl run' }));
        plan.notes.push('Run `npm run test:saucelabs`. saucectl uploads the tests and runs them in Sauce Labs. For a site only reachable inside your network, start Sauce Connect and add `tunnel: { name: <tunnel name> }` under `sauce:` in .sauce/config.yml.');
        plan.notes.push('Sauce Labs uses US West by default; change `region` in .sauce/config.yml to eu-central-1 if your account is in the EU.');
    } else {
        const file = inTestRoot(config, `playwright.lambdatest.config.${lang.ext}`);
        plan.files.push(compareWithDisk(store, file, lambdatestConfig(config, browsers, configFile, lang.typescript, authStateOf(store, config))));
        plan.files.push(planPackageAdditions(store, config, {}, { 'test:lambdatest': `playwright test --config=${file.split('/').pop()}` }));
        plan.notes.push('Run `npm run test:lambdatest`. Each project connects to a LambdaTest browser over Playwright\'s connectOptions. For a site only reachable inside your network, start the LambdaTest tunnel and set LT_TUNNEL=true in .env.');
    }
    plan.files.push(planEnvExample(store, keys));
    if (plan.files.some(f => f.path.endsWith('package.json') && f.status !== 'unchanged')) plan.install.push(['npm', 'install']);
    plan.notes.push(`Put ${keys.map(k => k.name).join(' and ')} in .env (never in chat). In CI, add them as a variable and a secret.`);
    plan.data = { provider, browsers };
    return plan;
}

/** The saved sign-in state browser projects use, when log-in-once is set up in playwright.config. */
function authStateOf(store: ProjectStore, config: Config): string | undefined {
    const file = findPlaywrightConfig(store, config);
    const content = file ? store.read(file) : undefined;
    if (!content || !/name:\s*'setup'/.test(content)) return undefined;
    return content.match(/storageState:\s*'([^']+)'/)?.[1];
}
