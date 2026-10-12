import { createHash } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { CI_PROVIDERS } from '../core/schema.js';
import { loadEnvValues } from '../core/env.js';
import { completeActionStep } from '../core/wizard.js';
import { IntegrationError } from '../integrations/http.js';
import { SYNC_TARGETS, type SyncTarget, syncPreview, syncResults } from '../integrations/sync.js';
import { readPlanMeta } from '../plan/plan.js';
import { planCi } from '../report/ci.js';
import { collectReport, renderReportHtml, renderReportMarkdown, REPORTS_DIR } from '../report/report.js';
import { readLatestRun } from '../run/playwright.js';
import { writePlanned } from '../scaffold/engine.js';
import { approverArg, EXTERNAL, failure, guarded, openProject, projectRootArg, requireApproval, result, type ServerOptions, userApprovedArg } from './common.js';

const SOURCE_TO_TARGET: Record<string, SyncTarget> = { xray: 'xray', zephyr: 'zephyr', testrail: 'testrail', browserstack: 'browserstack', 'azure-devops': 'azure-devops' };

export function registerPublishTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'publish_results',
        {
            title: 'Report, CI and result sync',
            description:
                'action "report" writes a readable report of the latest run (.testpilot/reports/latest.md and a self-contained latest.html for managers) with progress against the plan, failures by cause, flaky tests and the pass-rate trend. action "ci" previews, then (with confirmToken and approval) writes the pipeline for GitHub Actions, Azure DevOps, GitLab or Jenkins and lists the secrets to add there. action "sync" previews, then (with confirmToken and the user\'s explicit approval) sends the latest results to Xray, Zephyr, TestRail, BrowserStack Test Management or Azure Test Plans.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                action: z.enum(['report', 'ci', 'sync']),
                provider: z.enum(CI_PROVIDERS).optional().describe('CI system for action "ci" (default: the saved choice)'),
                target: z.enum(SYNC_TARGETS).optional().describe('Test-management tool for action "sync" (default: where the cases came from)'),
                projectKey: z.string().optional().describe('Jira project key for Xray or Zephyr (default: JIRA_PROJECT_KEY or the test-case id prefix)'),
                projectId: z.string().optional().describe('TestRail project id or BrowserStack Test Management project (default from .env)'),
                suiteId: z.string().optional(),
                planId: z.string().optional().describe('Azure Test Plans plan id'),
                runName: z.string().optional(),
                confirmToken: z.string().optional().describe('From the preview of action "ci" or "sync"'),
                overwrite: z.boolean().default(false).describe('Replace an existing pipeline file (action "ci")'),
                userApproved: userApprovedArg,
                approver: approverArg
            }),
            annotations: EXTERNAL
        },
        guarded(
            'publish_results',
            options,
            async (
                args: {
                    projectRoot?: string;
                    action: 'report' | 'ci' | 'sync';
                    provider?: string;
                    target?: SyncTarget;
                    projectKey?: string;
                    projectId?: string;
                    suiteId?: string;
                    planId?: string;
                    runName?: string;
                    confirmToken?: string;
                    overwrite: boolean;
                    userApproved?: boolean;
                    approver?: string;
                },
                ctx: unknown
            ) => {
                const { store } = openProject(options, args.projectRoot);
                const config = store.readConfig();

                if (args.action === 'report') {
                    const run = readLatestRun(store);
                    const data = collectReport(store, config, run, store.readCases(), readPlanMeta(store));
                    const stamp = data.generatedAt.slice(0, 10);
                    store.write(`${REPORTS_DIR}/latest.md`, renderReportMarkdown(data));
                    store.write(`${REPORTS_DIR}/latest.html`, renderReportHtml(data));
                    store.write(`${REPORTS_DIR}/report-${stamp}.html`, renderReportHtml(data));
                    if (store.hasConfig() && (!config.integrations.ci || config.integrations.ci === 'none')) completeActionStep(store, 'REPORT', 'Report written');
                    const r = data.run;
                    return result(
                        `${r ? `Latest run: ${r.stats.passed} passed, ${r.stats.failed} failed, ${r.stats.flaky} flaky.` : 'No run yet; the report shows plan progress only.'} Progress: ${data.progress.passing} passing of ${data.progress.planned} planned (${data.progress.manual} manual, ${data.progress.rework} need rework).\nReport: ${REPORTS_DIR}/latest.html (open in a browser) and ${REPORTS_DIR}/latest.md.`,
                        { files: [`${REPORTS_DIR}/latest.md`, `${REPORTS_DIR}/latest.html`], progress: data.progress, areas: data.areas }
                    );
                }

                if (args.action === 'ci') {
                    const plan = planCi(store, config, args.provider);
                    if ('error' in plan) return failure(plan.error);
                    const token = `ci-${createHash('sha256').update(plan.file.path + plan.file.status + plan.file.content).digest('hex').slice(0, 20)}`;
                    const setup = `Add these in ${plan.where}:${plan.secrets.length ? `\n- Secrets: ${plan.secrets.join(', ')}` : ''}${plan.variables.length ? `\n- Variables: ${plan.variables.join(', ')}` : ''}`;
                    if (plan.file.status === 'unchanged') return result(`${plan.file.path} is already up to date.\n\n${setup}`, { file: plan.file.path, secretNames: plan.secrets, variableNames: plan.variables });
                    if (!args.confirmToken) {
                        return result(
                            `${plan.file.status === 'new' ? 'Would create' : 'A different version exists at'} ${plan.file.path}${plan.file.status === 'conflict' ? ' (pass overwrite: true to replace it)' : ''}.\n\n${setup}\n\nShow the user the pipeline below, then call publish_results with action "ci" and this confirmToken after they agree.\n\n${plan.file.content}`,
                            { confirmToken: token, file: plan.file.path, status: plan.file.status, secretNames: plan.secrets, variableNames: plan.variables }
                        );
                    }
                    if (args.confirmToken !== token) return failure('The pipeline changed since the preview. Preview again (action "ci" without confirmToken).');
                    if (plan.file.status === 'conflict' && !args.overwrite) return failure(`${plan.file.path} already exists with different content. Pass overwrite: true only if the user agreed to replace it.`);
                    const approval = requireApproval(server, ctx, { key: 'ci', question: `Write the ${plan.provider} pipeline to ${plan.file.path}?`, userApproved: args.userApproved, approver: args.approver });
                    if (!approval.approved) return approval.reply;
                    writePlanned(store, [plan.file], args.overwrite ? [plan.file.path] : []);
                    store.recordDecision(`Added the ${plan.provider} pipeline (${plan.file.path})`, `Approved ${approval.via === 'form' ? 'in a form' : 'in chat'}`, approval.by);
                    if (store.hasConfig()) completeActionStep(store, 'REPORT', `CI pipeline written for ${plan.provider}`);
                    return result(`Wrote ${plan.file.path}.\n\n${setup}\n\nCommit it to start running tests in CI.`, { file: plan.file.path, secretNames: plan.secrets, variableNames: plan.variables });
                }

                // sync
                const target = args.target ?? SOURCE_TO_TARGET[config.integrations.testCaseSource ?? ''];
                if (!target) return failure(`Say where to send results (target: ${SYNC_TARGETS.join(', ')}).`);
                const run = readLatestRun(store);
                if (!run || !run.tests.length) return failure('No test results yet. Run the tests with run_tests first.');
                const env = loadEnvValues(store);
                const idPrefix = run.tests.map(t => t.id.match(/^([A-Z][A-Z0-9_]*)-\d+$/)?.[1]).find(Boolean);
                const syncOptions = {
                    projectKey: args.projectKey ?? env.JIRA_PROJECT_KEY ?? idPrefix,
                    projectId: args.projectId ?? (target === 'testrail' ? env.TESTRAIL_PROJECT_ID : target === 'browserstack' ? env.BROWSERSTACK_TM_PROJECT_ID : undefined),
                    suiteId: args.suiteId,
                    planId: args.planId,
                    runName: args.runName ?? `TestPilot run ${run.startedAt.slice(0, 16).replace('T', ' ')}`
                };
                const preview = syncPreview(target, run, syncOptions);
                if (preview.needs.length) return failure(`Before sending results to ${target}, give: ${preview.needs.join(', ')}.`);
                const token = `sync-${createHash('sha256').update(JSON.stringify({ target, syncOptions, run: run.startedAt, ids: preview.send.map(t => [t.id, t.status]) })).digest('hex').slice(0, 20)}`;
                const counts = `${preview.send.filter(t => t.status === 'passed').length} passed, ${preview.send.filter(t => t.status !== 'passed').length} failed or flaky`;
                if (!args.confirmToken) {
                    return result(
                        `Would send ${preview.send.length} result(s) (${counts}) from the run of ${run.startedAt.slice(0, 16).replace('T', ' ')} to ${target}${syncOptions.projectKey && (target === 'xray' || target === 'zephyr') ? ` project ${syncOptions.projectKey}` : syncOptions.projectId ? ` project ${syncOptions.projectId}` : ''} as "${syncOptions.runName}".${preview.skipped.length ? `\nLeft out: ${preview.skipped.join(', ')}.` : ''}\n\nThis changes data in ${target}. Ask the user explicitly, then call again with this confirmToken.`,
                        { confirmToken: token, target, options: syncOptions, results: preview.send.map(t => ({ id: t.id, status: t.status })), skipped: preview.skipped }
                    );
                }
                if (args.confirmToken !== token) return failure('The results or options changed since the preview. Preview the sync again.');
                const approval = requireApproval(server, ctx, { key: 'sync', question: `Send ${preview.send.length} test result(s) (${counts}) to ${target}?`, userApproved: args.userApproved, approver: args.approver });
                if (!approval.approved) return approval.reply;
                try {
                    const out = await syncResults(target, run, syncOptions, env);
                    store.recordDecision(`Sent ${out.sent} result(s) to ${target}${out.reference ? ` (${out.reference})` : ''}`, `Approved ${approval.via === 'form' ? 'in a form' : 'in chat'}`, approval.by);
                    if (store.hasConfig()) completeActionStep(store, 'REPORT', `Results sent to ${target}`);
                    return result(`Sent ${out.sent} result(s) to ${target}.${out.reference ? ` Reference: ${out.reference}.` : ''}${out.link ? ` ${out.link}` : ''}${out.note ? ` ${out.note}` : ''}`, { ...out });
                } catch (error) {
                    if (error instanceof IntegrationError) return failure(error.message);
                    throw error;
                }
            }
        )
    );
}
