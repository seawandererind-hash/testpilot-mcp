import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { isLikelyProduction } from '../core/app-target.js';
import { resolveBaseUrl } from '../core/env.js';
import type { ProjectStore } from '../core/store.js';
import { completeActionStep } from '../core/wizard.js';
import { readPlanMeta } from '../plan/plan.js';
import { usesAppium } from '../explore/mobile.js';
import { runMaven } from '../run/maven.js';
import { type RunSummary, runPlaywright, saveRun } from '../run/playwright.js';
import { categoriseAppium, runWdio } from '../run/wdio.js';
import { inTestRoot } from '../scaffold/engine.js';
import { approverArg, failure, guarded, openProject, projectRootArg, requireApproval, result, type ServerOptions, userApprovedArg } from './common.js';

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function describeRun(run: RunSummary, saved: string, runner: 'playwright' | 'wdio' | 'maven' = 'playwright'): string {
    const s = run.stats;
    if (!s.total) {
        const triage = runner === 'wdio' && run.consoleTail ? categoriseAppium(run.consoleTail) : undefined;
        const reporterHint =
            runner === 'wdio'
                ? 'If the results are missing, make sure the wdio config still lists TestPilotReporter (writing test-results/testpilot/).'
                : runner === 'maven'
                  ? 'If the results are missing, make sure TestPilotListener is still registered (testng.xml or @Listeners) so target/testpilot/results.json is written, and that `mvn -v` works.'
                  : 'If the report is missing, make sure playwright.config.ts still has the json reporter writing test-results/results.json.';
        return `No test results were produced (exit code ${run.exitCode}).${triage && triage.category !== 'unknown' ? `\nLikely cause: ${triage.category}. ${triage.advice}` : ''}${run.consoleTail ? `\n\nLast output:\n${run.consoleTail}` : ''}\n\nIf no tests matched, check the ids or wave. ${reporterHint}`;
    }
    const lines = [`${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky, ${s.skipped} skipped${run.repeat > 1 ? ` (each test ran ${run.repeat} times)` : ''} in ${Math.round(s.durationMs / 1000)}s.`];
    const bad = run.tests.filter(t => t.status === 'failed' || t.status === 'flaky');
    for (const t of bad.slice(0, 15)) {
        lines.push('', `${t.status === 'flaky' ? 'Flaky' : 'Failed'}: ${t.title}${t.project ? ` [${t.project}]` : ''} (${t.file}${t.line ? `:${t.line}` : ''})${t.status === 'flaky' ? `, passed ${t.passes} of ${t.runs}` : ''}`);
        if (t.category) lines.push(`Likely cause: ${t.category}. ${t.advice}`);
        if (t.error) lines.push(`Error: ${t.error.split('\n').slice(0, 4).join(' | ')}`);
        const trace = t.attachments.find(a => a.name === 'trace');
        const shot = t.attachments.find(a => a.name === 'screenshot');
        if (trace) lines.push(`Trace: npx playwright show-trace ${trace.path}`);
        else if (runner === 'maven' && run.reportFile) lines.push(`Details: ${run.reportFile}/`);
        else if (shot) lines.push(`Screenshot: ${shot.path}`);
    }
    if (bad.length > 15) lines.push('', `…and ${bad.length - 15} more in ${saved}.`);
    if (run.consoleTail && runner === 'wdio' && run.exitCode !== 0) lines.push('', `Some specs produced no results. Last output:\n${run.consoleTail}`);
    lines.push('', `Saved to ${saved}.`);
    if (!bad.length && run.repeat < 2) lines.push('All passed. Run again with stabilityRuns: 2 to confirm they are stable before calling them done.');
    if (bad.length) lines.push('Propose fixes as diffs for the user to review. Never delete or weaken an assertion to make a test pass without their agreement; if the app is wrong, it is a bug to report.');
    return lines.join('\n');
}

