import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { fastWorkflow, planCiSpeed } from '../src/capabilities/ci-speed.js';
import { cloudBrowsers, planCloudGrid } from '../src/capabilities/cloud-grid.js';
import { COMPANION_VERSIONS, mergeMcpConfig, planCompanions, recommendCompanions } from '../src/capabilities/companions.js';
import { planToken } from '../src/capabilities/index.js';
import { patchPlaywrightConfig, planLoginOnce } from '../src/capabilities/login-once.js';
import { describeApi, lit, MAX_ENDPOINTS, parseDocument, planOpenApi } from '../src/capabilities/openapi.js';
import { checkPolicy, extractTests, parsePolicy, planOrgPolicy, POLICY_FILE } from '../src/capabilities/org-policy.js';
import { ibanValid, luhnValid, mask, scanCases, scanText } from '../src/capabilities/pii.js';
import type { CapabilityPlan } from '../src/capabilities/shared.js';
import { lineDiff } from '../src/capabilities/shared.js';
import { planTestData } from '../src/capabilities/test-data.js';
import { type Config, ConfigSchema, type TestCase } from '../src/core/schema.js';
import { ProjectStore } from '../src/core/store.js';
import { CREATED_HEADER } from '../src/scaffold/engine.js';
import { answerWebSetup, connect, tempRepo } from './helpers.js';

const webConfig = (extra: Record<string, unknown> = {}): Config =>
    ConfigSchema.parse({ appType: 'web', stack: { framework: 'playwright', language: 'typescript', pattern: 'pom', templatePack: 'playwright-ts' }, execution: { target: 'local', browsers: ['chromium'] }, integrations: { ci: 'github-actions', reporting: ['html', 'junit'] }, ...extra });

function repo(config: Config, files: Record<string, string> = {}): ProjectStore {
    const store = new ProjectStore(tempRepo(files));
    store.writeConfig(config);
    return store;
}

function ok(outcome: CapabilityPlan | { error: string }): CapabilityPlan {
    if ('error' in outcome) throw new Error(outcome.error);
    return outcome;
}

const file = (plan: CapabilityPlan, p: string) => plan.files.find(f => f.path === p);

const TEMPLATE_CONFIG = `// ${CREATED_HEADER}
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    use: {
        baseURL: process.env.APP_BASE_URL,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ]
});
`;

const USERS = JSON.stringify({ standard: { emailEnv: 'TEST_USER_EMAIL', passwordEnv: 'TEST_USER_PASSWORD' }, admin: { emailEnv: 'ADMIN_EMAIL', passwordEnv: 'ADMIN_PASSWORD' } });

