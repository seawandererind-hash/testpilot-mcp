import { createHash } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { digestOf } from '../core/confirm.js';
import { GITIGNORE_LINES } from '../core/env.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { completeActionStep } from '../core/wizard.js';
import { loadClientMap, planKnowledge } from '../knowledge/generate.js';
import { inTestRoot, MANUAL_SETUP, planGitignore, planPack, type PlannedFile, runCommand, writePlanned } from '../scaffold/engine.js';
import { PACKAGE_NAME } from '../version.js';
import { approverArg, EXTERNAL, failure, guarded, openProject, projectRootArg, READ_ONLY, requireApproval, result, type ServerOptions, userApprovedArg, WRITES_STATE } from './common.js';

export interface ScaffoldPlan {
    packId?: string;
    packTitle?: string;
    files: PlannedFile[];
    install: string[][];
    manual?: string;
    token: string;
}

/** Everything scaffold_project would write, compared with the repository as it is now. */
export function buildScaffoldPlan(store: ProjectStore, config: Config): ScaffoldPlan {
    const files: PlannedFile[] = [];
    let packId: string | undefined;
    let packTitle: string | undefined;
    let install: string[][] = [];
    let manual: string | undefined;
    const extend = config.existing?.mode === 'extend';
    if (!extend) {
        packId = config.stack.templatePack;
        if (packId) {
            const { pack, files: packFiles } = planPack(store, config, packId);
            packTitle = pack.title;
            install = pack.install;
            files.push(...packFiles);
        } else {
            manual = MANUAL_SETUP[config.stack.framework ?? ''] ?? 'TestPilot has no template for this framework yet. Follow the framework\'s getting-started guide; TestPilot still writes the plan, AI instructions and skills.';
        }
    }
    files.push(...planKnowledge(store, config, PACKAGE_NAME));
    files.push(planGitignore(store, GITIGNORE_LINES));
    const fingerprint = files.map(f => [f.path, f.status, createHash('sha256').update(f.content).digest('hex').slice(0, 16)]);
    return { packId, packTitle, files, install, manual, token: `scaffold-${digestOf(fingerprint).slice(0, 20)}` };
}

const STATUS_WORDS: Record<PlannedFile['status'], string> = {
    new: 'create',
    merge: 'update (keeps your content)',
    conflict: 'exists and differs: kept unless you list it in overwrite',
    skip: 'left alone',
    unchanged: 'already up to date'
};

function describePlan(plan: ScaffoldPlan): string {
    const groups = (['new', 'merge', 'conflict', 'skip'] as const)
        .map(status => {
            const items = plan.files.filter(f => f.status === status);
            return items.length ? `${STATUS_WORDS[status]} (${items.length}):\n${items.map(f => `  - ${f.path}${f.note && status !== 'new' ? `: ${f.note}` : ''}`).join('\n')}` : '';
        })
        .filter(Boolean);
    return groups.join('\n');
}

