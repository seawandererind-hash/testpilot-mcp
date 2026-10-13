import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { integrationsFor, keysFor } from '../catalog/env-keys.js';
import { detectRepo } from '../core/detect.js';
import { checkEnv, ENV_FILE, writeEnvTemplate } from '../core/env.js';
import { ProjectStore } from '../core/store.js';
import { answerStep, completeActionStep, currentStepId, STEPS, viewStep, WizardInputError } from '../core/wizard.js';
import { DEMO_CASES_CSV, DEMO_SITE } from '../demo/assets.js';
import { demoServerFor, startDemoServer, stopDemoServer } from '../demo/server.js';
import { approverArg, failure, guarded, projectRootArg, projectRootFor, requireApproval, result, type ServerOptions, userApprovedArg } from './common.js';

export const DEMO_DIR = 'testpilot-demo';
const SITE_DIR = 'demo-site';
const CASES_FILE = 'test-cases/shop.csv';
const MARKER = '.testpilot/demo.json';

/** Answers for the demo; any wizard step not listed takes TestPilot's recommendation. */
function presets(language: string): Record<string, string | string[]> {
    return {
        APP_TYPE: 'web',
        EXISTING: 'create',
        FRAMEWORK: 'playwright',
        LANGUAGE: language,
        PATTERN: 'pom',
        EXECUTION_TARGET: 'local',
        TEST_CASE_SOURCE: 'csv',
        CI: 'github-actions',
        REPORTING: ['html', 'junit']
    };
}

/** Names that make a folder look like real work, so the demo goes in a subfolder instead. */
const BUSY = /^(src|app|lib|tests?|e2e|pom\.xml|build\.gradle|playwright\.config\.[jt]s|wdio\.conf\.[jt]s|\.testpilot)$/;

/** Where the demo lives: the folder itself when it is (nearly) empty or already a demo, else a subfolder. */
export function demoRoot(root: string): string {
    const here = new ProjectStore(root);
    if (here.exists(MARKER)) return root;
    let names: string[] = [];
    try {
        names = readdirSync(root);
    } catch {
        return root;
    }
    return names.some(n => BUSY.test(n)) ? path.join(root, DEMO_DIR) : root;
}

/** The order of tool calls that tells the TestPilot story, for the AI to follow one step at a time. */
export function demoScript(url: string, projectRoot: string | undefined): Array<{ step: string; tool: string; args: Record<string, unknown>; say: string }> {
    const pr = projectRoot ? { projectRoot } : {};
    return [
        { step: 'Create the framework', tool: 'preview_scaffold', args: { ...pr }, say: 'Show the file list, ask "Can I create the project framework?", then call scaffold_project with the confirmToken, install: true and userApproved: true after the yes.' },
        { step: 'Import the test cases', tool: 'import_test_cases', args: { ...pr, source: 'csv', location: CASES_FILE }, say: 'Then review_test_cases: 3 to automate, 1 manual (brand look), 1 too vague.' },
        { step: 'Watch it test, live', tool: 'live_test', args: { ...pr, action: 'start', url, caseId: 'SHOP-1' }, say: 'Then live_test action "auto" with caseId SHOP-1, and "finish". The browser opens on the screen and signs in by itself.' },
        { step: 'Explore the app', tool: 'explore_app', args: { ...pr }, say: 'Records every page, button and field with stable locators.' },
        { step: 'Plan', tool: 'automation_plan', args: { ...pr, action: 'generate' }, say: 'Ask who approves, then action "approve" with their name.' },
        { step: 'Generate tests', tool: 'preview_tests', args: { ...pr, wave: 1 }, say: 'Show the files, then generate_tests with the confirmToken after the yes.' },
        { step: 'Run twice', tool: 'run_tests', args: { ...pr, stabilityRuns: 2 }, say: 'A test only counts once it passes twice in a row.' },
        { step: 'Accessibility', tool: 'quality_scan', args: { ...pr, action: 'accessibility' }, say: 'The shop has real accessibility problems; each one is explained in plain words.' },
        { step: 'Break the app', tool: 'demo_project', args: { ...pr, action: 'break' }, say: 'Renames the "Sign in" button to "Log in", like a developer would.' },
        { step: 'See it fail', tool: 'run_tests', args: { ...pr }, say: 'The login test now fails with a locator problem.' },
        { step: 'Heal it', tool: 'heal_tests', args: { ...pr, action: 'propose' }, say: 'Shows the one-line fix; after the yes, heal_tests action "apply" re-runs the test to prove it.' },
        { step: 'Manager view', tool: 'insights', args: { ...pr, action: 'coverage' }, say: 'Then publish_results action "report" for the run report.' },
        { step: 'Put the app back', tool: 'demo_project', args: { ...pr, action: 'restore' }, say: 'Restores the original button text.' }
    ];
}