describe('add_capability through MCP', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('previews login-once with a config diff, refuses without approval, then writes and records the decision', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerWebSetup(c, root);
        const scaffold = await c.call('preview_scaffold');
        expect((await c.call('scaffold_project', { confirmToken: scaffold.structuredContent.confirmToken, userApproved: true })).isError).toBeFalsy();

        const preview = await c.call('add_capability', { capability: 'login-once' });
        expect(preview.isError).toBeFalsy();
        expect(preview.content[0].text).toContain('Changes to playwright.config.ts:');
        expect(preview.content[0].text).toMatch(/\+ .*storageState: 'playwright\/\.auth\/standard\.json' \}, dependencies: \['setup'\]/);
        expect(preview.content[0].text).toContain('MFA');
        expect(existsSync(path.join(root, 'tests/auth.setup.ts'))).toBe(false);
        const token = preview.structuredContent.confirmToken;
        expect(token).toMatch(/^cap-login-once-/);

        const refused = await c.call('add_capability', { capability: 'login-once', confirmToken: token });
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain('Approval needed');
        expect((await c.call('add_capability', { capability: 'login-once', confirmToken: 'cap-login-once-nope', userApproved: true })).isError).toBe(true);

        const done = await c.call('add_capability', { capability: 'login-once', confirmToken: token, userApproved: true, approver: 'Surya' });
        expect(done.isError).toBeFalsy();
        const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
        expect(config).toContain("{ name: 'setup', testMatch: /.*\\.setup\\.(ts|js)/ },");
        expect(config).toContain("dependencies: ['setup']");
        expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('playwright/.auth/');
        const setup = readFileSync(path.join(root, 'tests/auth.setup.ts'), 'utf8');
        expect(setup).toContain("const ROLES = ['standard'];");
        expect(setup).toContain('TODO(testpilot)');
        expect(readFileSync(path.join(root, '.testpilot/decisions.md'), 'utf8')).toMatch(/log-in-once.*Surya/);

        const again = await c.call('add_capability', { capability: 'login-once' });
        expect(again.content[0].text).toContain('already in place');
    });

    it('re-checks the saved company policy without asking again and writes the report', async () => {
        const root = tempRepo({ 'policy.yaml': 'name: Demo rules\nallowedLanguages: [typescript]\nforbidden: [waitForTimeout]\n', 'tests/a.spec.ts': "test('SHOP-1 ok', async ({ page }) => { await page.waitForTimeout(500); });\n" });
        const c = await connect(root, 'modern');
        close = c.close;
        await answerWebSetup(c, root);
        const preview = await c.call('add_capability', { capability: 'org-policy', policy: 'policy.yaml' });
        expect(preview.structuredContent.files.map((f: { path: string }) => f.path)).toEqual([POLICY_FILE, '.testpilot/org-policy.source']);
        const applied = await c.call('add_capability', { capability: 'org-policy', policy: 'policy.yaml', confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        expect(applied.isError).toBeFalsy();
        expect(readFileSync(path.join(root, '.testpilot/org-policy.source'), 'utf8').trim()).toBe('policy.yaml');
        const report = readFileSync(path.join(root, '.testpilot/reports/policy.md'), 'utf8');
        expect(report).toContain('| Forbidden: waitForTimeout | **fail** | Found 1 time(s): tests/a.spec.ts:1');
        expect(report).toContain('| Allowed languages | pass |');

        writeFileSync(path.join(root, 'tests/a.spec.ts'), "test('SHOP-1 ok', async ({ page }) => { await page.goto('/'); });\n");
        const recheck = await c.call('add_capability', { capability: 'org-policy' });
        expect(recheck.isError).toBeFalsy();
        expect(recheck.structuredContent.confirmToken).toBeUndefined();
        expect(readFileSync(path.join(root, '.testpilot/reports/policy.md'), 'utf8')).toContain('**All 2 rule(s) pass.**');
    });

    it('explains instead of writing code for stacks other than Playwright TypeScript/JavaScript', async () => {
        const root = tempRepo();
        const store = new ProjectStore(root);
        store.writeConfig(webConfig({ stack: { framework: 'selenium', language: 'java', pattern: 'pom' } }));
        const c = await connect(root, 'legacy');
        close = c.close;
        for (const capability of ['login-once', 'test-data', 'ci-speed', 'cloud-grid']) {
            const res = await c.call('add_capability', { capability });
            expect(res.isError, capability).toBe(true);
            expect(res.content[0].text).toMatch(/Playwright/);
        }
    });
});

describe('login-once', () => {
    it('patches a template-shaped config once, keeping everything else', () => {
        const once = patchPlaywrightConfig(TEMPLATE_CONFIG, 'standard')!;
        expect(once.changed).toBe(true);
        expect(once.content).toContain("{ name: 'firefox', use: { ...devices['Desktop Firefox'], storageState: 'playwright/.auth/standard.json' }, dependencies: ['setup'] },");
        expect(once.content).toContain("testDir: './tests'");
        expect(patchPlaywrightConfig(once.content, 'standard')).toEqual({ content: once.content, changed: false });
        expect(patchPlaywrightConfig(TEMPLATE_CONFIG.replace(CREATED_HEADER, 'my own config'), 'standard')).toBeUndefined();
    });

    it('gives a snippet for a hand-written config and uses LoginPage.loginAs when it exists', () => {
        const store = repo(webConfig(), {
            'playwright.config.ts': "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ projects: [{ name: 'chromium' }] });\n",
            'test-data/users.json': USERS,
            'src/pages/LoginPage.ts': 'export class LoginPage {\n    async loginAs(role = "standard") {}\n}\n'
        });
        const plan = ok(planLoginOnce(store, store.readConfig()));
        expect(file(plan, 'playwright.config.ts')).toBeUndefined();
        expect(plan.snippets[0].content).toContain("dependencies: ['setup']");
        const setup = file(plan, 'tests/auth.setup.ts')!.content;
        expect(setup).toContain("import { LoginPage } from '../src/pages/LoginPage';");
        expect(setup).toContain('await new LoginPage(page).loginAs(role);');
        expect(setup).toContain("const ROLES = ['standard', 'admin'];");
        expect(setup).not.toContain('readFileSync');
    });

    it('writes JavaScript with .js imports for JavaScript projects and refuses non-web apps', () => {
        const store = repo(webConfig({ stack: { framework: 'playwright', language: 'javascript', templatePack: 'playwright-js' } }), { 'test-data/users.json': USERS, 'src/pages/LoginPage.js': 'class LoginPage { async loginAs(role) {} }' });
        const plan = ok(planLoginOnce(store, store.readConfig()));
        const setup = file(plan, 'tests/auth.setup.js')!.content;
        expect(setup).toContain("import { LoginPage } from '../src/pages/LoginPage.js';");
        expect(setup).not.toMatch(/: string/);
        const api = repo(webConfig({ appType: 'api' }), { 'test-data/users.json': USERS });
        expect(planLoginOnce(api, api.readConfig())).toHaveProperty('error');
    });
});

