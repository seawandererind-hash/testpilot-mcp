import { APP_TYPE_OPTIONS, BUILD_TOOLS, CI_OPTIONS, EXECUTION_OPTIONS, EXTRA_OPTIONS, FRAMEWORKS, findFramework, LANGUAGE_LABELS, type Option, PATTERN_OPTIONS, recommendStack, REPORTING_OPTIONS, TEST_CASE_SOURCE_OPTIONS, templatePackFor } from '../catalog/frameworks.js';
import { classifyAppRef } from './app-target.js';
import { type RepoDetection, uiFrameworksIn } from './detect.js';
import { type AppType, type Config, type ExecutionTarget, type Pattern, type State, type TestCaseSource } from './schema.js';
import { setEnvDefault } from './env.js';
import type { ProjectStore } from './store.js';

export type StepKind = 'choice' | 'multi' | 'text' | 'action';

export interface StepView {
    step: string;
    number: number;
    total: number;
    title: string;
    kind: StepKind;
    question: string;
    why: string;
    options?: Option[];
    recommended?: string | string[];
    allowFreeText: boolean;
    /** For action steps: which tools to call and what to tell the user. */
    action?: { tools: string[]; instructions: string };
    progress: string;
}

export interface WizardContext {
    config: Config;
    state: State;
    detection: RepoDetection;
}

interface StepDef {
    id: string;
    title: string;
    kind: StepKind;
    skip?: (ctx: WizardContext) => boolean;
    question: (ctx: WizardContext) => string;
    why: string;
    options?: (ctx: WizardContext) => Option[];
    recommended?: (ctx: WizardContext) => string | string[] | undefined;
    allowFreeText?: boolean;
    action?: (ctx: WizardContext) => { tools: string[]; instructions: string };
    /** Applies a validated answer to the config. Returns a human summary for decisions.md. */
    apply?: (config: Config, answer: string | string[], ctx: WizardContext) => string;
    /** Side effects in the repository after the answer is saved. */
    after?: (store: ProjectStore, config: Config) => void;
}

const mobileTypes: AppType[] = ['android', 'ios', 'android-ios', 'hybrid'];

