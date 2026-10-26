import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { caseToAi, casesYaml, MIDSCENE_VERSION, midsceneConfig, MODEL_PRESETS, platformsFor, readAiSummary, starterCases, TSX_OVERRIDE } from '../src/ai/midscene.js';
import { planAiSteps } from '../src/capabilities/ai-steps.js';
import type { CapabilityPlan } from '../src/capabilities/shared.js';
import { type Config, ConfigSchema, type TestCase } from '../src/core/schema.js';
import { ProjectStore } from '../src/core/store.js';
import { answerWebSetup, connect, tempRepo } from './helpers.js';

const config = (extra: Record<string, unknown> = {}): Config =>
    ConfigSchema.parse({ appType: 'web', stack: { framework: 'playwright', language: 'typescript', pattern: 'pom', templatePack: 'playwright-ts' }, ...extra });

function ok(outcome: CapabilityPlan | { error: string }): CapabilityPlan {
    if ('error' in outcome) throw new Error(outcome.error);
    return outcome;
}

function repo(cfg: Config, files: Record<string, string> = {}): ProjectStore {
    const store = new ProjectStore(tempRepo(files));
    store.writeConfig(cfg);
    return store;
}

const sampleCase: TestCase = {
    id: 'SHOP-7',
    title: 'Add a mug to the basket',
    preconditions: ['The shop has mugs in stock'],
    steps: [
        { action: 'Search for a product', data: 'mug', expected: 'Mugs are listed' },
        { action: 'Add the first mug to the basket', expected: 'The basket shows 1' }
    ],
    expected: 'The basket shows 1',
    tags: [],
    source: { type: 'excel', ref: 'cases.xlsx', importedAt: '2026-10-26T00:00:00Z' }
};