describe('personal-data scan', () => {
    it('validates card numbers with Luhn and IBANs with mod-97', () => {
        expect(luhnValid('4111111111111111')).toBe(true);
        expect(luhnValid('4111111111111112')).toBe(false);
        expect(luhnValid('1234')).toBe(false);
        expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
        expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    });

    it('finds real-looking personal data, ignores test data, and masks every value', () => {
        const text = 'Log in as jane.doe@gmail.com or qa@example.com, pay with 4111 1111 1111 1111 (not 4111 1111 1111 1112), IBAN DE89370400440532013000, SSN 123-45-6789, call +44 20 7946 0958, order 2026-10-12';
        const hits = scanText(text);
        expect(hits.map(h => h.kind).sort()).toEqual(['card-number', 'email', 'iban', 'national-id', 'phone']);
        const all = JSON.stringify(hits);
        for (const secret of ['jane.doe@gmail.com', 'gmail', '4111 1111 1111 1111', 'DE89370400440532013000', '123-45-6789', '7946 0958']) expect(all).not.toContain(secret);
        expect(mask('4111 1111 1111 1111', 'card-number')).toBe('**** **** **** **11');
        expect(mask('jane.doe@gmail.com', 'email')).toBe('j***@***.com');
        expect(scanText('Use qa@example.com and test@shop.test with password Secret1')).toEqual([]);
    });

    it('reports case ids and fields in the test-data preview', () => {
        const store = repo(webConfig());
        const tc: TestCase = { id: 'SHOP-9', title: 'Checkout', preconditions: ['Customer bob@company.co.uk exists'], steps: [{ action: 'Enter card', data: '5555 5555 5555 4444' }], tags: [], source: { type: 'csv', importedAt: '2026-10-12T00:00:00Z' } };
        store.writeCase(tc);
        expect(scanCases([tc]).map(f => [f.caseId, f.field, f.kind])).toEqual([
            ['SHOP-9', 'preconditions[1]', 'email'],
            ['SHOP-9', 'steps[1].data', 'card-number']
        ]);
        const plan = ok(planTestData(store, store.readConfig()));
        const note = plan.notes.find(n => n.startsWith('Personal-data check'))!;
        expect(note).toContain('SHOP-9: email in preconditions[1] (b***@***.uk); card-number in steps[1].data (**** **** **** **44)');
        expect(note).not.toContain('bob@company');
    });
});

describe('test-data', () => {
    it('writes the factory, the seeding fixture and adds faker to package.json', () => {
        const store = repo(webConfig(), { 'src/fixtures/test.ts': '// fixtures' });
        const plan = ok(planTestData(store, store.readConfig()));
        const factory = file(plan, 'test-data/factory.ts')!.content;
        expect(factory).toContain("import { faker } from '@faker-js/faker';");
        expect(factory).toMatch(/export function uniqueId[\s\S]*RUN_ID[\s\S]*WORKER[\s\S]*counter/);
        for (const fn of ['buildUser', 'buildAddress', 'buildOrder', 'build<T extends object>']) expect(factory).toContain(`export function ${fn}(`);
        const fixture = file(plan, 'tests/fixtures/data.ts')!.content;
        expect(fixture).toContain("import { expect, test as base } from '../../src/fixtures/test';");
        expect(fixture).toContain('await seeder.cleanup();');
        const pkg = JSON.parse(file(plan, 'package.json')!.content);
        expect(pkg.devDependencies['@faker-js/faker']).toMatch(/^\d+\.\d+\.\d+$/);
        expect(plan.install).toEqual([['npm', 'install']]);
    });

    it('writes plain JavaScript for JavaScript projects', () => {
        const store = repo(webConfig({ stack: { framework: 'playwright', language: 'javascript' } }));
        const plan = ok(planTestData(store, store.readConfig()));
        const factory = file(plan, 'test-data/factory.js')!.content;
        expect(factory).not.toMatch(/interface |: string|Partial</);
        expect(file(plan, 'tests/fixtures/data.js')!.content).toContain("from '../../test-data/factory.js'");
    });
});

