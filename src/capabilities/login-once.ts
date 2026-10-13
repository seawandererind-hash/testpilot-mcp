import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot, planGitignore, type PlannedFile } from '../scaffold/engine.js';
import { type CapabilityPlan, emptyPlan, findPlaywrightConfig, type Lang, lineDiff, type PlanOutcome, playwrightLang, relativeModule } from './shared.js';

export const AUTH_DIR = 'playwright/.auth';
const SETUP_PROJECT = `{ name: 'setup', testMatch: /.*\\.setup\\.(ts|js)/ },`;

export const SSO_NOTE =
    'Single sign-on or MFA: use dedicated test accounts with MFA turned off in the test environment, or keep a TOTP secret for the test account in .env and generate the one-time code in tests/auth.setup with a TOTP library. Never automate a real person\'s account.';

/** Roles listed in test-data/users.json (only names of .env keys live there). */
export function readRoles(store: ProjectStore, config: Config): { roles: string[]; error?: string } {
    const file = inTestRoot(config, 'test-data/users.json');
    const raw = store.read(file);
    if (raw === undefined) return { roles: [], error: `${file} is missing.` };
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const roles = Object.keys(parsed).filter(k => /^[A-Za-z0-9_-]{1,40}$/.test(k));
        return roles.length ? { roles } : { roles: [], error: `${file} lists no roles.` };
    } catch {
        return { roles: [], error: `${file} is not valid JSON.` };
    }
}