export const STEPS: StepDef[] = [
    {
        id: 'APP_TYPE',
        title: 'What are you testing?',
        kind: 'choice',
        question: () => 'What kind of application are you testing?',
        why: 'The app type decides which automation engine, tools and templates fit.',
        options: () => APP_TYPE_OPTIONS,
        apply: (config, answer) => {
            config.appType = answer as AppType;
            return `App type: ${label(APP_TYPE_OPTIONS, answer as string)}`;
        }
    },
    {
        id: 'EXISTING',
        title: 'Existing framework',
        kind: 'choice',
        skip: ctx => uiFrameworksIn(ctx.detection).length === 0,
        question: ctx => `I found ${uiFrameworksIn(ctx.detection).join(', ')} in this repository. Should I extend that framework or create a new one next to it?`,
        why: 'Extending keeps the team on one framework; creating new is only worth it when the old one is abandoned.',
        options: () => [
            { value: 'extend', label: 'Extend the existing framework', description: 'Keep its structure; TestPilot adds plans, skills and new tests in the same style.' },
            { value: 'create', label: 'Create a new framework', description: 'Scaffold a fresh project in a separate folder.' }
        ],
        recommended: () => 'extend',
        apply: (config, answer, ctx) => {
            const found = uiFrameworksIn(ctx.detection)[0];
            config.existing = { mode: answer as 'extend' | 'create', framework: found };
            if (answer === 'extend' && found) config.stack.framework ??= found;
            if (answer === 'create') config.project.testRoot = config.project.testRoot === '.' ? 'automation' : config.project.testRoot;
            return answer === 'extend' ? `Extend the existing ${found} framework` : 'Create a new framework in ./automation';
        }
    },
    {
        id: 'FRAMEWORK',
        title: 'Framework',
        kind: 'choice',
        allowFreeText: true,
        question: ctx => `Which framework do you want to use for ${label(APP_TYPE_OPTIONS, ctx.config.appType ?? 'web').toLowerCase()} testing?`,
        why: 'The framework is the engine that drives the app. TestPilot recommends one, but you can type any other.',
        options: ctx => (FRAMEWORKS[ctx.config.appType ?? 'web'] ?? []).map(f => ({ value: f.value, label: f.label, description: `${f.description} Pros: ${f.pros.join('; ')}. Cons: ${f.cons.join('; ')}.` })),
        recommended: ctx => (ctx.config.existing?.mode === 'extend' ? ctx.config.existing.framework : recommendStack(ctx.config.appType ?? 'web', ctx.detection.languages.map(l => l.language)).framework),
        apply: (config, answer) => {
            config.stack.framework = answer as string;
            const known = config.appType ? findFramework(config.appType, answer as string) : undefined;
            return `Framework: ${known?.label ?? answer}${known ? '' : ' (no TestPilot template yet; I will guide instead of scaffolding)'}`;
        }
    },
    {
        id: 'LANGUAGE',
        title: 'Language',
        kind: 'choice',
        allowFreeText: true,
        question: () => 'Which programming language should the tests be written in?',
        why: 'Pick the language your team already knows; it matters more than any other choice for long-term maintenance.',
        options: ctx => {
            const fw = ctx.config.appType && ctx.config.stack.framework ? findFramework(ctx.config.appType, ctx.config.stack.framework) : undefined;
            const langs = fw?.languages ?? Object.keys(LANGUAGE_LABELS);
            return langs.map(l => ({ value: l, label: LANGUAGE_LABELS[l] ?? l, description: fw?.packs?.[l] ? 'TestPilot can scaffold this combination.' : 'TestPilot will guide you, without a ready-made template yet.' }));
        },
        recommended: ctx => {
            const fw = ctx.config.appType && ctx.config.stack.framework ? findFramework(ctx.config.appType, ctx.config.stack.framework) : undefined;
            const rec = recommendStack(ctx.config.appType ?? 'web', ctx.detection.languages.map(l => l.language)).language;
            return fw && !fw.languages.includes(rec) ? fw.languages[0] : rec;
        },
        apply: (config, answer, ctx) => {
            const language = String(answer).toLowerCase();
            config.stack.language = language;
            const fromRepo = ctx.detection.buildTools.find(t => (BUILD_TOOLS[language] ?? []).includes(t));
            config.stack.buildTool = fromRepo ?? BUILD_TOOLS[language]?.[0];
            config.stack.templatePack = templatePackFor(config.appType, config.stack.framework, language);
            return `Language: ${LANGUAGE_LABELS[language] ?? language} (build tool ${config.stack.buildTool ?? 'not set'})`;
        }
    },
    {
        id: 'PATTERN',
        title: 'Design pattern',
        kind: 'choice',
        question: () => 'Which design pattern should the framework follow?',
        why: 'The pattern decides how tests are organised. The Page Object Model is the safest default for most teams.',
        options: () => PATTERN_OPTIONS,
        recommended: () => 'pom',
        apply: (config, answer) => {
            config.stack.pattern = answer as Pattern;
            return `Pattern: ${label(PATTERN_OPTIONS, answer as string)}`;
        }
    },
    {
        id: 'EXECUTION_TARGET',
        title: 'Where tests run',
        kind: 'choice',
        question: ctx =>
            ctx.config.appType === 'ios' && process.platform !== 'darwin'
                ? 'Where should the tests run? This computer is not a Mac, so local iOS runs are limited; a device cloud is the usual choice.'
                : 'Where should the tests run?',
        why: 'Local runs are free and fast to debug; a cloud gives many browsers and real devices.',
        options: () => EXECUTION_OPTIONS,
        recommended: ctx => (ctx.config.appType === 'ios' && process.platform !== 'darwin' ? 'browserstack' : 'local'),
        apply: (config, answer) => {
            config.execution.target = answer as ExecutionTarget;
            if (config.appType === 'web' || config.appType === 'electron') config.execution.browsers ??= ['chromium'];
            return `Execution target: ${label(EXECUTION_OPTIONS, answer as string)}`;
        }
    },
    {
        id: 'TEST_CASE_SOURCE',
        title: 'Where your test cases live',
        kind: 'choice',
        question: () => 'Where are your test cases saved today?',
        why: 'TestPilot imports them from there, and later sends results back. Knowing it now lets me list the credentials you need in one go.',
        options: () => TEST_CASE_SOURCE_OPTIONS,
        recommended: () => 'excel',
        apply: (config, answer) => {
            config.integrations.testCaseSource = answer as TestCaseSource;
            return `Test-case source: ${label(TEST_CASE_SOURCE_OPTIONS, answer as string)}`;
        }
    },
    {
        id: 'CI',
        title: 'Continuous integration',
        kind: 'choice',
        question: ctx => (ctx.detection.ci.length ? `I see ${ctx.detection.ci.join(', ')} in this repo. Which CI should run the tests?` : 'Which CI system should run the tests?'),
        why: 'Tests only protect the team when they run automatically on every change.',
        options: () => CI_OPTIONS,
        recommended: ctx => ctx.detection.ci.find(c => CI_OPTIONS.some(o => o.value === c)) ?? 'github-actions',
        apply: (config, answer) => {
            config.integrations.ci = answer as Config['integrations']['ci'];
            return `CI: ${label(CI_OPTIONS, answer as string)}`;
        }
    },
    {
        id: 'REPORTING',
        title: 'Reports',
        kind: 'multi',
        question: () => 'Which reports do you want? You can pick more than one.',
        why: 'The HTML report is for people; JUnit XML is what CI and test-management tools import.',
        options: () => REPORTING_OPTIONS,
        recommended: () => ['html', 'junit'],
        apply: (config, answer) => {
            config.integrations.reporting = toArray(answer);
            return `Reports: ${toArray(answer).join(', ')}`;
        }
    },
    {
        id: 'SECRETS',
        title: 'Credentials',
        kind: 'action',
        question: () => 'Add the credentials TestPilot needs to the .env file.',
        why: 'Secrets stay on your computer in .env, which git ignores. TestPilot only checks that each key is filled in; it never reads the values into the chat.',
        action: () => ({
            tools: ['write_env_template', 'check_env'],
            instructions:
                'Call write_env_template, then tell the user which keys were added to .env.example and where to get each one. Ask them to copy .env.example to .env and fill it in themselves (never ask them to paste secrets into the chat). When they say they are done, call check_env; this step completes when all required keys are present.'
        })
    },
    {
        id: 'SCAFFOLD',
        title: 'Create the project framework',
        kind: 'action',
        question: ctx => (ctx.config.existing?.mode === 'extend' ? 'Can I add TestPilot\'s files (plans, skills, AGENTS.md) to your existing framework?' : 'Can I create the project framework?'),
        why: 'You see every file before anything is written, and nothing is overwritten without your consent.',
        action: () => ({
            tools: ['preview_scaffold', 'scaffold_project'],
            instructions:
                'Call preview_scaffold and show the user the file list. Ask "Can I create the project framework?" Only after they say yes, call scaffold_project with the confirmToken from the preview and userApproved: true. Never pass userApproved: true without an explicit yes.'
        })
    },
    {
        id: 'APP_UNDER_TEST',
        title: 'The application under test',
        kind: 'text',
        allowFreeText: true,
        question: ctx =>
            ctx.config.appType === 'web' || ctx.config.appType === undefined
                ? 'What is the URL of the test environment? (Not production.)'
                : ctx.config.appType === 'api'
                  ? 'What is the base URL of the API, or the path to its OpenAPI file?'
                  : ctx.config.appType === 'electron'
                    ? 'Where is the Electron app (path to the executable or the app folder)?'
                    : mobileTypes.includes(ctx.config.appType)
                      ? 'Where is the app? Give a path to the APK/AAB/IPA, a BrowserStack app id (bs://…), or the package/bundle id. Say "help" if you don\'t have a build.'
                      : 'Where is the app installer or executable?',
        why: 'TestPilot opens the app once to prove it launches, and stores only a reference to it.',
        apply: (config, answer) => {
            const ref = classifyAppRef(String(answer), config.appType);
            if (ref.kind === 'help') throw new WizardInputError(ref.guidance ?? 'Please give a URL, a file path or an app id.');
            config.app = { kind: ref.kind, ref: ref.ref, notes: ref.note };
            if (ref.kind === 'url') {
                const base = config.environments.find(e => e.name === 'test');
                if (!base) config.environments.push({ name: 'test', baseUrlEnv: config.appType === 'api' ? 'API_BASE_URL' : 'APP_BASE_URL', isProduction: false });
            }
            return `App under test: ${ref.kind} ${ref.ref}`;
        },
        after: (store, config) => {
            if (config.app.kind === 'url' && config.app.ref) setEnvDefault(store, config.appType === 'api' ? 'API_BASE_URL' : 'APP_BASE_URL', config.app.ref);
            if (config.app.kind === 'openapi' && config.app.ref && /^https?:/i.test(config.app.ref)) setEnvDefault(store, 'API_BASE_URL', new URL(config.app.ref).origin);
            // Mobile and desktop builds: the generated wdio configs read these settings (.env still overrides them).
            const ref = config.app.ref;
            if (ref && config.app.kind && ['apk', 'aab', 'ipa', 'app', 'exe'].includes(config.app.kind)) setEnvDefault(store, 'APP_PATH', ref);
            if (ref && config.app.kind === 'cloud-id' && /^bs:\/\//i.test(ref)) setEnvDefault(store, 'BROWSERSTACK_APP_ID', ref);
            if (ref && (config.app.kind === 'package-id' || config.app.kind === 'bundle-id')) setEnvDefault(store, 'APP_ID', ref);
        }
    },
    {
        id: 'EXTRAS',
        title: 'Anything else?',
        kind: 'multi',
        question: () => 'Anything else before we look at test cases? Pick any, or none.',
        why: 'These are optional add-ons. Exploring the app first gives better locators for generated tests.',
        options: ctx => EXTRA_OPTIONS.filter(o => !(o.value === 'explore' && ctx.config.appType === 'api')),
        recommended: ctx => (ctx.config.appType === 'api' ? [] : ['explore']),
        apply: (config, answer) => {
            config.extras = toArray(answer).filter(a => a !== 'none');
            return `Extras: ${config.extras.join(', ') || 'none'}`;
        }
    },
    {
        id: 'TEST_CASES',
        title: 'Import and review test cases',
        kind: 'action',
        question: ctx => (ctx.config.integrations.testCaseSource === 'none' ? 'You have no test cases yet. Shall I draft some from the app or from your requirements?' : 'Let\'s import your test cases and review them.'),
        why: 'Automation is only as good as the test cases behind it; the review catches gaps before code is written.',
        action: ctx => ({
            tools: ['import_test_cases', 'review_test_cases'],
            instructions:
                ctx.config.integrations.testCaseSource === 'none'
                    ? 'Help the user draft test cases (from the explored app or their user stories) as a Markdown or CSV file, then call import_test_cases on it, then review_test_cases. Show the review summary and suggestions.'
                    : `Ask for the location (file path, Jira JQL, project id) if needed, call import_test_cases with source "${ctx.config.integrations.testCaseSource}", then call review_test_cases and walk the user through the verdicts and suggestions.`
        })
    },
    {
        id: 'PLAN',
        title: 'Automation plan',
        kind: 'action',
        question: () => 'Shall I build the automation plan from the reviewed test cases?',
        why: 'The plan is the contract: what gets automated first, what stays manual, and the risks. A named person approves it before code is generated.',
        action: () => ({
            tools: ['automation_plan'],
            instructions: 'Call automation_plan with action "generate", summarise the waves, then ask who approves it. Call automation_plan with action "approve" and their name only after they explicitly approve.'
        })
    },
    {
        id: 'GENERATE',
        title: 'Generate tests',
        kind: 'action',
        question: () => 'Shall I write the tests for the first wave?',
        why: 'Tests are written in small batches, each tagged with its test-case id, so every result traces back.',
        action: () => ({
            tools: ['generate_tests'],
            instructions: 'Call generate_tests for wave 1 (preview first, then apply with the confirmToken after the user agrees). Then implement any steps marked TODO(testpilot) using the page objects, following the write-*-test skill.'
        })
    },
    {
        id: 'RUN',
        title: 'Run and fix',
        kind: 'action',
        question: () => 'Shall I run the new tests?',
        why: 'A test only counts as done after it passes twice in a row.',
        action: () => ({
            tools: ['run_tests'],
            instructions: 'Call run_tests (with stabilityRuns: 2 once tests pass). For failures, read the triage and propose fixes as diffs. Never weaken or delete an assertion without the user\'s approval.'
        })
    },
    {
        id: 'REPORT',
        title: 'Report and CI',
        kind: 'action',
        question: () => 'Shall I create the report and the CI pipeline, and send results to your test-management tool?',
        why: 'Results belong where your team already looks.',
        action: () => ({
            tools: ['publish_results'],
            instructions: 'Call publish_results with action "report", then "ci". Only call action "sync" (sending results to Jira/Xray/BrowserStack/TestRail/Azure DevOps) after the user explicitly approves it.'
        })
    }
];

export class WizardInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WizardInputError';
    }
}

