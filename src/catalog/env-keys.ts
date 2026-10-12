import type { Config } from '../core/schema.js';

export type KeyFormat = 'url' | 'email' | 'nonempty' | 'number';

export interface EnvKey {
    name: string;
    description: string;
    whereToGet: string;
    format: KeyFormat;
    required: boolean;
    secret: boolean;
}

/** Keys each integration needs. Values never pass through the AI; only presence and format are reported. */
export const INTEGRATION_KEYS: Record<string, EnvKey[]> = {
    app: [
        { name: 'APP_BASE_URL', description: 'Address of the test environment, e.g. https://staging.example.com', whereToGet: 'TestPilot fills this in .env.example when you give the test URL in the app step. Put a different address in .env to override it. Never use production.', format: 'url', required: false, secret: false },
        { name: 'TEST_USER_EMAIL', description: 'Login of a test account', whereToGet: 'A dedicated test user created for automation.', format: 'nonempty', required: false, secret: false },
        { name: 'TEST_USER_PASSWORD', description: 'Password of that test account', whereToGet: 'From your team password manager.', format: 'nonempty', required: false, secret: true }
    ],
    browserstack: [
        { name: 'BROWSERSTACK_USERNAME', description: 'BrowserStack username', whereToGet: 'BrowserStack → Account → Settings → Access key section.', format: 'nonempty', required: true, secret: false },
        { name: 'BROWSERSTACK_ACCESS_KEY', description: 'BrowserStack access key', whereToGet: 'Same page as the username.', format: 'nonempty', required: true, secret: true }
    ],
    saucelabs: [
        { name: 'SAUCE_USERNAME', description: 'Sauce Labs username', whereToGet: 'Sauce Labs → User settings.', format: 'nonempty', required: true, secret: false },
        { name: 'SAUCE_ACCESS_KEY', description: 'Sauce Labs access key', whereToGet: 'Sauce Labs → User settings.', format: 'nonempty', required: true, secret: true }
    ],
    lambdatest: [
        { name: 'LT_USERNAME', description: 'LambdaTest username', whereToGet: 'LambdaTest → Profile → Password & Security.', format: 'nonempty', required: true, secret: false },
        { name: 'LT_ACCESS_KEY', description: 'LambdaTest access key', whereToGet: 'Same page.', format: 'nonempty', required: true, secret: true }
    ],
    grid: [{ name: 'SELENIUM_GRID_URL', description: 'URL of your Selenium Grid hub', whereToGet: 'Your infrastructure team.', format: 'url', required: true, secret: false }],
    jira: [
        { name: 'JIRA_BASE_URL', description: 'Your Jira site, e.g. https://yourcompany.atlassian.net', whereToGet: 'The address you use to open Jira.', format: 'url', required: true, secret: false },
        { name: 'JIRA_EMAIL', description: 'The email you log in to Jira with', whereToGet: 'Your Atlassian account email.', format: 'email', required: true, secret: false },
        { name: 'JIRA_API_TOKEN', description: 'Jira API token (expires within 365 days)', whereToGet: 'https://id.atlassian.com/manage-profile/security/api-tokens → Create API token.', format: 'nonempty', required: true, secret: true },
        { name: 'JIRA_PROJECT_KEY', description: 'Key of the Jira project, e.g. SHOP', whereToGet: 'The prefix of your issue keys.', format: 'nonempty', required: false, secret: false }
    ],
    xray: [
        { name: 'XRAY_CLIENT_ID', description: 'Xray Cloud API client id', whereToGet: 'Jira → Apps → Xray → API Keys (needs Xray admin).', format: 'nonempty', required: true, secret: false },
        { name: 'XRAY_CLIENT_SECRET', description: 'Xray Cloud API client secret', whereToGet: 'Same page as the client id.', format: 'nonempty', required: true, secret: true }
    ],
    zephyr: [{ name: 'ZEPHYR_API_TOKEN', description: 'Zephyr API access token', whereToGet: 'Jira → your profile → Zephyr API Access Tokens.', format: 'nonempty', required: true, secret: true }],
    testrail: [
        { name: 'TESTRAIL_URL', description: 'Your TestRail address', whereToGet: 'e.g. https://yourcompany.testrail.io', format: 'url', required: true, secret: false },
        { name: 'TESTRAIL_USER', description: 'TestRail login email', whereToGet: 'Your TestRail account.', format: 'email', required: true, secret: false },
        { name: 'TESTRAIL_API_KEY', description: 'TestRail API key', whereToGet: 'TestRail → My Settings → API Keys (API must be enabled by an admin).', format: 'nonempty', required: true, secret: true },
        { name: 'TESTRAIL_PROJECT_ID', description: 'Numeric TestRail project id', whereToGet: 'In the project URL: index.php?/projects/overview/<id>', format: 'number', required: false, secret: false }
    ],
    'azure-devops': [
        { name: 'AZDO_ORG_URL', description: 'Azure DevOps organisation URL, e.g. https://dev.azure.com/yourorg', whereToGet: 'The address of your Azure DevOps organisation.', format: 'url', required: true, secret: false },
        { name: 'AZDO_PROJECT', description: 'Project name', whereToGet: 'The project that holds your test plans.', format: 'nonempty', required: true, secret: false },
        { name: 'AZDO_PAT', description: 'Organisation-scoped personal access token with Test Management read & write', whereToGet: 'User settings → Personal access tokens. Global PATs stop working on 1 Dec 2026.', format: 'nonempty', required: true, secret: true }
    ],
    'browserstack-tm': [
        { name: 'BROWSERSTACK_USERNAME', description: 'BrowserStack username', whereToGet: 'BrowserStack → Account → Settings.', format: 'nonempty', required: true, secret: false },
        { name: 'BROWSERSTACK_ACCESS_KEY', description: 'BrowserStack access key', whereToGet: 'Same page.', format: 'nonempty', required: true, secret: true },
        { name: 'BROWSERSTACK_TM_PROJECT_ID', description: 'Test Management project id, e.g. PR-1', whereToGet: 'In the Test Management project URL.', format: 'nonempty', required: false, secret: false }
    ],
    mobile: [
        { name: 'APPIUM_SERVER_URL', description: 'Appium server address for local runs', whereToGet: 'Usually http://127.0.0.1:4723 after running `appium`.', format: 'url', required: false, secret: false }
    ],
    api: [
        { name: 'API_BASE_URL', description: 'Base URL of the API under test', whereToGet: 'TestPilot fills this in .env.example when you give the API address in the app step. Put a different one in .env to override it.', format: 'url', required: false, secret: false },
        { name: 'API_TOKEN', description: 'Token for the API, if it needs one', whereToGet: 'Your developers or the API\'s developer portal. Use a test-environment token.', format: 'nonempty', required: false, secret: true }
    ]
};