/** Saves a run and each case's latest status; the RUN step completes after two clean runs in a row. */
export function recordRun(store: ProjectStore, run: RunSummary): string {
    const saved = saveRun(store, run);
    const byId = new Map<string, string>();
    for (const t of run.tests) {
        const prev = byId.get(t.id);
        const status = t.status === 'passed' ? 'passing' : t.status === 'skipped' ? undefined : 'failing';
        if (status && prev !== 'failing') byId.set(t.id, status);
    }
    for (const [id, status] of byId) {
        const tc = store.readCase(id);
        if (tc && tc.automation?.status !== status) {
            tc.automation = { ...tc.automation, status: status as 'passing' | 'failing' };
            store.writeCase(tc);
        }
    }
    store.updateState(s => {
        s.lastRun = run.finishedAt;
    });
    const allGood = run.stats.total > 0 && run.stats.failed === 0 && run.stats.flaky === 0;
    if (allGood && run.repeat >= 2 && store.hasConfig()) completeActionStep(store, 'RUN', `${run.stats.passed} test(s) passed ${run.repeat} times in a row`);
    return saved;
}

export function registerRunTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'run_tests',
        {
            title: 'Run tests',
            description:
                'Runs the tests (Playwright for web, Selenium + Java through Maven, WebdriverIO + Appium for mobile and desktop apps): all, a plan wave, specific test-case ids, files or @tags. Reports each failure with its likely cause (environment, locator, assertion, timing, data, script), advice, and the trace or screenshot to open. stabilityRuns: 2 runs each test twice without retries to prove it is stable; flaky tests are flagged. Results go to .testpilot/runs/ and update each case\'s status. Refuses production-looking addresses unless the user explicitly allows it. Appium runs need the Appium server running (npm run appium) or, for BrowserStack, the bs:// app id in .env.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                ids: z.array(z.string()).optional().describe('Test-case ids to run'),
                wave: z.number().int().min(1).optional().describe('Run the tests of this plan wave'),
                files: z.array(z.string()).optional().describe('Spec files, relative to the test root'),
                tag: z.string().regex(/^@[\w-]+$/).optional().describe('Only tests with this tag, e.g. @smoke'),
                project: z.string().optional().describe('Playwright project (browser) to run, e.g. chromium. Ignored for Appium runs.'),
                stabilityRuns: z.number().int().min(1).max(10).default(1),
                workers: z.number().int().min(1).max(16).optional(),
                timeoutMinutes: z.number().min(1).max(120).default(20),
                allowProduction: z.boolean().default(false),
                userApproved: userApprovedArg,
                approver: approverArg
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        guarded(
            'run_tests',
            options,
            async (
                args: {
                    projectRoot?: string;
                    ids?: string[];
                    wave?: number;
                    files?: string[];
                    tag?: string;
                    project?: string;
                    stabilityRuns: number;
                    workers?: number;
                    timeoutMinutes: number;
                    allowProduction: boolean;
                    userApproved?: boolean;
                    approver?: string;
                },
                ctx: unknown
            ) => {
                const { store } = openProject(options, args.projectRoot);
                const config = store.readConfig();
                const wdio = usesAppium(config) && config.stack.language === 'typescript';
                const maven = config.stack.templatePack === 'selenium-java';
                if (!config.stack.framework?.startsWith('playwright') && !wdio && !maven) {
                    return failure(`run_tests drives Playwright, the Selenium + Java template and the TypeScript Appium template today. For ${config.stack.framework ?? 'this framework'}, run the command from AGENTS.md ("How to run tests") in a terminal and share the output.`);
                }
                const testRoot = inTestRoot(config, '.') || '.';
                let wdioConfig = 'wdio.conf.ts';
                if (maven) {
                    if (!store.exists(inTestRoot(config, 'pom.xml'))) return failure(`${inTestRoot(config, 'pom.xml')} is missing. Run preview_scaffold and scaffold_project to create the Maven project.`);
                } else if (wdio) {
                    if (!store.exists(`${testRoot}/node_modules/@wdio/cli`) && !store.exists('node_modules/@wdio/cli')) {
                        return failure('WebdriverIO is not installed yet. Run npm install in the test folder (check_prerequisites lists anything else missing).');
                    }
                    if (config.execution.target === 'browserstack') wdioConfig = 'wdio.browserstack.conf.ts';
                    if (!store.exists(inTestRoot(config, wdioConfig))) return failure(`${inTestRoot(config, wdioConfig)} is missing. Run preview_scaffold and scaffold_project to create it.`);
                } else if (!store.exists(`${testRoot}/node_modules/@playwright/test`) && !store.exists('node_modules/@playwright/test')) {
                    return failure('Playwright is not installed yet. Run npm install, then npx playwright install chromium (check_prerequisites lists anything missing).');
                }
                // Mobile and desktop apps have no address to protect; web and API runs do.
                const baseUrl = wdio && config.app.kind !== 'url' ? undefined : resolveBaseUrl(store, config);
                if (baseUrl && isLikelyProduction(baseUrl)) {
                    if (!args.allowProduction) return failure(`Tests would run against ${baseUrl}, which does not look like a test environment. Point APP_BASE_URL at a test or staging address. If the user really wants this, ask them and call again with allowProduction: true.`);
                    const approval = requireApproval(server, ctx, { key: 'run-production', question: `Run tests against ${baseUrl}? It looks like production, and tests may create or change data there.`, userApproved: args.userApproved, approver: args.approver });
                    if (!approval.approved) return approval.reply;
                    store.recordDecision(`Allowed a test run against ${baseUrl}`, 'Production-looking address', approval.by);
                }

                let ids = args.ids ?? [];
                if (args.wave !== undefined) {
                    const meta = readPlanMeta(store);
                    const wave = meta?.waves.find(w => w.number === args.wave);
                    if (!wave) return failure(`The plan has no wave ${args.wave}.`);
                    const generated = new Set(store.readCases().filter(tc => tc.automation?.specFile).map(tc => tc.id));
                    ids = [...ids, ...wave.ids.filter(id => generated.has(id))];
                    if (!ids.length) return failure(`No tests of wave ${args.wave} have been generated yet.`);
                }
                const grepParts: string[] = [];
                if (ids.length) grepParts.push(`@(${ids.map(escapeRegExp).join('|')})(\\s|$)`);
                if (args.tag) grepParts.push(`${escapeRegExp(args.tag)}(\\s|$)`);
                const files = (args.files ?? []).map(f => {
                    store.resolve(inTestRoot(config, f));
                    return f;
                });
                const grep = grepParts.length ? grepParts.join('|') : undefined;
                if (maven && files.length) return failure('Maven runs select tests by id or tag (groups and Cucumber tags), not by file. Pass ids, wave or tag instead.');
                const run = maven
                    ? await runMaven(store, config, { cwd: store.resolve(testRoot), ids, tag: args.tag, bdd: config.stack.pattern === 'bdd', repeat: args.stabilityRuns, timeoutMs: args.timeoutMinutes * 60_000 })
                    : wdio
                    ? await runWdio(store, { cwd: store.resolve(testRoot), configFile: wdioConfig, specs: files, grep, repeat: args.stabilityRuns, timeoutMs: args.timeoutMinutes * 60_000, resultsDir: 'test-results/testpilot' })
                    : await runPlaywright(store, {
                          cwd: store.resolve(testRoot),
                          files,
                          grep,
                          repeat: args.stabilityRuns,
                          project: args.project,
                          workers: args.workers,
                          timeoutMs: args.timeoutMinutes * 60_000,
                          reportFile: 'test-results/results.json',
                          bdd: config.stack.pattern === 'bdd'
                      });
                run.baseUrl = baseUrl;
                const saved = recordRun(store, run);
                return result(describeRun(run, saved, maven ? 'maven' : wdio ? 'wdio' : 'playwright'), { run: { ...run, tests: run.tests.slice(0, 100) }, saved });
            }
        )
    );
}