export const STEP_IDS = STEPS.map(s => s.id);

function label(options: Option[], value: string): string {
    return options.find(o => o.value === value)?.label ?? value;
}

function toArray(answer: string | string[]): string[] {
    return Array.isArray(answer) ? answer : String(answer).split(',').map(s => s.trim()).filter(Boolean);
}

function stepDef(id: string): StepDef {
    const def = STEPS.find(s => s.id === id);
    if (!def) throw new WizardInputError(`Unknown wizard step "${id}". Steps are: ${STEP_IDS.join(', ')}.`);
    return def;
}

/** A skip decision is frozen once a later step is answered, so files TestPilot creates cannot re-open earlier questions. */
function isSkipped(step: StepDef, ctx: WizardContext): boolean {
    return ctx.state.skipped.includes(step.id) || Boolean(step.skip?.(ctx));
}

function freezeSkips(state: State, ctx: WizardContext, uptoId: string): void {
    for (const step of STEPS) {
        if (step.id === uptoId) break;
        if (!state.skipped.includes(step.id) && !state.completed.includes(step.id) && step.skip?.(ctx)) state.skipped.push(step.id);
    }
}

/** First step that is neither completed nor skipped, or undefined when the wizard is done. */
export function currentStepId(ctx: WizardContext): string | undefined {
    for (const step of STEPS) {
        if (ctx.state.completed.includes(step.id) || isSkipped(step, ctx)) continue;
        return step.id;
    }
    return undefined;
}