/** Which integrations the current configuration needs keys for. */
export function integrationsFor(config: Config): string[] {
    const out = new Set<string>();
    if (config.appType === 'api') out.add('api');
    else out.add('app');
    if (config.appType && ['android', 'ios', 'android-ios', 'hybrid', 'windows', 'macos'].includes(config.appType)) out.add('mobile');
    const target = config.execution.target;
    if (target && target !== 'local' && target !== 'docker') out.add(target);
    const source = config.integrations.testCaseSource;
    if (source === 'jira') out.add('jira');
    if (source === 'xray') {
        out.add('jira');
        out.add('xray');
    }
    if (source === 'zephyr') {
        out.add('jira');
        out.add('zephyr');
    }
    if (source === 'browserstack') out.add('browserstack-tm');
    if (source === 'testrail') out.add('testrail');
    if (source === 'azure-devops') out.add('azure-devops');
    return [...out];
}

/** True when the key is a non-secret setting whose default may live in the committed .env.example. */
export function isSetting(name: string): boolean {
    return Object.values(INTEGRATION_KEYS).some(keys => keys.some(k => k.name === name && !k.secret));
}

export function keysFor(integrations: string[]): EnvKey[] {
    const seen = new Map<string, EnvKey>();
    for (const integration of integrations) {
        for (const key of INTEGRATION_KEYS[integration] ?? []) if (!seen.has(key.name)) seen.set(key.name, key);
    }
    return [...seen.values()];
}
