import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { isLikelyProduction } from '../core/app-target.js';
import { resolveBaseUrl } from '../core/env.js';
import { completeActionStep } from '../core/wizard.js';
import { readPlanMeta } from '../plan/plan.js';
import { type RunSummary, runPlaywright, saveRun } from '../run/playwright.js';
import { inTestRoot } from '../scaffold/engine.js';
import { approverArg, failure, guarded, openProject, projectRootArg, requireApproval, result, type ServerOptions, userApprovedArg } from './common.js';

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeRun(run: RunSummary, saved: string): string {
    const s = run.stats;
    if (!s.total) {
        return `No test results were produced (exit code ${run.exitCode}).${run.consoleTail ? `\n\nLast output:\n${run.consoleTail}` : ''}\n\nIf no tests matched, check the ids or wave. If the report is missing, make sure playwright.config.ts still has the json reporter writing test-results/results.json.`;
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
        else if (shot) lines.push(`Screenshot: ${shot.path}`);
    }
    if (bad.length > 15) lines.push('', `…and ${bad.length - 15} more in ${saved}.`);
    lines.push('', `Saved to ${saved}.`);
    if (!bad.length && run.repeat < 2) lines.push('All passed. Run again with stabilityRuns: 2 to confirm they are stable before calling them done.');
    if (bad.length) lines.push('Propose fixes as diffs for the user to review. Never delete or weaken an assertion to make a test pass without their agreement; if the app is wrong, it is a bug to report.');
    return lines.join('\n');
}

export function registerRunTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'run_tests',
        {
            title: 'Run tests',
            description:
                'Runs the Playwright tests (all, a plan wave, specific test-case ids, files or @tags), then reports each failure with its likely cause (environment, locator, assertion, timing, data, script), advice, and the trace to open. stabilityRuns: 2 runs each test twice without retries to prove it is stable; flaky tests are flagged. Results go to .testpilot/runs/ and update each case\'s status. Refuses production-looking addresses unless the user explicitly allows it.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                ids: z.array(z.string()).optional().describe('Test-case ids to run'),
                wave: z.number().int().min(1).optional().describe('Run the tests of this plan wave'),
                files: z.array(z.string()).optional().describe('Spec files, relative to the test root'),
                tag: z.string().regex(/^@[\w-]+$/).optional().describe('Only tests with this tag, e.g. @smoke'),
                project: z.string().optional().describe('Playwright project (browser) to run, e.g. chromium'),
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
                if (!config.stack.framework?.startsWith('playwright')) {
                    return failure(`run_tests drives Playwright today. For ${config.stack.framework ?? 'this framework'}, run the command from AGENTS.md ("How to run tests") in a terminal and share the output.`);
                }
                const testRoot = inTestRoot(config, '.') || '.';
                if (!store.exists(`${testRoot}/node_modules/@playwright/test`) && !store.exists('node_modules/@playwright/test')) {
                    return failure('Playwright is not installed yet. Run npm install, then npx playwright install chromium (check_prerequisites lists anything missing).');
                }
                const baseUrl = resolveBaseUrl(store, config);
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
                const run = await runPlaywright(store, {
                    cwd: store.resolve(testRoot),
                    files,
                    grep: grepParts.length ? grepParts.join('|') : undefined,
                    repeat: args.stabilityRuns,
                    project: args.project,
                    workers: args.workers,
                    timeoutMs: args.timeoutMinutes * 60_000,
                    reportFile: 'test-results/results.json'
                });
                run.baseUrl = baseUrl;
                const saved = saveRun(store, run);

                // Record each case's latest status.
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
                return result(describeRun(run, saved), { run: { ...run, tests: run.tests.slice(0, 100) }, saved });
            }
        )
    );
}