export function viewStep(id: string, ctx: WizardContext): StepView {
    const def = stepDef(id);
    const active = STEPS.filter(s => !isSkipped(s, ctx));
    const number = active.findIndex(s => s.id === id) + 1;
    return {
        step: def.id,
        number,
        total: active.length,
        title: def.title,
        kind: def.kind,
        question: def.question(ctx),
        why: def.why,
        options: def.options?.(ctx),
        recommended: def.recommended?.(ctx),
        allowFreeText: def.allowFreeText ?? false,
        action: def.action?.(ctx),
        progress: `Step ${number} of ${active.length}`
    };
}

/** Normalises an answer against the step's options (accepts values or labels, case-insensitive). */
export function normaliseAnswer(id: string, raw: string | string[], ctx: WizardContext): string | string[] {
    const def = stepDef(id);
    if (def.kind === 'action') throw new WizardInputError(`"${id}" is an action step; use the tools it lists (${def.action?.(ctx).tools.join(', ')}) instead of answering it.`);
    if (def.kind === 'text') {
        const text = String(Array.isArray(raw) ? raw.join(' ') : raw).trim();
        if (!text) throw new WizardInputError('The answer is empty.');
        return text;
    }
    const options = def.options?.(ctx) ?? [];
    const match = (value: string): string | undefined => {
        const v = value.trim().toLowerCase();
        return options.find(o => o.value.toLowerCase() === v || o.label.toLowerCase() === v)?.value;
    };
    if (def.kind === 'multi') {
        const items = toArray(raw);
        if (items.length === 1 && ['none', 'no', 'nothing', 'skip'].includes(items[0].toLowerCase())) return [];
        const resolved = items.map(item => {
            const m = match(item);
            if (!m) throw new WizardInputError(`"${item}" is not one of: ${options.map(o => o.value).join(', ')}.`);
            return m;
        });
        return [...new Set(resolved)];
    }
    const single = Array.isArray(raw) ? raw[0] : raw;
    const m = match(String(single ?? ''));
    if (m) return m;
    if (def.allowFreeText && String(single ?? '').trim()) return String(single).trim();
    throw new WizardInputError(`"${single}" is not one of: ${options.map(o => o.value).join(', ')}.`);
}

