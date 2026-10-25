import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { integrationsFor, keysFor } from '../catalog/env-keys.js';
import { classifyAppRef, isLikelyProduction } from '../core/app-target.js';
import { uiFrameworksIn } from '../core/detect.js';
import { checkEnv, ENV_FILE, loadEnvValues, resolveBaseUrl, writeEnvTemplate } from '../core/env.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { answerStep, completeActionStep, currentStepId, viewStep, WizardInputError } from '../core/wizard.js';
import { exploreWeb } from '../explore/web.js';
import { buildHealthReport, type Finding, HEALTH_DIR, type HealthReport, renderHealthMarkdown, STARTER_CASES_FILE, STARTER_PREFIX, starterCases, starterCasesCsv } from '../health/check.js';
import { buildPlan, readPlanMeta, savePlan } from '../plan/plan.js';
import type { FailureCategory, RunSummary } from '../run/playwright.js';
import { runPlaywright } from '../run/playwright.js';
import { GLOSSARY, lookupTerm } from '../knowledge/glossary.js';
import { inTestRoot, runCommand, writePlanned } from '../scaffold/engine.js';
import { runImport } from '../testcases/import.js';
import { approverArg, failure, guarded, openProject, projectRootArg, READ_ONLY, requireApproval, result, type ServerOptions, userApprovedArg } from './common.js';
import { applyGeneration, buildGeneration, select } from './generate.js';
import { recordRun } from './run.js';
import { buildScaffoldPlan } from './scaffold.js';
import { reviewAndStore } from './testcases.js';

/** Written once the install commands all succeeded, so a failed browser download is retried on the next start. */
const INSTALLED_MARKER = '.testpilot/tmp/installed.json';

const PLAIN_RULES =
    'Explain everything to the user in plain, friendly words, as if they have never tested software: no jargon (say "test project" not "framework", "button names" not "locators"), short sentences, and say what each problem means for the people who use the app.';

/** The choices a person with no testing background gets: TestPilot's recommendation for every question. */
function beginnerAnswers(detection: ReturnType<ReturnType<typeof openProject>['detection']>): Record<string, string | string[]> {
    const found = uiFrameworksIn(detection)[0];
    return {
        APP_TYPE: 'web',
        EXISTING: found === 'playwright' ? 'extend' : 'create',
        FRAMEWORK: 'playwright',
        LANGUAGE: detection.languages.some(l => l.language === 'typescript') || !detection.languages.some(l => l.language === 'javascript') ? 'typescript' : 'javascript',
        PATTERN: 'pom',
        EXECUTION_TARGET: 'local',
        TEST_CASE_SOURCE: 'none',
        CI: 'github-actions',
        REPORTING: ['html', 'junit'],
        EXTRAS: ['explore']
    };
}

/** Answers every open question with the beginner choice; the URL goes in as the app under test. */
function answerForBeginner(store: ProjectStore, detection: ReturnType<ReturnType<typeof openProject>['detection']>, url: string): void {
    const wanted = beginnerAnswers(detection);
    for (let guard = 0; guard < 20; guard++) {
        const ctx = { config: store.readConfig(), state: store.readState(), detection };
        const id = currentStepId(ctx);
        if (!id) break;
        const view = viewStep(id, ctx);
        if (view.kind === 'action') break;
        if (id === 'APP_UNDER_TEST') {
            answerStep(store, detection, id, url, 'testpilot (quick start)');
            continue;
        }
        const preferred = wanted[id] ?? view.recommended;
        if (preferred === undefined) break;
        try {
            answerStep(store, detection, id, preferred, 'testpilot (quick start)');
        } catch (error) {
            if (!(error instanceof WizardInputError) || view.recommended === undefined) throw error;
            answerStep(store, detection, id, view.recommended, 'testpilot (quick start)');
        }
    }
    const state = store.readState();
    if (!state.completed.includes('APP_UNDER_TEST') || store.readConfig().app.ref !== url) answerStep(store, detection, 'APP_UNDER_TEST', url, 'testpilot (quick start)');
    if (!state.completed.includes('EXTRAS')) answerStep(store, detection, 'EXTRAS', ['explore'], 'testpilot (quick start)');
    // A website needs no keys to be checked; the template still lists the optional test-account keys.
    const config = store.readConfig();
    const keys = keysFor(integrationsFor(config));
    writeEnvTemplate(store, keys);
    if (checkEnv(store, keys).ok && !store.readState().completed.includes('SECRETS')) completeActionStep(store, 'SECRETS', 'No keys needed for a first check');
}

