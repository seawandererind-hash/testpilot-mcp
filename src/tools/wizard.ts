import { acceptedContent, type CallToolResult, inputRequired, type InputRequiredResult, inputResponse, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { RepoDetection } from '../core/detect.js';
import { checkPrerequisites } from '../core/prereqs.js';
import type { ProjectStore } from '../core/store.js';
import { answerStep, currentStepId, resetToStep, STEP_IDS, type StepView, viewStep, type WizardContext } from '../core/wizard.js';
import { regenerateKnowledge } from './scaffold.js';
import { clientSupportsForms, guarded, openProject, projectRootArg, READ_ONLY, result, type ServerOptions, WRITES_STATE } from './common.js';

/** Saves an answer; once the framework exists, also refreshes AGENTS.md and the skills so every AI tool sees the change. */
function answerAndSync(store: ProjectStore, detection: RepoDetection, step: string, answer: string | string[]) {
    const out = answerStep(store, detection, step, answer);
    if (store.readState().completed.includes('SCAFFOLD')) {
        const { written } = regenerateKnowledge(store);
        if (written.length) return { ...out, saved: `${out.saved} (updated ${written.length} AI instruction file(s))` };
    }
    return out;
}

function describeStep(view: StepView): string {
    const lines = [`${view.progress}: ${view.title}`, '', view.question, `Why it matters: ${view.why}`];
    if (view.options?.length) {
        lines.push('', 'Options:');
        for (const o of view.options) {
            const rec = Array.isArray(view.recommended) ? view.recommended.includes(o.value) : view.recommended === o.value;
            lines.push(`- ${o.label} [${o.value}]${rec ? ' ★ recommended' : ''}: ${o.description}`);
        }
        if (view.allowFreeText) lines.push('- Or type any other value.');
    }
    if (view.action) lines.push('', `This is an action step. Tools: ${view.action.tools.join(', ')}.`, view.action.instructions);
    else lines.push('', `Ask the user this question in plain words (show the recommendation), then call wizard with action "answer", step "${view.step}" and their answer.`);
    return lines.join('\n');
}

function elicitSchema(view: StepView) {
    const values = (view.options ?? []).map(o => o.value) as [string, ...string[]];
    const optionList = (view.options ?? []).map(o => `${o.value} = ${o.label}`).join('; ');
    if (view.kind === 'text') return z.object({ answer: z.string().min(1).meta({ title: view.question, description: view.why }) });
    if (view.kind === 'multi') {
        return z.object({ answer: z.array(z.enum(values)).meta({ title: view.question, description: `${view.why} Choices: ${optionList}` }) });
    }
    const base = { answer: z.enum(values).meta({ title: view.question, description: `${view.why} Choices: ${optionList}` }) };
    return view.allowFreeText ? z.object({ ...base, other: z.string().optional().meta({ title: 'Or type another value', description: 'Leave empty to use the choice above.' }) }) : z.object(base);
}

export function registerWizardTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'testpilot_status',
        {
            title: 'TestPilot status',
            description:
                'Shows where this repository is in the TestPilot workflow: saved choices, completed steps, approvals and the next step. Call this first in any conversation about test automation in this repo, including when resuming in a different AI tool.',
            inputSchema: z.object({ projectRoot: projectRootArg }),
            annotations: READ_ONLY
        },
        guarded('testpilot_status', options, async ({ projectRoot }: { projectRoot?: string }) => {
            const { store, detection } = openProject(options, projectRoot);
            const state = store.readState();
            const config = store.readConfig();
            const ctx: WizardContext = { config, state, detection: detection() };
            const next = currentStepId(ctx);
            const view = next ? viewStep(next, ctx) : undefined;
            const cases = store.readCases();
            const summary = store.hasConfig()
                ? `TestPilot is set up in ${store.root}. ${view ? `Next: ${view.progress}, ${view.title}.` : 'All wizard steps are done.'} ${cases.length} test case(s) imported.`
                : `TestPilot has not been set up in ${store.root} yet. Start with the wizard (action "next").`;
            return result(summary, {
                root: store.root,
                initialised: store.hasConfig(),
                config,
                completedSteps: state.completed,
                approvals: state.approvals,
                testCases: cases.length,
                nextStep: view ?? null
            });
        })
    );

    server.registerTool(
        'detect_repo',
        {
            title: 'Detect repository',
            description: 'Looks at the repository without changing anything: languages, build tools, existing test frameworks, CI files and git remote.',
            inputSchema: z.object({ projectRoot: projectRootArg }),
            annotations: READ_ONLY
        },
        guarded('detect_repo', options, async ({ projectRoot }: { projectRoot?: string }) => {
            const { detection } = openProject(options, projectRoot);
            const d = detection();
            const frameworks = d.testFrameworks.map(f => f.name).join(', ') || 'none';
            return result(`Languages: ${d.languages.map(l => l.language).join(', ') || 'none found'}. Test frameworks: ${frameworks}. CI: ${d.ci.join(', ') || 'none'}.`, { ...d });
        })
    );

    server.registerTool(
        'check_prerequisites',
        {
            title: 'Check prerequisites',
            description:
                'Checks that the tools this setup needs are installed on this computer (Node.js, Java, Android SDK, Xcode, Appium, …) and reports proxy or private-registry settings, with fix instructions per operating system. Uses the saved app type and framework unless given.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                appType: z.string().optional().describe('Override the saved app type'),
                framework: z.string().optional(),
                language: z.string().optional()
            }),
            annotations: { ...READ_ONLY, idempotentHint: true }
        },
        guarded('check_prerequisites', options, async ({ projectRoot, appType, framework, language }: { projectRoot?: string; appType?: string; framework?: string; language?: string }) => {
            const { store } = openProject(options, projectRoot);
            const config = store.readConfig();
            const outcome = await checkPrerequisites((appType ?? config.appType) as never, framework ?? config.stack.framework, language ?? config.stack.language, config.execution.target);
            const missing = outcome.results.filter(r => !r.found && r.required);
            const summary = missing.length ? `Missing: ${missing.map(m => m.name).join(', ')}. Fixes are listed per item.` : 'Everything this setup needs is installed.';
            return result(summary, { ...outcome, platform: process.platform });
        })
    );

    server.registerTool(
        'wizard',
        {
            title: 'TestPilot setup wizard',
            description:
                'The guided setup, one question at a time. action "next" returns the current question (or shows a form when the AI tool supports it); action "answer" saves an answer for a step and returns the next question; action "back" re-opens an earlier step. Every answer is saved in .testpilot/ in the repository, so the setup can be resumed from any AI tool. Ask the user each question yourself; never invent answers.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                action: z.enum(['next', 'answer', 'back']).default('next'),
                step: z.enum(STEP_IDS as [string, ...string[]]).optional().describe('Step id, required for "answer" and "back"'),
                answer: z.union([z.string(), z.array(z.string())]).optional().describe('The user\'s answer: an option value, or free text where allowed. For multi-choice steps, a list.'),
                interactive: z.boolean().default(true).describe('When true and the AI tool supports forms, ask the user directly with a form.')
            }),
            annotations: WRITES_STATE
        },
        guarded(
            'wizard',
            options,
            async (args: { projectRoot?: string; action: 'next' | 'answer' | 'back'; step?: string; answer?: string | string[]; interactive: boolean }, rawCtx: unknown): Promise<CallToolResult | InputRequiredResult> => {
                const ctx = rawCtx as ServerContext;
                const { store, detection } = openProject(options, args.projectRoot);
                if (!store.hasConfig()) {
                    store.writeConfig(store.readConfig());
                    store.writeState(store.readState());
                    store.recordDecision('Started TestPilot in this repository', 'Wizard started', 'user');
                }
                const wctx = (): WizardContext => ({ config: store.readConfig(), state: store.readState(), detection: detection() });

                if (args.action === 'back') {
                    if (!args.step) throw new Error('Give the step to go back to.');
                    resetToStep(store, args.step);
                    const view = viewStep(args.step, wctx());
                    return result(describeStep(view), { step: view });
                }

                if (args.action === 'answer') {
                    const step = args.step ?? currentStepId(wctx());
                    if (!step) return result('The wizard is complete.', { done: true });
                    if (args.answer === undefined) throw new Error('Give the user\'s answer in "answer".');
                    const { saved, next } = answerAndSync(store, detection(), step, args.answer);
                    return result(`Saved. ${saved}.${next ? `\n\nNext question:\n${describeStep(next)}` : '\n\nThe wizard is complete.'}`, { saved, next: next ?? null, done: !next });
                }

                // action === 'next'
                const current = currentStepId(wctx());
                if (!current) return result('The wizard is complete. Use testpilot_status to see the saved setup.', { done: true });
                const view = viewStep(current, wctx());

                const canForm = args.interactive && view.kind !== 'action' && clientSupportsForms(server, ctx as never);
                if (canForm) {
                    const key = `answer_${view.step}`;
                    const schema = elicitSchema(view);
                    const reply = inputResponse(ctx.mcpReq.inputResponses, key);
                    if (reply.kind === 'elicit' && reply.action !== 'accept') {
                        return result(`The user closed the form. Ask the question in chat instead.\n\n${describeStep(view)}`, { step: view, formDeclined: true });
                    }
                    const accepted = acceptedContent(ctx.mcpReq.inputResponses, key, schema) as { answer: string | string[]; other?: string } | undefined;
                    if (!accepted) {
                        return inputRequired({ inputRequests: { [key]: inputRequired.elicit({ message: `${view.progress}: ${view.question}`, requestedSchema: schema }) } });
                    }
                    const answer = accepted.other?.trim() ? accepted.other.trim() : accepted.answer;
                    const { saved, next } = answerAndSync(store, detection(), view.step, answer);
                    return result(`The user answered in the form. ${saved}.${next ? `\n\nNext question:\n${describeStep(next)}` : '\n\nThe wizard is complete.'}`, { saved, next: next ?? null, done: !next });
                }
                return result(describeStep(view), { step: view });
            }
        )
    );
}