/** Validates and saves one answer, records the decision, and returns the next step (or undefined when done). */
export function answerStep(store: ProjectStore, detection: RepoDetection, id: string, raw: string | string[], who = 'user'): { saved: string; next?: StepView } {
    const config = store.readConfig();
    const state = store.readState();
    const ctx: WizardContext = { config, state, detection };
    const def = stepDef(id);
    const answer = normaliseAnswer(id, raw, ctx);
    const summary = def.apply ? def.apply(config, answer, ctx) : `${def.title}: ${String(answer)}`;
    store.writeConfig(config);
    def.after?.(store, config);
    store.updateState(s => {
        freezeSkips(s, ctx, id);
        s.answers[id] = answer;
        if (!s.completed.includes(id)) s.completed.push(id);
        s.step = currentStepId({ config, state: s, detection }) ?? 'DONE';
    });
    store.recordDecision(summary, `Answered wizard step ${id}`, who);
    const fresh = { config: store.readConfig(), state: store.readState(), detection };
    const nextId = currentStepId(fresh);
    return { saved: summary, next: nextId ? viewStep(nextId, fresh) : undefined };
}

/** Marks an action step finished (called by the tools that perform it). */
export function completeActionStep(store: ProjectStore, id: string, note: string): void {
    store.updateState(s => {
        if (!s.completed.includes(id)) s.completed.push(id);
        const idx = STEP_IDS.indexOf(id);
        const nextOpen = STEP_IDS.slice(idx + 1).find(stepId => !s.completed.includes(stepId) && !s.skipped.includes(stepId));
        s.step = nextOpen ?? 'DONE';
    });
    store.recordDecision(note, `Completed wizard step ${id}`, 'testpilot');
}

/** Re-opens a step and every step after it. Answers already in config.yaml stay until re-answered. */
export function resetToStep(store: ProjectStore, id: string): void {
    stepDef(id);
    const idx = STEP_IDS.indexOf(id);
    const later = new Set(STEP_IDS.slice(idx));
    store.updateState(s => {
        s.completed = s.completed.filter(stepId => !later.has(stepId));
        s.skipped = s.skipped.filter(stepId => STEP_IDS.indexOf(stepId) < idx);
        s.step = id;
    });
    store.recordDecision(`Went back to wizard step ${id}`, 'Requested by the user', 'user');
}