/** Can this setup run the quick path? Only web apps with a Playwright project. */
function unsupported(config: Config): string | undefined {
    if (config.appType && config.appType !== 'web') return `This folder is already set up for a ${config.appType} app. The quick path works for websites; use the step-by-step setup (wizard) for this app.`;
    if (config.stack.framework && config.stack.framework !== 'playwright') return `This folder is already set up with ${config.stack.framework}. The quick path uses Playwright; continue with the step-by-step setup (wizard) instead, or start the quick path in a new, empty folder.`;
    return undefined;
}

function playwrightInstalled(store: ProjectStore, config: Config): boolean {
    const root = inTestRoot(config, '.') || '.';
    return store.exists(`${root}/node_modules/@playwright/test`) || store.exists('node_modules/@playwright/test');
}

async function reachable(url: string): Promise<{ ok: boolean; status?: number; reason?: string; selfSigned?: boolean }> {
    // Behind a company proxy this pre-check can fail although the browser gets through; let the browser decide there.
    const proxied = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
        return { ok: true, status: res.status };
    } catch (error) {
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        const code = cause?.code ?? '';
        if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return { ok: true, selfSigned: true };
        if (proxied && !/^(localhost|127\.|\[::1\])/i.test(new URL(url).hostname)) return { ok: true };
        const reason =
            code === 'ENOTFOUND' || code === 'EAI_AGAIN'
                ? 'that address does not exist (check for a typo, or connect to your company VPN if the app is internal)'
                : code === 'ECONNREFUSED'
                  ? 'nothing answered at that address (is the app running? for a local app, start it first)'
                  : (error as Error).name === 'TimeoutError'
                    ? 'it did not answer within 15 seconds (it may be down, or only reachable on the company VPN)'
                    : `${cause?.message ?? (error as Error).message}`;
        return { ok: false, reason };
    }
}

function previousReport(store: ProjectStore): HealthReport | undefined {
    try {
        const raw = store.read(`${HEALTH_DIR}/latest.json`);
        return raw ? (JSON.parse(raw) as HealthReport) : undefined;
    } catch {
        return undefined;
    }
}

/** What changed since the last check, by finding headline and place. */
export function compareReports(before: HealthReport | undefined, after: HealthReport): { fixed: string[]; fresh: string[] } {
    if (!before) return { fixed: [], fresh: [] };
    const keyed = (r: HealthReport) => new Map(r.findings.flatMap(f => f.where.map(w => [`${f.title.replace(/^\d+\s+/, '')}|${w.split(':')[0].split(' (')[0]}`, `${f.title.replace(/^\d+\s+/, '')}: ${w}`] as const)));
    const a = keyed(before);
    const b = keyed(after);
    return { fixed: [...a].filter(([k]) => !b.has(k)).map(([, v]) => v), fresh: [...b].filter(([k]) => !a.has(k)).map(([, v]) => v) };
}