describe('ci-speed', () => {
    it('writes a GitHub workflow with changed-only PR runs, shards, blob reports and a merge job', () => {
        const store = repo(webConfig());
        const plan = ok(planCiSpeed(store, store.readConfig(), 3));
        const wf = YAML.parse(file(plan, '.github/workflows/ui-tests-pr.yml')!.content);
        const runs = (job: string) => wf.jobs[job].steps.map((s: { run?: string }) => s.run).filter(Boolean);
        expect(wf.on.pull_request).toBeNull();
        expect(wf.on.push.branches).toEqual(['main']);
        expect(wf.on.schedule[0].cron).toBe('0 2 * * *');
        expect(wf.jobs.changed.if).toBe("github.event_name == 'pull_request'");
        expect(wf.jobs.changed.steps[0].with['fetch-depth']).toBe(0);
        expect(runs('changed')).toContain('npx playwright test --only-changed=origin/${{ github.base_ref }} --pass-with-no-tests');
        expect(runs('changed').some((r: string) => r.includes('--grep @smoke'))).toBe(true);
        expect(wf.jobs.full.strategy.matrix).toEqual({ shardIndex: [1, 2, 3], shardTotal: [3] });
        expect(runs('full')).toContain('npx playwright test --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }} --reporter=blob');
        expect(wf.jobs.merge.needs).toEqual(['full']);
        expect(runs('merge')).toContain('npx playwright merge-reports --reporter html ./all-blob-reports');
        expect(wf.jobs.merge.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/download-artifact')).with['merge-multiple']).toBe(true);
        expect(wf.jobs.full.env.TEST_USER_PASSWORD).toBe('${{ secrets.TEST_USER_PASSWORD }}');
        expect(wf.jobs.full.env.APP_BASE_URL).toBe('${{ vars.APP_BASE_URL }}');
    });

    it('keeps paths inside a test sub-folder and gives commands for other CI systems', () => {
        const wf = YAML.parse(fastWorkflow({ shards: 2, testRoot: 'e2e', browsers: ['chromium'], variables: [], secrets: [] }));
        expect(wf.jobs.full.defaults.run['working-directory']).toBe('e2e');
        expect(wf.jobs.merge.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/download-artifact')).with.path).toBe('e2e/all-blob-reports');
        const store = repo(webConfig({ integrations: { ci: 'gitlab' } }));
        const plan = ok(planCiSpeed(store, store.readConfig(), 4));
        expect(plan.files).toEqual([]);
        expect(plan.snippets[0].content).toContain('--shard=$CI_NODE_INDEX/$CI_NODE_TOTAL');
        expect(plan.snippets[0].content).toContain('merge-reports');
    });
});

describe('cloud-grid', () => {
    const base = { 'playwright.config.ts': TEMPLATE_CONFIG };

    it('writes browserstack.yml with default platforms, an npm script and env key names only', () => {
        const store = repo(webConfig(), base);
        const plan = ok(planCloudGrid(store, store.readConfig()));
        const yml = YAML.parse(file(plan, 'browserstack.yml')!.content);
        expect(yml.framework).toBe('playwright');
        expect(yml.platforms.map((p: { browserName: string }) => p.browserName)).toEqual(['chrome', 'playwright-webkit', 'edge']);
        expect(yml).not.toHaveProperty('accessKey');
        const pkg = JSON.parse(file(plan, 'package.json')!.content);
        expect(pkg.scripts['test:browserstack']).toBe('npx browserstack-node-sdk playwright test');
        expect(file(plan, '.env.example')!.content).toMatch(/BROWSERSTACK_USERNAME=\n[\s\S]*BROWSERSTACK_ACCESS_KEY=\n/);
        expect(cloudBrowsers(webConfig({ execution: { browsers: ['chromium', 'firefox'] } }))).toEqual(['chromium', 'firefox']);
    });

    it('writes saucectl and LambdaTest configs', () => {
        const store = repo(webConfig(), base);
        const sauce = ok(planCloudGrid(store, store.readConfig(), 'saucelabs'));
        const yml = YAML.parse(file(sauce, '.sauce/config.yml')!.content);
        expect(yml.kind).toBe('playwright');
        expect(yml.playwright.configFile).toBe('playwright.config.ts');
        expect(yml.suites.map((s: { params: { browserName: string } }) => s.params.browserName)).toEqual(['chromium', 'webkit']);
        expect(JSON.parse(file(sauce, 'package.json')!.content).scripts['test:saucelabs']).toBe('saucectl run');
        const lt = ok(planCloudGrid(store, store.readConfig(), 'lambdatest'));
        const ltConfig = file(lt, 'playwright.lambdatest.config.ts')!.content;
        expect(ltConfig).toContain("import base from './playwright.config';");
        expect(ltConfig).toContain('wss://cdp.lambdatest.com/playwright?capabilities=');
        expect(ltConfig).toContain('process.env.LT_ACCESS_KEY');
        expect(file(lt, '.env.example')!.content).toContain('LT_USERNAME=');
    });
});

const PETSTORE = {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1' },
    servers: [{ url: 'http://localhost:4600/v1' }],
    paths: {
        '/pets': {
            get: { tags: ['pets'], summary: 'List pets', parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer', example: 5 } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } } },
            post: { tags: ['pets'], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { '201': { description: 'created' } } }
        },
        '/pets/{id}': { get: { tags: ['pets'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } }
    },
    components: { schemas: { Pet: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' }, born: { type: 'string', format: 'date' } } } } }
};

describe('openapi', () => {
    it('reads OpenAPI 3: runnable GETs, fixme writes with example bodies, skipped endpoints', () => {
        const api = describeApi(PETSTORE as never);
        const list = api.endpoints.find(e => e.method === 'get' && e.path === '/pets')!;
        expect(list.query).toEqual({ limit: 5 });
        expect(list.shape).toEqual({ type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } } });
        expect(api.endpoints.find(e => e.method === 'post')!.body).toEqual({ id: 1, name: 'example' });
        expect(api.skipped).toEqual([expect.objectContaining({ method: 'GET', path: '/pets/{id}' })]);
    });

    it('reads Swagger 2 and caps the number of endpoints', () => {
        const swagger = parseDocument(
            YAML.stringify({
                swagger: '2.0',
                info: { title: 'Old', version: '0.1' },
                produces: ['application/json'],
                paths: { '/users/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, type: 'integer', 'x-example': 7 }], responses: { 200: { schema: { $ref: '#/definitions/User' } } } } } },
                definitions: { User: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } }
            })
        );
        const api = describeApi(swagger);
        expect(api.kind).toBe('swagger2');
        expect(api.endpoints[0]).toMatchObject({ concretePath: '/users/7', contentType: 'application/json', shape: { type: 'object', required: ['email'] } });
        const many = { openapi: '3.1.0', info: {}, paths: Object.fromEntries(Array.from({ length: MAX_ENDPOINTS + 5 }, (_, i) => [`/r${i}`, { get: { responses: { '200': { description: 'ok' } } } }])) };
        const capped = describeApi(many as never);
        expect(capped.endpoints).toHaveLength(MAX_ENDPOINTS);
        expect(capped.skipped).toHaveLength(5);
        expect(() => describeApi({ info: {} })).toThrow(/not an OpenAPI/);
    });

    it('plans spec files, a client helper and refuses production-looking URLs', async () => {
        const store = repo(webConfig({ appType: 'api' }), { 'api/openapi.json': JSON.stringify(PETSTORE) });
        const plan = ok(await planOpenApi(store, store.readConfig(), 'api/openapi.json', false));
        const spec = file(plan, 'tests/api/pets.api.spec.ts')!.content;
        expect(spec).toContain("test('GET /pets: List pets', { tag: ['@api', '@openapi', '@pets'] }");
        expect(spec).toContain("await api.get('/pets', { limit: 5 });");
        expect(spec).toContain("await expectSuccess(response, 'application/json');");
        expect(spec).toContain('test.fixme(');
        expect(spec).not.toContain('/pets/{id}');
        expect(file(plan, 'tests/api/client.ts')!.content).toContain('export function shapeErrors(');
        expect(plan.data).toMatchObject({ getTests: 1, fixmeTests: 1 });

        const refused = await planOpenApi(store, store.readConfig(), 'https://api.shop.com/openapi.json', false, async () => new Response('{}'));
        expect(refused).toEqual({ error: expect.stringContaining('does not look like a test environment') });
        const fetched = ok(await planOpenApi(store, store.readConfig(), 'https://staging.shop.com/openapi.json', false, async () => new Response(JSON.stringify(PETSTORE))));
        expect(fetched.data.source).toBe('https://staging.shop.com/openapi.json');
        await expect(planOpenApi(store, store.readConfig(), '../outside.json', false)).rejects.toThrow(/outside the project/);
        expect(scanText('Aadhaar 2345 6789 0123')).toEqual([{ kind: 'national-id', masked: '**** **** **23' }]);
    });

    it('writes JavaScript literals in the project style', () => {
        expect(lit({ a: 1, 'b-c': ['x'], d: null })).toBe("{ a: 1, 'b-c': ['x'], d: null }");
    });
});

describe('companions', () => {
    it('recommends servers from the setup', () => {
        expect(recommendCompanions(webConfig())).toEqual(['playwright', 'github']);
        expect(recommendCompanions(webConfig({ appType: 'android', execution: { target: 'browserstack' }, integrations: { testCaseSource: 'xray', ci: 'gitlab' } }))).toEqual(['appium', 'browserstack', 'atlassian']);
    });

    it('merges servers without ever removing or changing existing ones', () => {
        const current = JSON.stringify({ mcpServers: { mine: { command: 'node' }, playwright: { command: 'custom' } }, other: true });
        const merged = mergeMcpConfig(current, 'mcpServers', { playwright: { command: 'npx' }, github: { url: 'x' } });
        if ('error' in merged) throw new Error(merged.error);
        const json = JSON.parse(merged.content);
        expect(json.other).toBe(true);
        expect(json.mcpServers.mine).toEqual({ command: 'node' });
        expect(json.mcpServers.playwright).toEqual({ command: 'custom' });
        expect(json.mcpServers.github).toEqual({ url: 'x' });
        expect(merged).toMatchObject({ added: ['github'], kept: ['playwright'] });
        expect(mergeMcpConfig('{oops', 'mcpServers', {})).toEqual({ error: 'not valid JSON' });
    });

    it('writes each AI tool its own entry shape with pinned versions and env references only', () => {
        const store = repo(webConfig({ integrations: { ci: 'github-actions', testCaseSource: 'jira' }, execution: { target: 'browserstack' } }), { '.cursor/mcp.json': JSON.stringify({ mcpServers: { testpilot: { command: 'npx' } } }), '.agents/mcp_config.json': '{ not json' });
        const plan = ok(planCompanions(store, store.readConfig()));
        const claude = JSON.parse(file(plan, '.mcp.json')!.content).mcpServers;
        expect(claude.playwright).toEqual({ type: 'stdio', command: 'npx', args: ['-y', `@playwright/mcp@${COMPANION_VERSIONS.playwright}`] });
        expect(claude.browserstack.env).toEqual({ BROWSERSTACK_USERNAME: '${BROWSERSTACK_USERNAME}', BROWSERSTACK_ACCESS_KEY: '${BROWSERSTACK_ACCESS_KEY}' });
        expect(claude.atlassian).toEqual({ type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' });
        expect(claude.github.headers.Authorization).toBe('Bearer ${GITHUB_PAT}');
        const cursorFile = file(plan, '.cursor/mcp.json')!;
        expect(cursorFile.status).toBe('merge');
        const cursor = JSON.parse(cursorFile.content).mcpServers;
        expect(cursor.testpilot).toEqual({ command: 'npx' });
        expect(cursor.browserstack.env.BROWSERSTACK_ACCESS_KEY).toBe('${env:BROWSERSTACK_ACCESS_KEY}');
        expect(cursor.atlassian).toEqual({ url: 'https://mcp.atlassian.com/v1/mcp' });
        expect(file(plan, '.agents/mcp_config.json')!.status).toBe('skip');
        for (const version of Object.values(COMPANION_VERSIONS)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        const only = ok(planCompanions(store, store.readConfig(), ['atlassian']));
        expect(Object.keys(JSON.parse(file(only, '.mcp.json')!.content).mcpServers)).toEqual(['atlassian']);
    });
});

describe('org-policy', () => {
    it('validates the policy file with readable errors', () => {
        expect(parsePolicy('allowedLanguages: typescript')).toEqual({ error: expect.stringContaining('allowedLanguages') });
        expect(parsePolicy("testNamePattern: '(['")).toEqual({ error: expect.stringContaining('not a valid regular expression') });
        expect(parsePolicy('ci: bamboo')).toHaveProperty('error');
        expect(parsePolicy('unknownKey: 1')).toHaveProperty('error');
        const example = readFileSync(path.join(import.meta.dirname, '..', 'examples', 'org-policy', 'testpilot.org.yaml'), 'utf8');
        const parsed = parsePolicy(example);
        if ('error' in parsed) throw new Error(parsed.error);
        expect(parsed.policy.requiredTags).toEqual([{ tag: '@smoke', min: 3 }]);
    });

    it('reads test titles and tags from specs', () => {
        const tests = extractTests('a.spec.ts', "test.describe('x', () => {\n  test('SHOP-1 add @smoke', async () => {});\n  test.fixme('later', { tag: ['@smoke', '@cart'] }, async () => {});\n  test.step('not a test', async () => {});\n});");
        expect(tests.map(t => [t.title, t.tags, t.line])).toEqual([
            ['SHOP-1 add @smoke', ['@smoke'], 2],
            ['later', ['@smoke', '@cart'], 3]
        ]);
    });

    it('checks config choices, names, tags, forbidden code and the CI file', async () => {
        const store = repo(webConfig({ integrations: { ci: 'github-actions', reporting: ['html'] } }), {
            'tests/cart.spec.ts': "test('SHOP-1 adds to cart', { tag: '@smoke' }, async ({ page }) => {\n  // never use waitForTimeout\n  await page.waitForTimeout(100);\n});\ntest('checkout works', async () => {});\n"
        });
        const policy = parsePolicy("allowedFrameworks: [playwright]\nallowedLanguages: [javascript]\ntestNamePattern: '^[A-Z]+-\\d+ '\nrequiredTags: [{ tag: '@smoke', min: 2 }]\nci: github-actions\nreporting: [junit]\nforbidden: [waitForTimeout]\n");
        if ('error' in policy) throw new Error(policy.error);
        const results = Object.fromEntries(checkPolicy(store, store.readConfig(), policy.policy).results.map(r => [r.rule, r]));
        expect(results['Allowed frameworks'].ok).toBe(true);
        expect(results['Allowed languages'].ok).toBe(false);
        expect(results['Test names'].details).toContain('tests/cart.spec.ts:5 "checkout works"');
        expect(results['Tag @smoke']).toMatchObject({ ok: false, details: '1 test(s) tagged @smoke; at least 2 required.' });
        expect(results['CI system']).toMatchObject({ ok: false, details: 'Uses github-actions but no pipeline file was found.' });
        expect(results.Reporting.ok).toBe(false);
        expect(results['Forbidden: waitForTimeout'].details).toBe('Found 1 time(s): tests/cart.spec.ts:3');

        const missing = await planOrgPolicy(store, store.readConfig(), undefined);
        expect(missing).toEqual({ error: expect.stringContaining('No company policy saved yet') });
        expect(await planOrgPolicy(store, store.readConfig(), 'http://example.com/p.yaml')).toEqual({ error: expect.stringContaining('https') });
        const remote = ok(await planOrgPolicy(store, store.readConfig(), 'https://raw.example.com/acme/testpilot.org.yaml', async () => new Response('name: Remote\nci: github-actions\n')));
        expect(file(remote, '.testpilot/org-policy.source')!.content).toBe('https://raw.example.com/acme/testpilot.org.yaml\n');
    });
});

describe('preview helpers', () => {
    it('diffs lines with context and keeps tokens stable for the same plan', () => {
        expect(lineDiff('a\nb\nc\nd', 'a\nb\nX\nd')).toBe('  a\n  b\n- c\n+ X\n  d');
        const store = repo(webConfig());
        const a = ok(planCiSpeed(store, store.readConfig(), 4));
        const b = ok(planCiSpeed(store, store.readConfig(), 4));
        const c = ok(planCiSpeed(store, store.readConfig(), 5));
        expect(planToken(a)).toBe(planToken(b));
        expect(planToken(a)).not.toBe(planToken(c));
    });
});