describe('AI steps building blocks', () => {
    it('maps every app type to the screens the AI drives, and explains why an API has none', () => {
        expect(platformsFor(config())).toEqual(['web']);
        expect(platformsFor(config({ appType: 'android' }))).toEqual(['android']);
        expect(platformsFor(config({ appType: 'android-ios' }))).toEqual(['android', 'ios']);
        expect(platformsFor(config({ appType: 'windows' }))).toEqual(['computer']);
        expect(platformsFor(config({ appType: 'electron' }))).toEqual(['computer']);
        expect(platformsFor(config({ appType: 'api' }))).toMatchObject({ error: expect.stringContaining('API') });
        expect(platformsFor(config({ appType: 'api' }), ['web'])).toEqual(['web']);
    });

    it('turns plain steps into Midscene Test YAML, and refuses incomplete steps', () => {
        const yaml = casesYaml(
            [
                {
                    name: 'SHOP-1 search',
                    comments: ['Before this test: signed out'],
                    steps: [
                        { kind: 'open', text: '/' },
                        { kind: 'type', text: 'the search box', value: 'mug' },
                        { kind: 'do', text: 'Press Enter' },
                        { kind: 'waitFor', text: 'Results are shown' },
                        { kind: 'check', text: 'Every result is a mug' },
                        { kind: 'extract', text: 'Return the result titles as string[]' },
                        { kind: 'wait', seconds: 2 }
                    ]
                }
            ],
            'web'
        );
        expect(typeof yaml).toBe('string');
        expect(yaml as string).toContain('# Before this test: signed out');
        const doc = YAML.parse(yaml as string);
        expect(doc.cases[0].steps).toEqual([
            { gotoUrl: '/' },
            { aiInput: { prompt: 'the search box', value: 'mug' } },
            { aiAct: 'Press Enter' },
            { aiWaitFor: 'Results are shown' },
            { aiAssert: 'Every result is a mug' },
            { aiQuery: 'Return the result titles as string[]' },
            { wait: { duration: 2, unit: 's' } }
        ]);
        expect(casesYaml([{ name: 'x', steps: [{ kind: 'check' }] }], 'web')).toMatchObject({ error: expect.stringContaining('"check" step needs') });
        expect(casesYaml([{ name: 'x', steps: [{ kind: 'home' }] }], 'web')).toMatchObject({ error: expect.stringContaining('phone button') });
        const phone = YAML.parse(casesYaml([{ name: 'p', steps: [{ kind: 'open' }, { kind: 'back' }, { kind: 'home' }] }], 'android') as string);
        expect(phone.cases[0].steps).toEqual([{ launch: { uri: '${appId}' } }, { back: {} }, { home: {} }]);
    });

    it('turns an imported test case into do/check steps, keeping preconditions as comments', () => {
        const web = caseToAi(sampleCase, 'web');
        expect(web.name).toBe('SHOP-7 Add a mug to the basket');
        expect(web.steps).toEqual([
            { kind: 'open' },
            { kind: 'do', text: 'Search for a product (use: mug)' },
            { kind: 'check', text: 'Mugs are listed' },
            { kind: 'do', text: 'Add the first mug to the basket' },
            { kind: 'check', text: 'The basket shows 1' }
        ]);
        expect(web.comments?.[0]).toContain('The shop has mugs in stock');
        expect(caseToAi(sampleCase, 'android').steps[0]).toEqual({ kind: 'open', text: '${appId}' });
        expect(caseToAi(sampleCase, 'computer').steps[0].kind).toBe('do');
    });

    it('writes a config with one Midscene project per platform reading the shared .env', () => {
        const text = midsceneConfig(['android', 'ios']);
        expect(text).toContain("files: { include: ['cases/android/**/*.{yaml,yml}'] }");
        expect(text).toContain("files: { include: ['cases/ios/**/*.{yaml,yml}'] }");
        expect(text).toContain("'../.env'");
        expect(text).toContain('agentFromAdbDevice(env.ANDROID_DEVICE_ID || undefined)');
        expect(text).not.toContain('MIDSCENE_MODEL_API_KEY=');
        expect(midsceneConfig(['web'])).toContain('baseURL: env.APP_BASE_URL');
        expect(starterCases('web', config()).map(c => c.file)).toEqual(['cases/web/smoke.yaml', 'cases/web/form.yaml']);
        expect(starterCases('computer', config())[0].content).toContain('real mouse');
    });

    it('lists only vision models with complete settings', () => {
        for (const p of MODEL_PRESETS) {
            expect(p.baseUrl).toMatch(/^https:\/\//);
            expect(p.name && p.family).toBeTruthy();
        }
        expect(MODEL_PRESETS.map(p => p.family)).not.toContain('claude');
    });
});

describe('add_capability ai-steps plan', () => {
    it('adds the AI folder, AI steps inside Playwright tests, the skill and the model key names for a TypeScript web project', () => {
        const store = repo(config(), { 'package.json': JSON.stringify({ name: 'shop-tests', devDependencies: { '@playwright/test': '1.64.0' } }), 'src/fixtures/test.ts': 'export const test = {};\n' });
        const plan = ok(planAiSteps(store, store.readConfig()));
        const paths = plan.files.map(f => f.path);
        expect(paths).toEqual(
            expect.arrayContaining([
                'ai-tests/midscene.config.ts',
                'ai-tests/package.json',
                'ai-tests/README.md',
                'ai-tests/.gitignore',
                'ai-tests/cases/web/smoke.yaml',
                'ai-tests/cases/web/form.yaml',
                'src/fixtures/ai.ts',
                'tests/ai/ai-steps.spec.ts',
                '.agents/skills/ai-steps/SKILL.md',
                '.claude/skills/ai-steps/SKILL.md',
                '.env.example'
            ])
        );
        const pkg = JSON.parse(plan.files.find(f => f.path === 'ai-tests/package.json')!.content);
        expect(pkg.devDependencies['@midscene/web']).toBe(MIDSCENE_VERSION);
        expect(pkg.devDependencies.playwright).toBe('1.64.0');
        expect(pkg.overrides.tsx).toBe(TSX_OVERRIDE);
        expect(pkg.type).toBe('module');
        const main = JSON.parse(plan.files.find(f => f.path === 'package.json')!.content);
        expect(main.devDependencies['@midscene/web']).toBe(MIDSCENE_VERSION);
        expect(main.devDependencies['@playwright/test']).toBe('1.64.0');
        const env = plan.files.find(f => f.path === '.env.example')!.content;
        for (const key of ['MIDSCENE_MODEL_BASE_URL', 'MIDSCENE_MODEL_API_KEY', 'MIDSCENE_MODEL_NAME', 'MIDSCENE_MODEL_FAMILY']) expect(env).toMatch(new RegExp(`^${key}=$`, 'm'));
        expect(plan.files.find(f => f.path === 'src/fixtures/ai.ts')!.content).toContain("import { test as base } from './test';");
        expect(plan.files.find(f => f.path === 'tests/ai/ai-steps.spec.ts')!.content).toContain('test.skip(!process.env.MIDSCENE_MODEL_API_KEY');
        expect(plan.install).toEqual([['npm', 'install'], ['npm', 'install', '--prefix', 'ai-tests', '--workspaces=false']]);
        expect(plan.notes.join(' ')).toMatch(/Claude cannot be the model/);
    });

    it('keeps a Java project in Java: only the AI folder, no JavaScript in the test code', () => {
        const store = repo(config({ stack: { framework: 'selenium', language: 'java', pattern: 'pom', templatePack: 'selenium-java' } }));
        const plan = ok(planAiSteps(store, store.readConfig()));
        expect(plan.files.some(f => f.path.startsWith('src/fixtures'))).toBe(false);
        expect(plan.files.some(f => f.path === 'package.json')).toBe(false);
        expect(plan.install).toEqual([['npm', 'install', '--prefix', 'ai-tests', '--workspaces=false']]);
        const unscaffolded = repo(config());
        expect(ok(planAiSteps(unscaffolded, unscaffolded.readConfig())).files.some(f => f.path === 'src/fixtures/ai.ts')).toBe(false);
    });

    it('sets up phones and desktops, and adds a platform to an existing AI folder', () => {
        const store = repo(config({ appType: 'android', stack: { framework: 'appium', language: 'typescript', templatePack: 'appium-wdio-ts' } }));
        const plan = ok(planAiSteps(store, store.readConfig()));
        expect(plan.files.map(f => f.path)).toContain('ai-tests/cases/android/smoke.yaml');
        expect(plan.notes.join(' ')).toContain('adb devices');
        for (const f of plan.files) if (f.status === 'new') store.write(f.path, f.content);
        const more = ok(planAiSteps(store, store.readConfig(), ['ios']));
        expect(more.data.platforms).toEqual(['android', 'ios']);
        expect(more.files.find(f => f.path === 'ai-tests/package.json')!.status).toBe('merge');
        expect(more.files.find(f => f.path === 'ai-tests/midscene.config.ts')!.status).toBe('conflict');
        const mac = repo(ConfigSchema.parse({ appType: 'macos' }));
        expect(ok(planAiSteps(mac, mac.readConfig())).data.platforms).toEqual(['computer']);
    });
});

describe('reading an AI run', () => {
    it('summarises Midscene Test results with the failing step and the report path', () => {
        const store = new ProjectStore(tempRepo());
        const run = 'ai-tests/results/20261026075516-15354816';
        store.write(
            `${run}/summary.json`,
            JSON.stringify({
                schemaVersion: 3,
                runId: '20261026075516-15354816',
                status: 'failed',
                durationMs: 4100,
                report: '../../midscene_run/report/midscene-e2e-20261026075516-15354816/index.html',
                summary: { total: 2, passed: 1, failed: 1, notRun: 0 },
                projects: [
                    {
                        name: 'web',
                        lifecycle: { status: 'success' },
                        cases: [
                            { name: 'AI-1 home', sourcePath: 'cases/web/smoke.yaml', status: 'success', attempts: [{ resultFile: 'p/a.json' }] },
                            { name: 'AI-2 form', sourcePath: 'cases/web/form.yaml', status: 'failed', attempts: [{ resultFile: 'p/b.json' }] }
                        ]
                    }
                ]
            })
        );
        store.write(`${run}/p/a.json`, JSON.stringify({ steps: [{ node: 'gotoUrl', status: 'success' }, { node: 'aiAssert', status: 'success' }] }));
        store.write(`${run}/p/b.json`, JSON.stringify({ steps: [{ node: 'gotoUrl', status: 'success' }, { node: 'aiAssert', status: 'failed', input: { prompt: 'No validation error is shown' }, error: { message: 'Assertion failed: an "email is required" message is shown' } }] }));
        const summary = readAiSummary(store, 'ai-tests/results', '20261026075516-15354816')!;
        expect(summary.report).toBe('ai-tests/midscene_run/report/midscene-e2e-20261026075516-15354816/index.html');
        expect(summary.cases[1]).toMatchObject({ status: 'failed', steps: 2, failedStep: 'aiAssert: No validation error is shown', error: expect.stringContaining('email is required') });
    });
});

describe('ai_tests through MCP', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('sets up AI tests after approval, reports missing keys by name only, writes cases from words and from imported cases', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        close = c.close;
        await answerWebSetup(c, root);
        const scaffold = await c.call('preview_scaffold');
        expect((await c.call('scaffold_project', { confirmToken: scaffold.structuredContent.confirmToken, userApproved: true })).isError).toBeFalsy();

        expect((await c.call('ai_tests', { action: 'status' })).content[0].text).toMatch(/not set up/);
        const preview = await c.call('add_capability', { capability: 'ai-steps' });
        expect(preview.isError, preview.content[0].text).toBeFalsy();
        expect(preview.content[0].text).toContain('ai-tests/midscene.config.ts');
        const refused = await c.call('add_capability', { capability: 'ai-steps', confirmToken: preview.structuredContent.confirmToken });
        expect(refused.isError).toBe(true);
        expect(existsSync(path.join(root, 'ai-tests'))).toBe(false);
        const applied = await c.call('add_capability', { capability: 'ai-steps', confirmToken: preview.structuredContent.confirmToken, userApproved: true });
        expect(applied.isError, applied.content[0].text).toBeFalsy();
        expect(existsSync(path.join(root, 'ai-tests/cases/web/form.yaml'))).toBe(true);

        writeFileSync(path.join(root, '.env'), `${readFileSync(path.join(root, '.env'), 'utf8')}MIDSCENE_MODEL_API_KEY=sk-secret-value\n`);
        const status = await c.call('ai_tests', { action: 'status' });
        expect(status.content[0].text).toContain('MIDSCENE_MODEL_BASE_URL (missing)');
        expect(status.content[0].text).not.toContain('MIDSCENE_MODEL_API_KEY (missing)');
        expect(JSON.stringify(status)).not.toContain('sk-secret-value');
        expect(status.content[0].text).toContain('cases/web/smoke.yaml');

        const models = await c.call('ai_tests', { action: 'models' });
        expect(models.content[0].text).toContain('MIDSCENE_MODEL_FAMILY=gemini');

        const cases = [{ name: 'SHOP-9 checkout total', steps: [{ kind: 'open', text: '/' }, { kind: 'do', text: 'Add a mug to the basket and open the basket' }, { kind: 'check', text: 'The total is shown' }] }];
        const draft = await c.call('ai_tests', { action: 'write', file: 'checkout', cases });
        expect(draft.content[0].text).toContain('aiAct: Add a mug to the basket and open the basket');
        expect(existsSync(path.join(root, 'ai-tests/cases/web/checkout.yaml'))).toBe(false);
        const saved = await c.call('ai_tests', { action: 'write', file: 'checkout', cases, confirmToken: draft.structuredContent.confirmToken, userApproved: true });
        expect(saved.isError, saved.content[0].text).toBeFalsy();
        expect(YAML.parse(readFileSync(path.join(root, 'ai-tests/cases/web/checkout.yaml'), 'utf8')).cases[0].steps[2]).toEqual({ aiAssert: 'The total is shown' });

        new ProjectStore(root).writeCase(sampleCase);
        const fromCases = await c.call('ai_tests', { action: 'from-cases', ids: ['SHOP-7'] });
        expect(fromCases.content[0].text).toContain('SHOP-7 Add a mug to the basket');
        const wrote = await c.call('ai_tests', { action: 'from-cases', ids: ['SHOP-7'], confirmToken: fromCases.structuredContent.confirmToken, userApproved: true });
        expect(wrote.isError, wrote.content[0].text).toBeFalsy();
        expect(existsSync(path.join(root, 'ai-tests/cases/web/shop-7.yaml'))).toBe(true);

        const run = await c.call('ai_tests', { action: 'run' });
        expect(run.isError).toBe(true);
        expect(run.content[0].text).toMatch(/not installed/);
    });
});

