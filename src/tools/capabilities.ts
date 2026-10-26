import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { AI_PLATFORMS, type AiPlatform } from '../ai/midscene.js';
import { CAPABILITIES, type Capability, type CapabilityPlan, CLOUD_PROVIDERS, type CloudProvider, COMPANION_IDS, type CompanionId, planCapability, planToken } from '../capabilities/index.js';
import { POLICY_REPORT } from '../capabilities/org-policy.js';
import { CI_PROVIDERS } from '../core/schema.js';
import { inTestRoot, type PlannedFile, runCommand, writePlanned } from '../scaffold/engine.js';
import { approverArg, EXTERNAL, failure, guarded, openProject, projectRootArg, requireApproval, result, type ServerOptions, userApprovedArg } from './common.js';

const STATUS_WORDS: Record<PlannedFile['status'], string> = {
    new: 'create',
    merge: 'update (keeps your content)',
    conflict: 'exists and differs: kept unless you list it in overwrite',
    skip: 'left alone',
    unchanged: 'already up to date'
};

function describeFiles(files: PlannedFile[]): string {
    return (['new', 'merge', 'conflict', 'skip'] as const)
        .map(status => {
            const items = files.filter(f => f.status === status);
            return items.length ? `${STATUS_WORDS[status]} (${items.length}):\n${items.map(f => `  - ${f.path}${f.note ? `: ${f.note}` : ''}`).join('\n')}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

function describeExtras(plan: CapabilityPlan): string {
    const parts: string[] = [];
    for (const d of plan.diffs) parts.push(`Changes to ${d.path}:\n${d.diff}`);
    for (const s of plan.snippets) parts.push(`${s.title}\n${s.content}`);
    if (plan.notes.length) parts.push(plan.notes.map(n => `- ${n}`).join('\n'));
    return parts.join('\n\n');
}

function publicData(plan: CapabilityPlan): Record<string, unknown> {
    const { report: _report, ...rest } = plan.data;
    return rest;
}

type Args = {
    projectRoot?: string;
    capability: Capability;
    confirmToken?: string;
    overwrite: string[];
    userApproved?: boolean;
    approver?: string;
    install: boolean;
    shards: number;
    provider?: CloudProvider;
    ciProvider?: string;
    spec?: string;
    allowProduction: boolean;
    servers?: CompanionId[];
    policy?: string;
    platforms?: AiPlatform[];
};

export function registerCapabilityTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'add_capability',
        {
            title: 'Add a capability',
            description: [
                'Adds one ready-made capability to the test project. Call it first without confirmToken to get a preview (files to create or change, diffs, notes), show that to the user, then call again with the confirmToken after they say yes. Nothing is written before that.',
                'capability "login-once": sign in once per role (test-data/users.json) in a Playwright setup project and reuse the saved session in every test.',
                '"test-data": a test data factory (unique users, addresses, orders with @faker-js/faker) and an API seeding fixture that cleans up after itself; also checks imported test cases for real personal data.',
                '"ci-speed": GitHub Actions pipeline that runs only changed tests plus @smoke on pull requests, and the full suite split across machines (shards) on main and nightly. Other CI systems get the commands to paste.',
                '"cloud-grid": run the web tests on BrowserStack, Sauce Labs or LambdaTest (provider).',
                '"openapi": API tests from an OpenAPI 3 or Swagger 2 file (spec: a repo path or test-environment URL). GET tests run; data-changing ones start as test.fixme.',
                '"companions": add companion MCP servers (Playwright, Appium, BrowserStack, Atlassian, GitHub) that fit this project to the AI tools\' MCP config files, never removing existing servers.',
                '"ai-steps": plain-English AI tests (Midscene) in ai-tests/: a vision model reads the screen and carries out steps like "fill the sign-up form but do not send it", reads data off the screen and checks results, with a visual replay report. Works for websites, Android, iOS, HarmonyOS and desktop apps whatever language the project uses; Playwright projects also get aiAct/aiQuery/aiAssert inside coded tests. Needs an AI model key in .env (ai_tests action "models"). Then use the ai_tests tool.',
                '"org-policy": adopt a company rule pack (policy: repo path or https URL of testpilot.org.yaml) and check the project against it, writing .testpilot/reports/policy.md. Without policy it re-checks against the saved copy straight away.'
            ].join('\n'),
            inputSchema: z.object({
                projectRoot: projectRootArg,
                capability: z.enum(CAPABILITIES).describe('Which capability to add'),
                confirmToken: z.string().optional().describe('From the preview. Omit to get the preview.'),
                overwrite: z.array(z.string()).default([]).describe('Paths from the preview\'s "exists and differs" list that the user agreed to replace'),
                userApproved: userApprovedArg,
                approver: approverArg,
                install: z.boolean().default(false).describe('test-data, cloud-grid, ai-steps: also run npm install after writing (needs network access)'),
                shards: z.number().int().min(1).max(32).default(4).describe('ci-speed: how many machines share the full run'),
                ciProvider: z.enum(CI_PROVIDERS).optional().describe('ci-speed: CI system (default: the saved choice)'),
                provider: z.enum(CLOUD_PROVIDERS).optional().describe('cloud-grid: which cloud (default: the saved execution target, else BrowserStack)'),
                spec: z.string().optional().describe('openapi: path of the OpenAPI/Swagger file inside the repository, or an http(s) address of a test environment (default: the API description from the wizard)'),
                allowProduction: z.boolean().default(false).describe('openapi: allow downloading from an address that does not look like a test environment. Only after the user confirms it is safe.'),
                servers: z.array(z.enum(COMPANION_IDS)).optional().describe('companions: which servers to add (default: the ones that fit this project)'),
                policy: z.string().optional().describe('org-policy: repository path or https URL of the company policy file (testpilot.org.yaml). Omit to re-check against the saved copy.'),
                platforms: z.array(z.enum(AI_PLATFORMS)).optional().describe('ai-steps: which screens the AI drives (web, android, ios, harmony, computer = desktop). Default: from the app type.')
            }),
            annotations: EXTERNAL
        },
        guarded('add_capability', options, async (args: Args, ctx: unknown) => {
            const { store } = openProject(options, args.projectRoot);
            if (!store.hasConfig()) return failure('Run the wizard first so TestPilot knows the app type and framework.');
            const config = store.readConfig();
            const outcome = await planCapability(store, config, args.capability, {
                shards: args.shards,
                provider: args.provider,
                ciProvider: args.ciProvider,
                spec: args.spec,
                allowProduction: args.allowProduction,
                servers: args.servers,
                policy: args.policy,
                platforms: args.platforms
            });
            if ('error' in outcome) return failure(outcome.error);
            const plan = outcome;
            const changes = plan.files.filter(f => f.status !== 'unchanged');
            const report = typeof plan.data.report === 'string' ? plan.data.report : undefined;

            // A re-check against the saved policy adopts nothing new, so it writes the report straight away.
            if (plan.capability === 'org-policy' && report && !changes.length) {
                store.write(POLICY_REPORT, report);
                return result(`${plan.summary}\n\n${describeExtras(plan)}\n\nReport: ${POLICY_REPORT}`, { capability: plan.capability, report: POLICY_REPORT, ...publicData(plan) });
            }
            if (!changes.length) {
                return result(`${plan.title}: everything is already in place.${plan.snippets.length || plan.notes.length ? `\n\n${describeExtras(plan)}` : ''}`, { capability: plan.capability, files: [], ...publicData(plan) });
            }

            const token = planToken(plan);
            if (!args.confirmToken) {
                const installText = plan.install.length ? `\n\nAfterwards, ${plan.install.map(c => `\`${c.join(' ')}\``).join(' then ')} installs what the new files need (pass install: true to let TestPilot run it).` : '';
                return result(
                    [`${plan.title}`, '', plan.summary, '', describeFiles(plan.files), describeExtras(plan) ? `\n${describeExtras(plan)}` : '', installText, '', `Show the user this preview and ask "${plan.title}: shall I go ahead?" Then call add_capability again with capability "${plan.capability}", the same options and this confirmToken.`].join('\n'),
                    {
                        capability: plan.capability,
                        confirmToken: token,
                        files: plan.files.map(f => ({ path: f.path, status: f.status, note: f.note })),
                        conflicts: plan.files.filter(f => f.status === 'conflict').map(f => f.path),
                        installCommands: plan.install.map(c => c.join(' ')),
                        ...publicData(plan)
                    }
                );
            }
            if (args.confirmToken !== token) return failure('The repository or the options changed since the preview, so the confirmToken no longer matches. Preview again (no confirmToken) and show the user the new version.');
            const conflicts = new Set(plan.files.filter(f => f.status === 'conflict').map(f => f.path));
            const unknown = args.overwrite.filter(p => !conflicts.has(p));
            if (unknown.length) return failure(`These paths are not in the preview's "exists and differs" list: ${unknown.join(', ')}.`);
            const writes = plan.files.filter(f => f.status === 'new' || f.status === 'merge').length + args.overwrite.length;
            const approval = requireApproval(server, ctx, {
                key: `cap_${plan.capability.replace(/-/g, '_')}`,
                question: `${plan.title}: go ahead? TestPilot will write ${writes} file(s)${args.overwrite.length ? `, replacing ${args.overwrite.join(', ')}` : ''}.`,
                userApproved: args.userApproved,
                approver: args.approver
            });
            if (!approval.approved) return approval.reply;

            const { written, kept } = writePlanned(store, plan.files, args.overwrite);
            if (report) store.write(POLICY_REPORT, report);
            store.recordDecision(plan.decision, `Approved ${approval.via === 'form' ? 'in a form' : 'in chat'}`, approval.by);

            const installs = [];
            if (args.install && plan.install.length && options.mode !== 'remote') {
                const cwd = store.resolve(inTestRoot(config, '.') || '.');
                for (const command of plan.install) {
                    const out = await runCommand(cwd, command);
                    installs.push(out);
                    if (!out.ok) break;
                }
            }
            const failed = installs.find(i => !i.ok);
            const installText = failed
                ? `Install failed at \`${failed.command}\`:\n${failed.tail}`
                : installs.length
                  ? 'Dependencies installed.'
                  : plan.install.length
                    ? `Next: run ${plan.install.map(c => `\`${c.join(' ')}\``).join(' then ')}${inTestRoot(config, '.') && inTestRoot(config, '.') !== '.' ? ` in ${inTestRoot(config, '.')}` : ''}.`
                    : '';
            return result(
                [`Wrote ${written.length} file(s).${kept.length ? ` Kept ${kept.length} existing file(s) unchanged: ${kept.join(', ')}.` : ''}${report ? ` Report: ${POLICY_REPORT}.` : ''}`, installText, plan.snippets.length || plan.notes.length ? describeExtras({ ...plan, diffs: [] }) : ''].filter(Boolean).join('\n\n'),
                { capability: plan.capability, written, kept, approvedBy: approval.by, installs, ...publicData(plan) }
            );
        })
    );
}