export function registerScaffoldTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'preview_scaffold',
        {
            title: 'Preview project framework',
            description:
                'Shows every file TestPilot would create or update for the chosen framework (page objects, config, fixtures, sample test, AI instructions, skills, MCP configs), without writing anything. Show the list to the user and ask "Can I create the project framework?" before calling scaffold_project with the returned confirmToken.',
            inputSchema: z.object({ projectRoot: projectRootArg }),
            annotations: READ_ONLY
        },
        guarded('preview_scaffold', options, async ({ projectRoot }: { projectRoot?: string }) => {
            const { store } = openProject(options, projectRoot);
            if (!store.hasConfig()) return failure('Run the wizard first so TestPilot knows the app type and framework.');
            const config = store.readConfig();
            if (!config.stack.framework && config.existing?.mode !== 'extend') return failure('Choose a framework in the wizard first (step FRAMEWORK).');
            const plan = buildScaffoldPlan(store, config);
            const changes = plan.files.filter(f => f.status !== 'unchanged');
            const installText = plan.install.length ? `\n\nAfterwards these commands install the tools (scaffold_project can run them with install: true):\n${plan.install.map(c => `  ${c.join(' ')}`).join('\n')}` : '';
            const summary = [
                plan.packTitle ? `Template: ${plan.packTitle}, ${config.stack.pattern ?? 'pom'} pattern, in ${inTestRoot(config, '.') || '.'}` : config.existing?.mode === 'extend' ? 'Your existing framework stays as it is; TestPilot only adds its plan, AI instructions and skills.' : `No template for ${config.stack.framework} yet. ${plan.manual}`,
                '',
                changes.length ? describePlan(plan) : 'Everything is already in place.',
                installText,
                '',
                'Ask the user: "Can I create the project framework?" Then call scaffold_project with this confirmToken.'
            ].join('\n');
            return result(summary, {
                confirmToken: plan.token,
                template: plan.packId ?? null,
                manualSetup: plan.manual ?? null,
                files: plan.files.map(f => ({ path: f.path, status: f.status, note: f.note })),
                conflicts: plan.files.filter(f => f.status === 'conflict').map(f => f.path),
                installCommands: plan.install.map(c => c.join(' '))
            });
        })
    );

    server.registerTool(
        'scaffold_project',
        {
            title: 'Create project framework',
            description:
                'Writes the files shown by preview_scaffold, after the user approves (in a form when the AI tool supports it, otherwise the user says yes in chat and you pass userApproved: true). Existing files that differ are kept unless listed in overwrite. With install: true it also runs npm install and the browser download. Records the approval in .testpilot/decisions.md.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                confirmToken: z.string().describe('The confirmToken from preview_scaffold'),
                userApproved: userApprovedArg,
                approver: approverArg,
                overwrite: z.array(z.string()).default([]).describe('Paths from the preview\'s conflicts list that the user agreed to replace'),
                install: z.boolean().default(false).describe('Also run the install commands (needs network access)')
            }),
            annotations: EXTERNAL
        },
        guarded(
            'scaffold_project',
            options,
            async (args: { projectRoot?: string; confirmToken: string; userApproved?: boolean; approver?: string; overwrite: string[]; install: boolean }, ctx: unknown) => {
                const { store } = openProject(options, args.projectRoot);
                if (!store.hasConfig()) return failure('Run the wizard first.');
                const config = store.readConfig();
                const plan = buildScaffoldPlan(store, config);
                if (args.confirmToken !== plan.token) {
                    return failure('The repository or the setup changed since the preview, so the confirmToken no longer matches. Call preview_scaffold again and show the user the new list.');
                }
                const conflicts = new Set(plan.files.filter(f => f.status === 'conflict').map(f => f.path));
                const unknown = args.overwrite.filter(p => !conflicts.has(p));
                if (unknown.length) return failure(`These paths are not in the preview's conflicts list: ${unknown.join(', ')}.`);
                const writes = plan.files.filter(f => f.status === 'new' || f.status === 'merge').length + args.overwrite.length;
                const approval = requireApproval(server, ctx, {
                    key: 'scaffold',
                    question: `Create the project framework? TestPilot will write ${writes} file(s) in ${store.root}${args.overwrite.length ? `, replacing ${args.overwrite.join(', ')}` : ''}.`,
                    userApproved: args.userApproved,
                    approver: args.approver
                });
                if (!approval.approved) return approval.reply;

                const { written, kept } = writePlanned(store, plan.files, args.overwrite);
                const at = new Date().toISOString();
                store.updateState(s => {
                    s.approvals.push({ what: `scaffold (${written.length} files)`, by: approval.by, at, note: approval.via });
                });
                store.recordDecision(`Created the project framework: ${written.length} file(s) written${args.overwrite.length ? `, replaced ${args.overwrite.join(', ')}` : ''}`, `Approved ${approval.via === 'form' ? 'in a form' : 'in chat'}`, approval.by);
                completeActionStep(store, 'SCAFFOLD', `Scaffolded ${plan.packId ?? 'TestPilot files'}`);

                const installs = [];
                if (args.install && plan.install.length) {
                    const cwd = store.resolve(inTestRoot(config, '.') || '.');
                    for (const command of plan.install) {
                        const outcome = await runCommand(cwd, command);
                        installs.push(outcome);
                        if (!outcome.ok) break;
                    }
                }
                const failed = installs.find(i => !i.ok);
                const next = !args.install && plan.install.length ? `Next: install the tools with ${plan.install.map(c => `\`${c.join(' ')}\``).join(' then ')} (or call scaffold_project again with install: true after a fresh preview).` : '';
                const summary = [
                    `Wrote ${written.length} file(s).${kept.length ? ` Kept ${kept.length} existing file(s) unchanged.` : ''}`,
                    plan.manual ? `Framework setup: ${plan.manual}` : '',
                    failed ? `Install failed at \`${failed.command}\`:\n${failed.tail}\nRun check_prerequisites for fixes.` : installs.length ? 'Dependencies installed.' : next,
                    'Then continue the wizard (action "next").'
                ]
                    .filter(Boolean)
                    .join('\n');
                return result(summary, { written, kept, approvedBy: approval.by, installs });
            }
        )
    );

    server.registerTool(
        'regenerate_docs',
        {
            title: 'Update AI instructions and skills',
            description:
                'Rewrites the files TestPilot owns (AGENTS.md, CLAUDE.md import, Cursor/Antigravity/Copilot rules, skills in .agents/skills and .claude/skills, MCP configs) from the saved setup. Files the user wrote themselves are never touched, and notes between <!-- keep --> markers are preserved.',
            inputSchema: z.object({ projectRoot: projectRootArg }),
            annotations: WRITES_STATE
        },
        guarded('regenerate_docs', options, async ({ projectRoot }: { projectRoot?: string }) => {
            const { store } = openProject(options, projectRoot);
            if (!store.hasConfig()) return failure('Run the wizard first.');
            const outcome = regenerateKnowledge(store);
            return result(
                outcome.written.length ? `Updated ${outcome.written.length} file(s).${outcome.skipped.length ? ` Left ${outcome.skipped.length} file(s) you wrote yourself alone.` : ''}` : 'Everything is already up to date.',
                outcome
            );
        })
    );
}

/** Writes TestPilot-owned knowledge files; never touches files the user owns. */
export function regenerateKnowledge(store: ProjectStore): { written: string[]; skipped: string[] } {
    const files = planKnowledge(store, store.readConfig(), PACKAGE_NAME);
    // MCP configs are added once at scaffold time; if someone later removes TestPilot from one, respect that.
    const mcpConfigs = new Set(loadClientMap().mcpConfigs.map(m => m.file));
    const { written } = writePlanned(store, files.filter(f => f.status === 'new' || (f.status === 'merge' && !mcpConfigs.has(f.path))));
    return { written, skipped: files.filter(f => f.status === 'skip').map(f => f.path) };
}