/**
 * A stand-in for the AI model so the plumbing runs offline: checks always pass,
 * and data questions get a one-item list.
 */
function startFakeModel(port: number): Promise<Server> {
    const server = createHttpServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            const messages = (JSON.parse(body).messages ?? []) as Array<{ content: unknown }>;
            const last = JSON.stringify(messages.at(-1)?.content ?? '');
            const data = last.includes('StatementIsTruthy') ? '{"StatementIsTruthy": true}' : '["Home"]';
            const content = `<observation>The page shows the expected content.</observation>\n<data-json>${data}</data-json>`;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        });
    });
    return new Promise(resolve => server.listen(port, () => resolve(server)));
}

function startSite(port: number): Promise<Server> {
    const server = createHttpServer((_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><title>Shop</title><h1>Hello shop</h1><nav><a href="/">Home</a></nav>');
    });
    return new Promise(resolve => server.listen(port, () => resolve(server)));
}

/**
 * Installs Midscene for real and runs an AI test against a local page, with a stand-in model.
 * Needs network for npm install. Run with TESTPILOT_E2E=1 (and PLAYWRIGHT_BROWSERS_PATH where browsers are pre-installed).
 */
describe.skipIf(!process.env.TESTPILOT_E2E)('AI tests for real', () => {
    it.each([
        ['typescript', 'ts', 4781],
        ['javascript', 'js', 4783]
    ] as const)('installs Midscene, runs an AI test and an AI step inside a %s Playwright test, with visual reports', { timeout: 900_000 }, async (language, ext, port) => {
        const root = tempRepo();
        const model = await startFakeModel(port);
        const site = await startSite(port + 1);
        const c = await connect(root, 'legacy');
        try {
            await answerWebSetup(c, root, { LANGUAGE: language });
            const store = new ProjectStore(root);
            store.writeConfig({ ...store.readConfig(), app: { kind: 'url', ref: `http://localhost:${port + 1}` } });
            const scaffold = await c.call('preview_scaffold');
            expect((await c.call('scaffold_project', { confirmToken: scaffold.structuredContent.confirmToken, userApproved: true })).isError).toBeFalsy();
            const preview = await c.call('add_capability', { capability: 'ai-steps' });
            expect(preview.content[0].text).toContain(`src/fixtures/ai.${ext}`);
            const applied = await c.call('add_capability', { capability: 'ai-steps', confirmToken: preview.structuredContent.confirmToken, userApproved: true, install: true });
            expect(applied.isError, applied.content[0].text).toBeFalsy();
            expect(applied.content[0].text).not.toMatch(/Install failed/);
            writeFileSync(path.join(root, '.env'), [`APP_BASE_URL=http://localhost:${port + 1}`, `MIDSCENE_MODEL_BASE_URL=http://localhost:${port}/v1`, 'MIDSCENE_MODEL_API_KEY=fake', 'MIDSCENE_MODEL_NAME=qwen3-vl-plus', 'MIDSCENE_MODEL_FAMILY=qwen3-vl', ''].join('\n'));
            mkdirSync(path.join(root, 'ai-tests/cases/web'), { recursive: true });
            const cases = [{ name: 'AI-9 heading', steps: [{ kind: 'open', text: '/' }, { kind: 'check', text: 'The page shows the heading Hello shop' }] }];
            const draft = await c.call('ai_tests', { action: 'write', file: 'heading', cases });
            await c.call('ai_tests', { action: 'write', file: 'heading', cases, confirmToken: draft.structuredContent.confirmToken, userApproved: true });
            const run = await c.call('ai_tests', { action: 'run', files: ['cases/web/heading.yaml'], userApproved: true });
            expect(run.isError, run.content[0].text).toBeFalsy();
            expect(run.structuredContent.run.passed, run.content[0].text).toBe(1);
            expect(existsSync(path.join(root, run.structuredContent.run.report))).toBe(true);

            // The coded Playwright example uses aiWaitFor, aiQuery and aiAssert next to page.goto.
            const coded = await c.call('run_tests', { files: [`tests/ai/ai-steps.spec.${ext}`], project: 'chromium' });
            expect(coded.isError, coded.content[0].text).toBeFalsy();
            expect(coded.structuredContent.run.stats.passed, coded.content[0].text).toBe(1);
        } finally {
            await c.close();
            model.close();
            site.close();
        }
    });
});