/** The page object with a loginAs(role) method that generate_tests writes, when it exists. */
function findLoginPage(store: ProjectStore, config: Config, lang: Lang): string | undefined {
    const file = inTestRoot(config, `src/pages/LoginPage.${lang.ext}`);
    const content = store.read(file);
    return content && /\basync\s+loginAs\s*\(/.test(content) ? file : undefined;
}

export function authSetupFile(config: Config, lang: Lang, roles: string[], loginPage: string | undefined): { path: string; content: string } {
    const file = inTestRoot(config, `tests/auth.setup.${lang.ext}`);
    const ts = lang.typescript;
    const head = [
        `// ${CREATED_HEADER}`,
        '// Signs in once per role from test-data/users.json and saves the browser state (cookies and local storage)',
        `// to ${AUTH_DIR}/<role>.json. Browser projects in playwright.config depend on the "setup" project, so every`,
        '// test starts already signed in instead of filling the login form again.',
        '//',
        '// Tests that check the sign-in page itself should start signed out. Put this at the top of that spec:',
        "//     test.use({ storageState: { cookies: [], origins: [] } });",
        `// A test that needs another role: test.use({ storageState: '${AUTH_DIR}/admin.json' });`,
        '//',
        `// ${SSO_NOTE}`,
        ...(ts ? [] : ['// @ts-check']),
        ...(loginPage ? [] : ["import { readFileSync } from 'node:fs';"]),
        "import path from 'node:path';",
        '',
        "import { expect, test as setup } from '@playwright/test';",
        ''
    ];
    const ext = !ts;
    const body: string[] = [];
    if (loginPage) body.push(`import { LoginPage } from '${relativeModule(file, loginPage, ext)}';`, '');
    body.push(`/** Roles from test-data/users.json when this file was created. Add a role there and here together. */`);
    body.push(`const ROLES = ${JSON.stringify(roles).replace(/"/g, "'").replace(/,/g, ', ')};`, '');
    body.push(`/** Where the saved state of a role lives, next to playwright.config. */`);
    body.push(`function authFile(role${ts ? ': string' : ''})${ts ? ': string' : ''} {`);
    body.push(`    const root = setup.info().config.configFile ? path.dirname(setup.info().config.configFile${ts ? '!' : ''}) : process.cwd();`);
    body.push(`    return path.join(root, '${AUTH_DIR}', \`\${role}.json\`);`);
    body.push('}', '');
    if (!loginPage) {
        body.push(
            '/** Credentials for a role: users.json holds the names of .env keys; the values come from .env or CI secrets. */',
            `function credentials(role${ts ? ': string' : ''})${ts ? ': { username: string; password: string }' : ''} {`,
            `    const root = setup.info().config.configFile ? path.dirname(setup.info().config.configFile${ts ? '!' : ''}) : process.cwd();`,
            `    const users = JSON.parse(readFileSync(path.join(root, 'test-data', 'users.json'), 'utf8'))${ts ? ' as Record<string, { usernameEnv?: string; emailEnv?: string; passwordEnv: string }>' : ''};`,
            '    const entry = users[role];',
            "    const userKey = entry?.usernameEnv ?? entry?.emailEnv ?? 'TEST_USER_EMAIL';",
            "    const username = process.env[userKey];",
            '    const password = entry ? process.env[entry.passwordEnv] : undefined;',
            "    if (!username || !password) throw new Error(`Missing credentials for role \"${role}\". Fill in ${userKey} and ${entry?.passwordEnv ?? 'its password key'} in .env (CI: add them as secrets).`);",
            '    return { username, password };',
            '}',
            ''
        );
    }
    body.push('for (const role of ROLES) {');
    body.push('    setup(`sign in as ${role}`, async ({ page }) => {');
    if (loginPage) {
        body.push('        await new LoginPage(page).loginAs(role);');
    } else {
        body.push(
            '        const user = credentials(role);',
            "        // TODO(testpilot): no LoginPage with loginAs() yet. Check these steps against your sign-in page,",
            '        // or generate a login test first (generate_tests) and replace them with new LoginPage(page).loginAs(role).',
            "        await page.goto('/');",
            '        await page.getByLabel(/e-?mail|user ?name/i).fill(user.username);',
            '        await page.getByLabel(/password/i).fill(user.password);',
            "        await page.getByRole('button', { name: /sign in|log ?in/i }).click();"
        );
    }
    body.push(
        '        // Wait until the app shows it is signed in before saving, so the saved state includes the session.',
        '        // TODO(testpilot): a stronger check is something only signed-in users see, e.g.',
        "        //     await expect(page.getByRole('button', { name: /sign out|log ?out/i })).toBeVisible();",
        "        await expect(page).not.toHaveURL(/\\/(login|sign-?in)\\b/i);",
        '        await page.context().storageState({ path: authFile(role) });',
        '    });',
        '}',
        ''
    );
    return { path: file, content: [...head, ...body].join('\n') };
}

/**
 * Adds the setup project and storageState to a playwright.config that still has
 * the TestPilot template shape. Returns undefined when the file was edited too
 * much to patch safely.
 */
export function patchPlaywrightConfig(content: string, defaultRole: string): { content: string; changed: boolean } | undefined {
    if (!content.includes(CREATED_HEADER) || !/export default defineConfig\(\{/.test(content) || !/^\s*projects:\s*\[/m.test(content)) return undefined;
    if (/name:\s*'setup'/.test(content)) return { content, changed: false };
    const browserLine = /^(\s*)\{ name: '([^']+)', use: \{ \.\.\.devices\['([^']+)'\] \} \},?[ \t]*$/gm;
    const matches = [...content.matchAll(browserLine)];
    if (!matches.length) return undefined;
    let out = content.replace(browserLine, (_line, indent: string, name: string, device: string) => `${indent}{ name: '${name}', use: { ...devices['${device}'], storageState: '${AUTH_DIR}/${defaultRole}.json' }, dependencies: ['setup'] },`);
    const first = matches[0];
    out = out.replace(/^(\s*)projects:\s*\[\s*\n/m, (m, indent: string) => `${m}${first[1]}// Signs in once per role and saves the state; browser projects reuse it (tests/auth.setup).\n${first[1]}${SETUP_PROJECT}\n`);
    return { content: out, changed: true };
}

export function configSnippet(defaultRole: string): string {
    return [
        '// In playwright.config, inside defineConfig({ ... }):',
        'projects: [',
        `    ${SETUP_PROJECT}`,
        '    {',
        "        name: 'chromium',",
        `        use: { ...devices['Desktop Chrome'], storageState: '${AUTH_DIR}/${defaultRole}.json' },`,
        "        dependencies: ['setup']",
        '    },',
        '    // Repeat storageState and dependencies for every other browser project.',
        '],'
    ].join('\n');
}

export function planLoginOnce(store: ProjectStore, config: Config): PlanOutcome {
    const lang = playwrightLang(config, 'Log in once');
    if ('error' in lang) return lang;
    if (config.appType && config.appType !== 'web') {
        return { error: `Log in once saves a signed-in browser state, which applies to web apps. This project is ${config.appType}. ${config.appType === 'api' ? 'For APIs, send API_TOKEN from .env with every request (playwright.config already does this).' : 'Sign in through a fixture that runs once per worker instead.'}` };
    }
    const { roles, error } = readRoles(store, config);
    if (error) return { error: `${error} Run scaffold_project first, or create test-data/users.json with one entry per role, e.g. {"standard": {"emailEnv": "TEST_USER_EMAIL", "passwordEnv": "TEST_USER_PASSWORD"}}.` };
    const defaultRole = roles.includes('standard') ? 'standard' : roles[0];
    const loginPage = findLoginPage(store, config, lang);
    const plan: CapabilityPlan = emptyPlan(
        'login-once',
        'Log in once, reuse everywhere',
        `Tests will sign in once per role (${roles.join(', ')}) before the run and reuse the saved browser state, instead of filling the login form in every test. Saved states go to ${inTestRoot(config, AUTH_DIR)}/, which git ignores because it holds live session cookies.`,
        `Added log-in-once: a setup project signs in as ${roles.join(', ')} and browser tests reuse ${AUTH_DIR}/${defaultRole}.json`
    );
    const setup = authSetupFile(config, lang, roles, loginPage);
    plan.files.push(compareWithDisk(store, setup.path, setup.content));
    if (!loginPage) plan.notes.push(`No LoginPage with a loginAs() method was found, so ${setup.path} fills the sign-in form with general locators and a TODO. Check them against your sign-in page (or generate a login test first and rerun this).`);
    const configFile = findPlaywrightConfig(store, config);
    const current = configFile ? store.read(configFile) : undefined;
    const patched = current !== undefined ? patchPlaywrightConfig(current, defaultRole) : undefined;
    if (configFile && current !== undefined && patched) {
        if (patched.changed) {
            const file: PlannedFile = { path: configFile, status: 'merge', content: patched.content, note: `Adds the "setup" project and makes browser projects reuse ${AUTH_DIR}/${defaultRole}.json.` };
            plan.files.push(file);
            plan.diffs.push({ path: configFile, diff: lineDiff(current, patched.content) });
        }
    } else if (current !== undefined && /name:\s*['"]setup['"]/.test(current)) {
        plan.notes.push(`${configFile} already has a "setup" project. Check that browser projects have dependencies: ['setup'] and use.storageState: '${AUTH_DIR}/${defaultRole}.json'.`);
    } else {
        plan.snippets.push({ title: `${configFile ?? 'playwright.config'} was changed by hand, so TestPilot will not edit it. Paste this into it:`, content: configSnippet(defaultRole) });
    }
    plan.files.push(planGitignore(store, [`${inTestRoot(config, AUTH_DIR)}/`]));
    plan.notes.push(SSO_NOTE);
    plan.notes.push(`Run it: \`npx playwright test\` runs the setup project first. Check it alone with \`npx playwright test --project=setup\`.`);
    plan.data = { roles, defaultRole, loginPage: loginPage ?? null, configPatched: Boolean(patched?.changed) };
    return plan;
}