async function runHealthCheck(store: ProjectStore, config: Config, url: string, maxPages: number, ignoreHttpsErrors: boolean) {
    const cwd = store.resolve(inTestRoot(config, '.') || '.');
    const out = await exploreWeb(store, cwd, { url, maxPages, screenshots: true, ignoreHttpsErrors, health: true });
    if (out.fatal) return { fatal: out.fatal } as const;
    const before = previousReport(store);
    const report = buildHealthReport(out.pages, out.brokenLinks, url);
    const changes = compareReports(before, report);
    store.write(`${HEALTH_DIR}/latest.json`, JSON.stringify(report, null, 2) + '\n');
    store.write(`${HEALTH_DIR}/report.md`, renderHealthMarkdown(report));
    store.write(`${HEALTH_DIR}/history/${report.checkedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(report, null, 2) + '\n');
    store.recordDecision(`Health check of ${url}: ${report.verdict}`, 'test_my_app', 'testpilot');
    return { report, pages: out.pages, changes, before } as const;
}

function findingLines(findings: Finding[], limit = 6): string[] {
    return findings.slice(0, limit).map(f => `- ${f.severity === 'problem' ? 'PROBLEM' : 'Worth a look'}: ${f.title}. ${f.meaning} (${f.where.slice(0, 2).join('; ')}${f.where.length > 2 ? '; …' : ''})`);
}

const PLAIN_CAUSE: Record<FailureCategory, string> = {
    environment: 'the test could not reach the app or start the browser (is the test environment up? the run details show the exact message)',
    locator: 'a button, link or field the test looks for is not there any more, maybe because it was renamed. Ask me to heal the test if the change was on purpose',
    assertion: 'the page showed something different from what the test expects. That is either a real bug, or the app changed on purpose and the test needs updating',
    timing: 'the page was too slow, or something took longer than the test waits',
    data: 'the test data did not match what is in the app',
    script: 'the test itself has a mistake (my side: ask me to fix it)',
    unknown: 'the cause is not clear; the report and screenshot will show what happened'
};

function describeQuickRun(run: RunSummary): string[] {
    const s = run.stats;
    if (!s.total) return [`The tests did not produce results (exit code ${run.exitCode}).${run.consoleTail ? ` Last output: ${run.consoleTail.split('\n').slice(-3).join(' ')}` : ''}`];
    const lines = [`Ran ${s.total} test(s) ${run.repeat > 1 ? `${run.repeat} times each, to make sure they are reliable` : 'once'}: ${s.passed} passed, ${s.failed} failed${s.flaky ? `, ${s.flaky} unreliable (passed only sometimes)` : ''}.`];
    for (const t of run.tests.filter(x => x.status === 'failed' || x.status === 'flaky').slice(0, 8)) lines.push(`- ${t.title}: ${PLAIN_CAUSE[t.category ?? 'unknown'] ?? PLAIN_CAUSE.unknown}.`);
    return lines;
}

export function registerQuickStartTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'explain_testing',
        {
            title: 'Explain a testing word',
            description:
                'Explains a testing word in plain language with an everyday example, for people new to testing: test case, automated test, framework, Playwright, Selenium, Appium, emulator, Page Object Model, BDD, locator, assertion, flaky, smoke test, regression, staging, .env, CI, report, trace, headless, accessibility, self-healing, test data, coverage, wave. Without a term it lists every word it knows. Use it whenever the user asks "what is …?" or seems unsure about a word TestPilot used.',
            inputSchema: z.object({ term: z.string().optional().describe('The word or phrase, e.g. "flaky test" or "what is CI"') }),
            annotations: READ_ONLY
        },
        guarded('explain_testing', options, async ({ term }: { term?: string }) => {
            if (!term?.trim()) {
                return result(`Testing words I can explain:\n${GLOSSARY.map(e => `- ${e.term}: ${e.plain}`).join('\n')}`, { terms: GLOSSARY.map(e => e.term) });
            }
            const entry = lookupTerm(term);
            if (!entry) return result(`"${term}" is not in TestPilot's word list. Explain it to the user in one or two plain sentences with an everyday example, without other jargon.`, { found: false, terms: GLOSSARY.map(e => e.term) });
            return result(`${entry.term}: ${entry.plain}\nExample: ${entry.example}`, { found: true, ...entry });
        })
    );

    server.registerTool(
        'test_my_app',
        {
            title: 'Test my app (quick start)',
            description:
                'The easiest way in, for people who have never written a test: give the address of a website and TestPilot does the rest with its recommended choices. Use this first when the user says things like "test my app", "check my website", "is my site working", "I don\'t know testing", or gives a URL without test cases. ' +
                'action "start" (needs url; one approval) creates a small Playwright test project, installs the test browser, visits the app\'s pages like a visitor (follows links only, never types, clicks buttons or submits) and reports problems in plain words: pages or links that are broken, programming errors, failed requests, slow pages, pages too wide for a phone, images without descriptions. It also writes starter tests in plain English (every page opens, the main links work) to test-cases/starter-tests.csv. ' +
                'action "make-tests" (one approval) turns those test cases into automated Playwright tests, then runs each twice and explains any failure in plain words. ' +
                'action "check" repeats the health check and says what got fixed and what is new since last time. ' +
                'Refuses addresses that look like the live (production) site unless the user explicitly agrees. For mobile or desktop apps it hands over to the step-by-step setup (wizard).',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                action: z.enum(['start', 'make-tests', 'check']).default('start'),
                url: z.string().optional().describe('The address of the app, e.g. https://staging.example.com or http://localhost:3000. Default: the address saved earlier.'),
                maxPages: z.number().int().min(1).max(30).default(12).describe('Most pages to visit'),
                allowProduction: z.boolean().default(false).describe('Only when the user explicitly agreed to check an address that looks like the live site'),
                userApproved: userApprovedArg,
                approver: approverArg
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        guarded(
            'test_my_app',
            options,
            async (args: { projectRoot?: string; action: 'start' | 'make-tests' | 'check'; url?: string; maxPages: number; allowProduction: boolean; userApproved?: boolean; approver?: string }, ctx: unknown) => {
                const { store, detection } = openProject(options, args.projectRoot);
                const config0 = store.readConfig();
                const notSupported = store.hasConfig() ? unsupported(config0) : undefined;
                if (notSupported) return failure(notSupported);

                // Which address, and is it one we may use?
                const url = (args.url ?? (store.hasConfig() ? resolveBaseUrl(store, config0) : undefined))?.trim();
                if (!url) return failure('I need the address of the app first. Ask the user: "What is the address of your app? It is the link you open in the browser, for example https://staging.yourcompany.com. A test or staging address is best, not the live site."');
                const ref = classifyAppRef(url, 'web');
                if (ref.kind === 'help') return failure(ref.guidance ?? 'That is not an address I can open. Ask for the full link, starting with https://');
                if (ref.kind !== 'url') {
                    const kind = { apk: 'an Android app', aab: 'an Android app', ipa: 'an iPhone app', app: 'an Apple app', exe: 'a Windows program', 'electron-path': 'a desktop app', 'package-id': 'an installed app', 'bundle-id': 'an installed app', 'cloud-id': 'an app in a device cloud', openapi: 'an API description' }[ref.kind] ?? 'not a website';
                    return failure(`"${url}" is ${kind}, not a website address. The quick path checks websites. For this app, start the step-by-step setup: call wizard with action "next" and answer the first question with the app type; every question there has a recommended answer, and "not sure" picks it.`);
                }
                const production = isLikelyProduction(url);
                if (production && !args.allowProduction) {
                    return failure(
                        `${url} looks like the live site that real customers use (it has no "test", "staging", "dev" or "localhost" in its name). Ask the user in plain words: "Is this your live site? If you have a test or staging address, let's use that instead. The first check only reads pages, but tests created later click through the app." If they have no other address and still want to go ahead, call again with allowProduction: true.`
                    );
                }

                if (args.action === 'check') {
                    if (!playwrightInstalled(store, config0)) return failure('The test project is not set up yet. Call test_my_app with action "start" first.');
                    const check = await runHealthCheck(store, config0, url, args.maxPages, false);
                    if ('fatal' in check) return failure(check.fatal ?? 'The check could not run.');
                    const { report, changes, before } = check;
                    const summary = [
                        report.verdict,
                        ...findingLines(report.findings),
                        before ? `Since the last check (${before.checkedAt.slice(0, 10)}): ${changes.fixed.length} fixed, ${changes.fresh.length} new.` : '',
                        ...changes.fixed.slice(0, 5).map(f => `- Fixed: ${f}`),
                        ...changes.fresh.slice(0, 5).map(f => `- New: ${f}`),
                        `Full report: ${HEALTH_DIR}/report.md`,
                        '',
                        PLAIN_RULES
                    ].filter(Boolean);
                    return result(summary.join('\n'), { report, changes });
                }

                if (args.action === 'make-tests') {
                    const config = store.readConfig();
                    if (!playwrightInstalled(store, config)) return failure('The test project is not set up yet. Call test_my_app with action "start" first.');
                    const cases = store.readCases();
                    if (!cases.length) return failure('There are no test cases yet. Call test_my_app with action "start" (it writes starter tests), or describe what the app should do and save it with save_test_case.');
                    const unreviewed = cases.filter(tc => !tc.review);
                    if (unreviewed.length) reviewAndStore(store, unreviewed);
                    const meta = buildPlan(store.readCases(), { wave1Size: 50, wave2Size: 200 });
                    const planned = meta.waves.flatMap(w => w.ids);
                    if (!planned.length) return failure('None of the test cases are ready to automate. Run review_test_cases to see why, and rewrite them with the user in simple steps ("Open /cart", "Click Checkout", expected: "Order summary" is shown).');
                    const already = new Set(store.readCases().filter(tc => tc.automation?.specFile).map(tc => tc.id));
                    const todo = planned.filter(id => !already.has(id));
                    const approval = requireApproval(server, ctx, {
                        key: 'quick-tests',
                        question: `Turn ${todo.length || planned.length} test case(s) into automated tests and run them now? The tests open your app in a browser and check each page; they do not type, buy or delete anything.${production ? ` Warning: ${url} looks like the live site.` : ''}`,
                        userApproved: args.userApproved,
                        approver: args.approver
                    });
                    if (!approval.approved) return approval.reply;
                    // The person who said yes approves the plan and the generated code in one go.
                    const existing = readPlanMeta(store);
                    const at = new Date().toISOString();
                    meta.approved = existing?.approved && existing.approved.digest === meta.digest ? existing.approved : { by: approval.by, at, digest: meta.digest, via: approval.via };
                    savePlan(store, meta, config);
                    store.updateState(s => {
                        s.approvals.push({ what: 'automation plan (quick start)', by: approval.by, at, note: `digest ${meta.digest.slice(0, 8)}` });
                    });
                    store.recordDecision(`Approved the automation plan (${planned.length} test(s))`, 'test_my_app make-tests', approval.by);
                    completeActionStep(store, 'PLAN', `Automation plan approved by ${approval.by}`);

                    let written: string[] = [];
                    if (todo.length) {
                        const sel = select(store, undefined, todo, false);
                        if (sel.error) return failure(sel.error);
                        const built = buildGeneration(store, config, sel.cases);
                        if (built.error || !built.plan) return failure(built.error ?? 'Nothing to generate.');
                        written = applyGeneration(store, built.plan, undefined, approval).written;
                    }
                    const runIds = planned.filter(id => store.readCase(id)?.automation?.specFile);
                    const escaped = runIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                    const run = await runPlaywright(store, {
                        cwd: store.resolve(inTestRoot(config, '.') || '.'),
                        files: [],
                        grep: `@(${escaped.join('|')})(\\s|$)`,
                        repeat: 2,
                        timeoutMs: 20 * 60_000,
                        reportFile: 'test-results/results.json',
                        bdd: config.stack.pattern === 'bdd'
                    });
                    run.baseUrl = url;
                    const saved = recordRun(store, run);
                    const failed = run.stats.failed + run.stats.flaky;
                    const pending = store.readCases().filter(tc => runIds.includes(tc.id) && tc.automation?.status === 'generated');
                    const testsDir = inTestRoot(config, 'tests') || 'tests';
                    const summary = [
                        `Wrote ${runIds.length} automated test(s) (${written.length} file(s) in ${testsDir}/).`,
                        ...describeQuickRun(run),
                        pending.length ? `${pending.length} test(s) still need a step I could not work out by myself; they are skipped for now: ${pending.map(tc => tc.id).join(', ')}.` : '',
                        failed ? 'A failing test is good news if it found a real bug: tell your developers what the test expected and what happened (the report has a screenshot).' : 'All tests pass. From now on they protect these pages: run them after every change to catch breakages.',
                        '',
                        'How to run them yourself, in the terminal of this folder:',
                        '- `npx playwright test` runs every test.',
                        '- `npx playwright test --ui` opens a window where you can watch each test step by step.',
                        '- `npx playwright show-report` opens the last report in the browser.',
                        '',
                        'Good next steps to offer the user (one at a time):',
                        '- "Tell me something your app should do, in your own words" (for example: "When I search for shoes, I see a list of shoes"). Turn it into a test case with save_test_case, using simple steps such as "Open /", "Click Search", "Enter "shoes" in the Search field", and an expected result in quotes, then call test_my_app action "make-tests" again.',
                        '- Watch a test happen live in a browser: live_test.',
                        '- Run the tests automatically on every change: publish_results with action "ci".',
                        '',
                        `Run details: ${saved}.`,
                        PLAIN_RULES
                    ].filter(Boolean);
                    return result(summary.join('\n'), { written, run: { stats: run.stats, repeat: run.repeat, failed: run.tests.filter(t => t.status !== 'passed' && t.status !== 'skipped').map(t => ({ id: t.id, title: t.title, category: t.category, plain: PLAIN_CAUSE[t.category ?? 'unknown'] })) }, saved });
                }

                // action: start
                const site = await reachable(url);
                if (!site.ok) return failure(`I could not open ${url}: ${site.reason}. Ask the user to check the address, then try again.`);
                const fresh = !store.hasConfig();
                if (fresh) {
                    store.writeConfig(store.readConfig());
                    store.writeState(store.readState());
                    store.recordDecision('Started TestPilot with the quick start', 'test_my_app', 'user');
                }
                answerForBeginner(store, detection(), url);
                const config = store.readConfig();
                const plan = buildScaffoldPlan(store, config);
                const writes = plan.files.filter(f => f.status === 'new' || f.status === 'merge');
                // Installing is finished only when every command succeeded (the browser download is the one that fails most).
                const needsInstall = plan.install.length > 0 && (!store.exists(INSTALLED_MARKER) || !playwrightInstalled(store, config));
                const scaffolded = store.readState().completed.includes('SCAFFOLD');
                if (!scaffolded || needsInstall) {
                    const approval = requireApproval(server, ctx, {
                        key: 'quick-start',
                        question: [
                            `Set up testing for ${url}?`,
                            writes.length ? `I will add a small test project to ${store.root} (${writes.length} files; your own files are not changed).` : '',
                            needsInstall ? 'I will download Playwright and its test browser (about 150 MB, a few minutes, once).' : '',
                            'Then I visit your app\'s pages like a visitor to look for problems. I only follow links: nothing is clicked, typed or changed in your app.',
                            production ? `Note: ${url} looks like your live site.` : ''
                        ]
                            .filter(Boolean)
                            .join(' '),
                        userApproved: args.userApproved,
                        approver: args.approver
                    });
                    if (!approval.approved) return approval.reply;
                    if (production) store.recordDecision(`Allowed the quick start on ${url}, which looks like production`, 'Read-only health check', approval.by);
                    if (!scaffolded) {
                        const { written } = writePlanned(store, plan.files);
                        store.updateState(s => {
                            s.approvals.push({ what: `scaffold (${written.length} files, quick start)`, by: approval.by, at: new Date().toISOString(), note: approval.via });
                        });
                        store.recordDecision(`Created the test project: ${written.length} file(s) written`, 'test_my_app start', approval.by);
                        completeActionStep(store, 'SCAFFOLD', `Scaffolded ${plan.packId ?? 'TestPilot files'} (quick start)`);
                    }
                    if (needsInstall && options.mode !== 'remote') {
                        const cwd = store.resolve(inTestRoot(config, '.') || '.');
                        for (const command of plan.install) {
                            const outcome = await runCommand(cwd, command);
                            if (!outcome.ok) {
                                return failure(
                                    `The test project is created, but installing Playwright failed at \`${outcome.command}\`:\n${outcome.tail.split('\n').slice(-8).join('\n')}\n\nCommon causes: no internet, a company proxy, or Node.js missing. Call check_prerequisites for the fix, then call test_my_app with action "start" again (it continues where it stopped).`
                                );
                            }
                        }
                        store.write(INSTALLED_MARKER, JSON.stringify({ at: new Date().toISOString(), commands: plan.install.map(c => c.join(' ')) }, null, 2) + '\n');
                    }
                }

                const check = await runHealthCheck(store, config, url, args.maxPages, Boolean(site.selfSigned));
                if ('fatal' in check) return failure(check.fatal ?? 'The check could not run.');
                const { report, pages } = check;

                // Starter tests: written once as a plain CSV the user can read and edit; re-imported on every start.
                let starters = 0;
                if (!store.exists(STARTER_CASES_FILE)) {
                    const drafts = starterCases(pages);
                    if (drafts.length) store.write(STARTER_CASES_FILE, starterCasesCsv(drafts));
                }
                if (store.exists(STARTER_CASES_FILE)) {
                    const imported = await runImport(store, 'csv', { location: STARTER_CASES_FILE, env: loadEnvValues(store), limit: 200 }, false);
                    const ids = new Set([...imported.added, ...imported.updated]);
                    const toReview = store.readCases().filter(tc => ids.has(tc.id) || (tc.id.startsWith(`${STARTER_PREFIX}-`) && !tc.review));
                    if (toReview.length) reviewAndStore(store, toReview);
                    starters = imported.cases.length;
                }
                const hasLogin = Boolean(store.read(ENV_FILE)?.match(/^TEST_USER_EMAIL=\S+/m));
                const summary = [
                    `The test project is ready, and I checked ${report.pagesChecked} page(s) of ${url}.`,
                    report.verdict,
                    ...findingLines(report.findings),
                    report.good.length ? `Good news: ${report.good.join(' ')}` : '',
                    `Full report (with what to do about each problem): ${HEALTH_DIR}/report.md. Screenshots: .testpilot/exploration/screenshots/.`,
                    '',
                    starters ? `I also wrote ${starters} starter test(s) in plain English in ${STARTER_CASES_FILE}: each page opens, and the main links go to the right page. The user can read and change that file.` : 'I could not draft starter tests from these pages; describe what the app should do and I will write them.',
                    report.signIn && !hasLogin
                        ? `I found a sign-in page (${report.signIn.path}). To test what is behind it, the user creates a test account (not their own), copies .env.example to .env and fills in TEST_USER_EMAIL and TEST_USER_PASSWORD there themselves. Never ask for the password in chat.`
                        : '',
                    '',
                    starters ? 'Next: ask the user "Shall I turn these into automated tests and run them?" and, after a yes, call test_my_app with action "make-tests" and userApproved: true.' : '',
                    PLAIN_RULES
                ].filter(Boolean);
                return result(summary.join('\n'), { url, report, starterCases: starters, starterFile: starters ? STARTER_CASES_FILE : null, reportFile: `${HEALTH_DIR}/report.md` });
            }
        )
    );
}