export function registerDemoTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'demo_project',
        {
            title: 'Demo project',
            description:
                'Sets up a safe practice project for trying or presenting TestPilot: a small shop website served on this computer (http://localhost:4599), five sample test cases in test-cases/shop.csv, and wizard answers already filled in (web, Playwright, Page Object Model, CSV, GitHub Actions). Use it when the user wants a demo, a tutorial or a first try. action "start" (preview, then create after approval) returns the demo script: the tool calls to make, in order, with what to tell the audience. action "break" renames the shop\'s Sign in button to Log in so a test fails and heal_tests can fix it; "restore" puts it back; "status" says whether the shop is running; "stop" stops the shop. The demo goes in the current folder when it is empty, otherwise in a testpilot-demo subfolder (pass that folder as projectRoot afterwards). The .env it writes holds demo values only.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                action: z.enum(['start', 'break', 'restore', 'status', 'stop']).default('start').describe('What to do'),
                language: z.enum(['typescript', 'javascript']).default('typescript').describe('Language for the demo tests'),
                port: z.number().int().min(1024).max(65000).default(4599).describe('First port to try for the shop'),
                userApproved: userApprovedArg,
                approver: approverArg
            }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        guarded(
            'demo_project',
            options,
            async (args: { projectRoot?: string; action: 'start' | 'break' | 'restore' | 'status' | 'stop'; language: 'typescript' | 'javascript'; port: number; userApproved?: boolean; approver?: string }, ctx: unknown) => {
                const base = projectRootFor(options, args.projectRoot);
                const root = demoRoot(base);
                const store = new ProjectStore(root);
                const nested = root !== base;
                const prArg = nested ? root : args.projectRoot;

                if (args.action === 'status' || args.action === 'stop') {
                    if (args.action === 'stop') {
                        const stopped = await stopDemoServer(store.resolve(SITE_DIR));
                        return result(stopped ? 'The demo shop is stopped.' : 'The demo shop was not running.', { stopped });
                    }
                    const running = demoServerFor(store.resolve(SITE_DIR));
                    return result(running ? `The demo shop is running at ${running.url}.` : 'The demo shop is not running. Call demo_project with action "start".', { running: Boolean(running), url: running?.url, folder: root });
                }

                if (args.action === 'break' || args.action === 'restore') {
                    const page = `${SITE_DIR}/index.html`;
                    const html = store.read(page);
                    if (!html) return failure('There is no demo shop here yet. Call demo_project with action "start" first.');
                    const [from, to] = args.action === 'break' ? ['>Sign in<', '>Log in<'] : ['>Log in<', '>Sign in<'];
                    if (!html.includes(from)) return result(args.action === 'break' ? 'The button already says "Log in".' : 'The button already says "Sign in".', { changed: false });
                    store.write(page, html.replace(from, to));
                    store.recordDecision(args.action === 'break' ? 'Renamed the demo shop\'s "Sign in" button to "Log in"' : 'Restored the demo shop\'s "Sign in" button', 'demo_project', 'testpilot');
                    return result(
                        args.action === 'break'
                            ? 'The demo shop\'s button now says "Log in" instead of "Sign in", as if a developer renamed it. Run the login test (run_tests) to see it fail, then heal_tests action "propose".'
                            : 'The demo shop\'s button says "Sign in" again.',
                        { changed: true, file: page }
                    );
                }

                // action: start
                if (!store.exists(MARKER)) {
                    const approval = requireApproval(server, ctx, {
                        key: 'demo-start',
                        question: `Create the TestPilot demo in ${nested ? `${DEMO_DIR}/ (a new subfolder)` : 'this folder'}? It adds a small shop website (${SITE_DIR}/), five sample test cases (${CASES_FILE}), demo values in .env and the wizard answers, and starts the shop on this computer.`,
                        userApproved: args.userApproved,
                        approver: args.approver
                    });
                    if (!approval.approved) return approval.reply;
                    if (!store.exists('package.json')) store.write('package.json', JSON.stringify({ name: 'testpilot-demo', version: '1.0.0', private: true }, null, 2) + '\n');
                    for (const [name, content] of Object.entries(DEMO_SITE)) store.write(`${SITE_DIR}/${name}`, content);
                    store.write(CASES_FILE, DEMO_CASES_CSV);
                    store.write(MARKER, JSON.stringify({ createdAt: new Date().toISOString(), language: args.language, by: approval.by }, null, 2) + '\n');
                    store.recordDecision('Created the TestPilot demo project', 'demo_project', approval.by);
                }
                const shop = await startDemoServer(store.resolve(SITE_DIR), args.port);

                // Answer every question up to the first action step, preferring the demo presets.
                const detection = detectRepo(root);
                const wanted = presets(args.language);
                const notes: string[] = [];
                for (let guard = 0; guard < STEPS.length; guard++) {
                    const ctxNow = { config: store.readConfig(), state: store.readState(), detection };
                    const id = currentStepId(ctxNow);
                    if (!id) break;
                    const view = viewStep(id, ctxNow);
                    if (view.kind === 'action') break;
                    const preferred = wanted[id] ?? view.recommended ?? view.options?.[0]?.value;
                    if (preferred === undefined) break;
                    try {
                        answerStep(store, detection, id, preferred as string | string[], 'testpilot (demo)');
                    } catch (error) {
                        if (!(error instanceof WizardInputError) || view.recommended === undefined) throw error;
                        notes.push(`${view.title}: "${String(preferred)}" is not offered by this TestPilot version, so the demo uses "${String(view.recommended)}".`);
                        answerStep(store, detection, id, view.recommended as string | string[], 'testpilot (demo)');
                    }
                }

                // Credentials: demo values only, written once; the user's own .env is never touched.
                const config = store.readConfig();
                const keys = keysFor(integrationsFor(config));
                writeEnvTemplate(store, keys);
                if (!store.exists(ENV_FILE)) {
                    const demoValues: Record<string, string> = { TEST_USER_EMAIL: 'qa@example.com', TEST_USER_PASSWORD: 'demo-password-not-secret', APP_BASE_URL: shop.url };
                    const lines = ['# Demo values for the TestPilot practice shop. Any email and password signs in; nothing here is secret.'];
                    for (const k of keys) if (demoValues[k.name] || k.required) lines.push(`${k.name}=${demoValues[k.name] ?? 'demo'}`);
                    if (!lines.some(l => l.startsWith('APP_BASE_URL='))) lines.push(`APP_BASE_URL=${shop.url}`);
                    store.write(ENV_FILE, lines.join('\n') + '\n');
                }
                const env = checkEnv(store, keys);
                if (env.ok && !store.readState().completed.includes('SECRETS')) completeActionStep(store, 'SECRETS', 'Demo credentials present');

                // The URL and extras are known up front, so only action steps remain.
                const state = store.readState();
                if (!state.completed.includes('APP_UNDER_TEST')) answerStep(store, detection, 'APP_UNDER_TEST', shop.url, 'testpilot (demo)');
                if (!state.completed.includes('EXTRAS')) {
                    try {
                        answerStep(store, detection, 'EXTRAS', ['explore', 'accessibility', 'visual'], 'testpilot (demo)');
                    } catch {
                        answerStep(store, detection, 'EXTRAS', ['explore'], 'testpilot (demo)');
                    }
                }

                const script = demoScript(shop.url, prArg);
                const summary = [
                    `The demo shop is running at ${shop.url}${shop.reused ? ' (it was already running)' : ''}${nested ? `, and the demo project is in ${root}. Pass projectRoot "${root}" to every TestPilot tool from now on` : ''}.`,
                    'The wizard answers are filled in: web app, Playwright, Page Object Model, run on this computer, test cases from CSV, GitHub Actions, HTML and JUnit reports. The .env file holds demo values only.',
                    ...notes,
                    '',
                    'Demo script (one step at a time, asking the user before every write):',
                    ...script.map((s, i) => `${i + 1}. ${s.step}: ${s.tool} ${JSON.stringify(s.args)}. ${s.say}`)
                ].join('\n');
                return result(summary, { url: shop.url, folder: root, nested, script, wizardStep: store.readState().step });
            }
        )
    );
}
