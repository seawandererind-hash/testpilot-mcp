import { createHash } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { digestOf } from '../core/confirm.js';
import type { Config, TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { completeActionStep } from '../core/wizard.js';
import { readMobileExploration } from '../explore/mobile.js';
import { readExploration } from '../explore/web.js';
import { planApiTests } from '../generate/api.js';
import { planAppiumTests } from '../generate/appium.js';
import { type GenerationPlan, planPlaywrightTests } from '../generate/playwright.js';
import { planSeleniumTests } from '../generate/selenium.js';
import { isApproved, readPlanMeta } from '../plan/plan.js';
import { writePlanned } from '../scaffold/engine.js';
import { approverArg, failure, guarded, openProject, projectRootArg, READ_ONLY, requireApproval, result, type ServerOptions, userApprovedArg, WRITES_FILES } from './common.js';

interface Selection {
    cases: TestCase[];
    wave?: number;
    error?: string;
}

export function select(store: ProjectStore, wave: number | undefined, ids: string[] | undefined, includeGenerated: boolean): Selection {
    const meta = readPlanMeta(store);
    if (!meta) return { cases: [], error: 'There is no automation plan yet. Run automation_plan with action "generate", then get it approved.' };
    if (!isApproved(meta)) return { cases: [], error: 'The automation plan is not approved yet. Tests are generated only for an approved plan: ask the user who approves it and call automation_plan with action "approve".' };
    const planned = new Map(meta.waves.flatMap(w => w.ids.map(id => [id, w.number] as const)));
    const all = new Map(store.readCases().map(tc => [tc.id, tc]));
    if (ids?.length) {
        const outside = ids.filter(id => !planned.has(id));
        if (outside.length) return { cases: [], error: `Not in the approved plan: ${outside.join(', ')}. Regenerate and re-approve the plan to include them.` };
        return { cases: ids.map(id => all.get(id)).filter((tc): tc is TestCase => Boolean(tc)) };
    }
    const done = (tc: TestCase) => ['generated', 'passing', 'failing'].includes(tc.automation?.status ?? '');
    const target = wave ?? meta.waves.find(w => w.ids.some(id => all.get(id) && !done(all.get(id)!)))?.number;
    if (target === undefined) return { cases: [], error: 'Every planned test has been generated. Use ids to regenerate specific ones.' };
    const cases = (meta.waves.find(w => w.number === target)?.ids ?? []).map(id => all.get(id)).filter((tc): tc is TestCase => Boolean(tc) && (includeGenerated || !done(tc!)));
    return { cases, wave: target };
}

export function buildGeneration(store: ProjectStore, config: Config, cases: TestCase[]): { plan?: GenerationPlan; error?: string; token: string } {
    const pack = config.stack.templatePack;
    if (pack !== 'playwright-ts' && pack !== 'playwright-js' && pack !== 'appium-ts' && pack !== 'selenium-java') {
        return {
            error: `TestPilot generates code for Playwright (TypeScript or JavaScript: web, API, Electron), Selenium + Java (web) and Appium + WebdriverIO + TypeScript (mobile and desktop) today. For ${config.stack.framework ?? 'this framework'} in ${config.stack.language ?? 'this language'}, write the tests with the write-*-test skill in .agents/skills, one per case, using the plan and the normalized cases in .testpilot/test-cases/.`,
            token: ''
        };
    }
    const plan =
        pack === 'appium-ts'
            ? planAppiumTests(store, config, cases, readMobileExploration(store))
            : pack === 'selenium-java'
              ? planSeleniumTests(store, config, cases, readExploration(store))
              : config.appType === 'api'
                ? planApiTests(store, config, cases)
                : planPlaywrightTests(store, config, cases, readExploration(store));
    const fingerprint = plan.files.map(f => [f.path, f.status, createHash('sha256').update(f.content).digest('hex').slice(0, 16)]);
    return { plan, token: `tests-${digestOf(fingerprint).slice(0, 20)}` };
}

function describe(plan: GenerationPlan): string {
    const specs = plan.cases.filter(c => c.spec);
    const complete = specs.filter(c => !c.todos);
    const partial = specs.filter(c => c.todos);
    const lines = [`${specs.length} test(s): ${complete.length} complete, ${partial.length} with TODO(testpilot) steps to finish.`];
    const groups: Array<[string, string]> = [
        ['new', 'Create'],
        ['merge', 'Update (keeps your code)'],
        ['conflict', 'Exists and differs (kept unless listed in overwrite)'],
        ['skip', 'Left alone']
    ];
    for (const [status, label] of groups) {
        const files = plan.files.filter(f => f.status === status);
        if (files.length) lines.push(`${label}:`, ...files.map(f => `  - ${f.path}${f.note && status !== 'new' ? `: ${f.note}` : ''}`));
    }
    for (const c of plan.cases.filter(x => x.skipped)) lines.push(`Skipped ${c.id}: ${c.skipped}`);
    if (plan.notes.length) lines.push('', ...plan.notes);
    return lines.join('\n');
}

/** Writes generated files, marks each case as generated and records who approved it. */
export function applyGeneration(store: ProjectStore, plan: GenerationPlan, wave: number | undefined, approval: { by: string; via: string }, overwrite: string[] = []) {
    const specs = plan.cases.filter(c => c.spec);
    const { written, kept } = writePlanned(store, plan.files, overwrite);
    const writtenSet = new Set(written);
    for (const c of specs) {
        if (!writtenSet.has(c.spec) && !plan.files.some(f => f.path === c.spec && f.status === 'unchanged')) continue;
        const tc = store.readCase(c.id);
        if (!tc) continue;
        tc.automation = { ...tc.automation, status: 'generated', specFile: c.spec };
        store.writeCase(tc);
    }
    const at = new Date().toISOString();
    store.updateState(s => {
        s.approvals.push({ what: `generate ${specs.length} test(s)${wave ? ` (wave ${wave})` : ''}`, by: approval.by, at, note: approval.via });
    });
    store.recordDecision(`Generated ${specs.length} test(s)${wave ? ` for wave ${wave}` : ''}: ${specs.map(c => c.id).join(', ')}`, `Approved ${approval.via === 'form' ? 'in a form' : 'in chat'}`, approval.by);
    if (store.hasConfig()) completeActionStep(store, 'GENERATE', `Generated ${specs.length} test(s)`);
    return { written, kept };
}

const selectionArgs = {
    projectRoot: projectRootArg,
    wave: z.number().int().min(1).optional().describe('Plan wave to generate (default: the first wave with tests not generated yet)'),
    ids: z.array(z.string()).optional().describe('Generate only these test-case ids (must be in the approved plan)'),
    includeGenerated: z.boolean().default(false).describe('Also regenerate tests that were generated before')
};

export function registerGenerateTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'preview_tests',
        {
            title: 'Preview generated tests',
            description:
                'Shows the test files, page or screen objects and fixture changes TestPilot would write for a wave of the approved plan (Playwright in TypeScript or JavaScript, Selenium + Java with TestNG, or Appium + WebdriverIO screen objects for mobile and desktop; Cucumber features and step definitions with the BDD pattern; locators from exploration), without writing anything. Show the list to the user, then call generate_tests with the confirmToken after they agree.',
            inputSchema: z.object(selectionArgs),
            annotations: READ_ONLY
        },
        guarded('preview_tests', options, async (args: { projectRoot?: string; wave?: number; ids?: string[]; includeGenerated: boolean }) => {
            const { store } = openProject(options, args.projectRoot);
            const config = store.readConfig();
            const sel = select(store, args.wave, args.ids, args.includeGenerated);
            if (sel.error) return failure(sel.error);
            if (!sel.cases.length) return failure('No cases to generate in that selection.');
            const built = buildGeneration(store, config, sel.cases);
            if (built.error || !built.plan) return failure(built.error ?? 'Nothing to generate.');
            return result(`${sel.wave ? `Wave ${sel.wave}: ` : ''}${describe(built.plan)}\n\nAsk the user to go ahead, then call generate_tests with this confirmToken.`, {
                confirmToken: built.token,
                wave: sel.wave ?? null,
                cases: built.plan.cases,
                files: built.plan.files.map(f => ({ path: f.path, status: f.status, note: f.note })),
                conflicts: built.plan.files.filter(f => f.status === 'conflict').map(f => f.path)
            });
        })
    );

    server.registerTool(
        'generate_tests',
        {
            title: 'Generate tests',
            description:
                'Writes the files shown by preview_tests after the user approves (form when supported, otherwise userApproved: true after they say yes). Existing files that differ are kept unless listed in overwrite. Afterwards, finish every TODO(testpilot) step following the write-*-test skill and the locators in .testpilot/exploration, remove the fixme, then run_tests.',
            inputSchema: z.object({
                ...selectionArgs,
                confirmToken: z.string(),
                overwrite: z.array(z.string()).default([]),
                userApproved: userApprovedArg,
                approver: approverArg
            }),
            annotations: WRITES_FILES
        },
        guarded(
            'generate_tests',
            options,
            async (args: { projectRoot?: string; wave?: number; ids?: string[]; includeGenerated: boolean; confirmToken: string; overwrite: string[]; userApproved?: boolean; approver?: string }, ctx: unknown) => {
                const { store } = openProject(options, args.projectRoot);
                const config = store.readConfig();
                const sel = select(store, args.wave, args.ids, args.includeGenerated);
                if (sel.error) return failure(sel.error);
                const built = buildGeneration(store, config, sel.cases);
                if (built.error || !built.plan) return failure(built.error ?? 'Nothing to generate.');
                if (built.token !== args.confirmToken) return failure('The files or the selection changed since the preview. Call preview_tests again and show the user the new list.');
                const conflicts = new Set(built.plan.files.filter(f => f.status === 'conflict').map(f => f.path));
                const unknown = args.overwrite.filter(p => !conflicts.has(p));
                if (unknown.length) return failure(`Not in the preview's conflicts list: ${unknown.join(', ')}.`);
                const specs = built.plan.cases.filter(c => c.spec);
                const approval = requireApproval(server, ctx, {
                    key: 'generate',
                    question: `Write ${specs.length} test(s)${sel.wave ? ` for wave ${sel.wave}` : ''} and their page objects in ${store.root}?`,
                    userApproved: args.userApproved,
                    approver: args.approver
                });
                if (!approval.approved) return approval.reply;
                const { written, kept } = applyGeneration(store, built.plan, sel.wave, approval, args.overwrite);
                const partial = specs.filter(c => c.todos);
                const summary = [
                    `Wrote ${written.length} file(s)${kept.length ? `; kept ${kept.length} existing file(s)` : ''}.`,
                    partial.length
                        ? config.stack.templatePack === 'appium-ts'
                            ? `${partial.length} test(s) have TODO(testpilot) steps and stay pending: ${partial.map(c => `${c.id} (${c.todos})`).join(', ')}. Finish each TODO using the screen objects and the selectors in .testpilot/exploration/README.md (follow the write-appium-test skill), then delete the pendingUntilDone line. Getters marked "Not seen during exploration" are guesses to confirm with explore_app or Appium Inspector.`
                            : config.stack.templatePack === 'selenium-java'
                              ? `${partial.length} test(s) have TODO(testpilot) steps and are skipped: ${partial.map(c => `${c.id} (${c.todos})`).join(', ')}. Finish each TODO using the page objects and the locators in .testpilot/exploration/README.md (follow the write-selenium-test skill), then remove the skipUntilDone line${config.stack.pattern === 'bdd' ? ' and the @testpilot-todo tag' : ''}.`
                              : `${partial.length} test(s) have TODO(testpilot) steps and are marked fixme: ${partial.map(c => `${c.id} (${c.todos})`).join(', ')}. Finish each TODO using the page objects and the locators in .testpilot/exploration/README.md (follow the write-playwright-test skill), then ${config.stack.pattern === 'bdd' ? 'remove the @fixme tag from the scenario' : 'change test.fixme to test'}.`
                        : 'Every test was translated completely.',
                    'Then run them with run_tests (stabilityRuns: 2 to confirm they pass twice).',
                    built.plan.notes.length ? `\n${built.plan.notes.join('\n')}` : ''
                ]
                    .filter(Boolean)
                    .join('\n');
                return result(summary, { written, kept, cases: built.plan.cases, approvedBy: approval.by });
            }
        )
    );
}
