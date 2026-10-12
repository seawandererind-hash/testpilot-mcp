import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { PLAN_FILE } from '../core/store.js';
import { completeActionStep } from '../core/wizard.js';
import { buildPlan, isApproved, PLAN_META_FILE, readPlanMeta, savePlan } from '../plan/plan.js';
import { approverArg, failure, guarded, openProject, projectRootArg, requireApproval, result, type ServerOptions, userApprovedArg, WRITES_STATE } from './common.js';

export function registerPlanTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'automation_plan',
        {
            title: 'Automation plan',
            description:
                'Builds and approves plans/automation-plan.md from the reviewed test cases. action "generate" groups cases into waves (critical paths first, then core regression, then the rest), lists what stays manual or needs rework, and notes risks. action "approve" records a named person\'s approval (in a form when the AI tool supports it); tests are generated only for an approved plan. action "show" returns the current plan. Regenerating a changed plan needs a new approval.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                action: z.enum(['generate', 'approve', 'show']).default('show'),
                wave1Size: z.number().int().min(1).max(100).default(15).describe('Most cases in wave 1'),
                wave2Size: z.number().int().min(1).max(500).default(40).describe('Most cases in wave 2'),
                userApproved: userApprovedArg,
                approver: approverArg
            }),
            annotations: WRITES_STATE
        },
        guarded(
            'automation_plan',
            options,
            async (args: { projectRoot?: string; action: 'generate' | 'approve' | 'show'; wave1Size: number; wave2Size: number; userApproved?: boolean; approver?: string }, ctx: unknown) => {
                const { store } = openProject(options, args.projectRoot);
                const config = store.readConfig();
                const existing = readPlanMeta(store);

                if (args.action === 'show') {
                    if (!existing) return failure('There is no plan yet. Call automation_plan with action "generate".');
                    return result(`${describe(existing)}\n\nPlan file: ${PLAN_FILE}`, { plan: existing, approved: isApproved(existing), file: PLAN_FILE });
                }

                if (args.action === 'generate') {
                    const cases = store.readCases();
                    if (!cases.length) return failure('No test cases yet. Import them with import_test_cases, then review_test_cases.');
                    if (!cases.some(tc => tc.review)) return failure('Review the test cases first (review_test_cases); the plan is built from the review verdicts.');
                    const meta = buildPlan(cases, { wave1Size: args.wave1Size, wave2Size: args.wave2Size });
                    const stillApproved = existing?.approved && existing.approved.digest === meta.digest;
                    if (stillApproved) meta.approved = existing!.approved;
                    const { planFileKept } = savePlan(store, meta, config);
                    store.recordDecision(`Generated the automation plan: ${meta.waves.map(w => `wave ${w.number} ${w.ids.length}`).join(', ')}; ${meta.manual.length} manual, ${meta.rework.length} rework`, 'automation_plan generate', 'testpilot');
                    const approvalNote = stillApproved ? 'The plan did not change, so the earlier approval still stands.' : existing?.approved ? 'The plan changed, so the earlier approval no longer applies. Ask for approval again.' : 'Ask the user who approves this plan, show them the waves, and call automation_plan with action "approve" only after they explicitly approve.';
                    return result(`${describe(meta)}\n\n${approvalNote}${planFileKept ? `\n\nNote: ${PLAN_FILE} no longer has TestPilot's header, so it was left as is; the plan data is in ${PLAN_META_FILE}.` : `\n\nWritten to ${PLAN_FILE}.`}`, {
                        plan: meta,
                        approved: Boolean(stillApproved),
                        file: PLAN_FILE
                    });
                }

                // approve
                if (!existing) return failure('Generate the plan first (action "generate").');
                if (isApproved(existing)) return result(`The plan was already approved by ${existing.approved!.by} on ${existing.approved!.at.slice(0, 10)}.`, { plan: existing, approved: true });
                if (!existing.waves.length) return failure('The plan has no cases to automate yet, so there is nothing to approve. Fix the cases that need rework first.');
                const approval = requireApproval(server, ctx, {
                    key: 'plan',
                    question: `Approve the automation plan? ${existing.waves.map(w => `Wave ${w.number} (${w.name}): ${w.ids.length} test(s)`).join('; ')}. ${existing.manual.length} stay manual.`,
                    userApproved: args.userApproved,
                    approver: args.approver
                });
                if (!approval.approved) return approval.reply;
                const at = new Date().toISOString();
                existing.approved = { by: approval.by, at, digest: existing.digest, via: approval.via };
                savePlan(store, existing, config);
                store.updateState(s => {
                    s.approvals.push({ what: 'automation plan', by: approval.by, at, note: `digest ${existing.digest.slice(0, 8)}` });
                });
                store.recordDecision(`Approved the automation plan (${existing.waves.map(w => `wave ${w.number}: ${w.ids.length}`).join(', ')})`, `Approved ${approval.via === 'form' ? 'in a form' : 'in chat'}`, approval.by);
                if (store.hasConfig()) completeActionStep(store, 'PLAN', `Automation plan approved by ${approval.by}`);
                return result(`Plan approved by ${approval.by}. Next: generate wave 1 with preview_tests, then generate_tests.`, { plan: existing, approved: true });
            }
        )
    );
}

function describe(meta: NonNullable<ReturnType<typeof readPlanMeta>>): string {
    const waves = meta.waves.map(w => `- Wave ${w.number}, ${w.name}: ${w.ids.length} test(s) (${w.ids.slice(0, 8).join(', ')}${w.ids.length > 8 ? ', …' : ''})`).join('\n');
    const status = isApproved(meta) ? `Approved by ${meta.approved!.by} on ${meta.approved!.at.slice(0, 10)}.` : 'Draft, waiting for approval.';
    return [
        `Automation plan (${status})`,
        waves || '- No cases are ready to automate yet.',
        meta.manual.length ? `- Kept manual: ${meta.manual.length}` : '',
        meta.rework.length ? `- Need rework first: ${meta.rework.length} (${meta.rework.slice(0, 8).join(', ')})` : '',
        meta.duplicates.length ? `- Duplicates left out: ${meta.duplicates.join(', ')}` : '',
        meta.unreviewed.length ? `- Not reviewed yet: ${meta.unreviewed.length}` : ''
    ]
        .filter(Boolean)
        .join('\n');
}
