import { createHash } from 'node:crypto';
import { renameSync } from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { digestOf } from '../core/confirm.js';
import { GITIGNORE_LINES } from '../core/env.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { completeActionStep } from '../core/wizard.js';
import { loadClientMap, planKnowledge } from '../knowledge/generate.js';
import { inTestRoot, installCommandsFor, MANUAL_SETUP, manualSetupFor, planGitignore, planPack, type PlannedFile, runCommand, writePlanned } from '../scaffold/engine.js';
import { PACKAGE_NAME } from '../version.js';
import { approverArg, EXTERNAL, failure, guarded, openProject, projectRootArg, READ_ONLY, requireApproval, result, type ServerOptions, userApprovedArg, WRITES_STATE } from './common.js';

export interface ScaffoldPlan {
    packId?: string;
    packTitle?: string;
    files: PlannedFile[];
    install: string[][];
    manual?: string;
    /** Files sitting where a folder is needed; scaffold_project renames each to `<name>.old` first. */
    blockers: Array<{ file: string; renameTo: string }>;
    token: string;
}

/** A free `<file>.old` name next to `file` (then `.old-2`, `.old-3`, ...). */
function oldNameFor(store: ProjectStore, file: string): string {
    let candidate = `${file}.old`;
    for (let i = 2; store.exists(candidate); i++) candidate = `${file}.old-${i}`;
    return candidate;
}

/**
 * Finds files that sit where the framework needs a folder (for example a file
 * called `.cursor` when TestPilot writes `.cursor/rules/testpilot.mdc`), and
 * marks planned files whose own path is an existing folder as left alone.
 */
function findBlockers(store: ProjectStore, files: PlannedFile[]): ScaffoldPlan['blockers'] {
    const found = new Map<string, string>();
    for (const f of files) {
        if (f.status === 'unchanged' || f.status === 'skip') continue;
        const blocker = store.blockingFile(f.path);
        if (blocker) {
            if (!found.has(blocker)) found.set(blocker, oldNameFor(store, blocker));
        } else if (store.isDirectory(f.path)) {
            f.status = 'skip';
            f.note = 'A folder with this name already exists, so TestPilot leaves it alone. Rename the folder and preview again if you want this file.';
        }
    }
    return [...found].map(([file, renameTo]) => ({ file, renameTo }));
}

/** Renames each blocking file to its `.old` name so the folder can be created. Nothing is deleted. */
export function moveBlockersAside(store: ProjectStore, plan: ScaffoldPlan): { renamed: ScaffoldPlan['blockers'] } | { error: string } {
    const renamed: ScaffoldPlan['blockers'] = [];
    for (const b of plan.blockers) {
        try {
            renameSync(store.resolve(b.file), store.resolve(b.renameTo));
            renamed.push(b);
        } catch (error) {
            return {
                error:
                    `TestPilot needs a folder called "${b.file}", but there is a file with that name and TestPilot could not rename it (${(error as NodeJS.ErrnoException).code ?? 'error'}). ` +
                    `Nothing else was written. Close any program that has "${b.file}" open, rename or delete that file yourself in your project folder, then try again.`
            };
        }
    }
    return { renamed };
}

export function describeBlockers(blockers: ScaffoldPlan['blockers']): string {
    if (!blockers.length) return '';
    return [
        '',
        'Heads-up: TestPilot needs a folder where your project has a file with the same name:',
        ...blockers.map(b => `  - "${b.file}" is a file, but a folder is needed there. If you say yes, TestPilot renames the file to "${b.renameTo}" (nothing is deleted) and then creates the folder.`)
    ].join('\n');
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
            install = installCommandsFor(pack, config);
            manual = manualSetupFor(pack, config);
            files.push(...packFiles);
        } else {
            manual = MANUAL_SETUP[config.stack.framework ?? ''] ?? 'TestPilot has no template for this framework yet. Follow the framework\'s getting-started guide; TestPilot still writes the plan, AI instructions and skills.';
        }
    }
    files.push(...planKnowledge(store, config, PACKAGE_NAME));
    files.push(planGitignore(store, GITIGNORE_LINES));
    const blockers = findBlockers(store, files);
    const fingerprint = [...files.map(f => [f.path, f.status, createHash('sha256').update(f.content).digest('hex').slice(0, 16)]), ...blockers.map(b => ['blocker', b.file, b.renameTo])];
    return { packId, packTitle, files, install, manual, blockers, token: `scaffold-${digestOf(fingerprint).slice(0, 20)}` };
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
                describeBlockers(plan.blockers),
                installText,
                plan.packTitle && plan.manual ? `\nThe user also needs to do these steps themselves (TestPilot cannot install SDKs or devices):\n${plan.manual}` : '',
                '',
                'Ask the user: "Can I create the project framework?" Then call scaffold_project with this confirmToken.'
            ].join('\n');
            return result(summary, {
                confirmToken: plan.token,
                template: plan.packId ?? null,
                manualSetup: plan.manual ?? null,
                files: plan.files.map(f => ({ path: f.path, status: f.status, note: f.note })),
                conflicts: plan.files.filter(f => f.status === 'conflict').map(f => f.path),
                blockers: plan.blockers,
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

                // Files sitting where a folder is needed were shown in the preview; move them aside, never delete.
                const moved = moveBlockersAside(store, plan);
                if ('error' in moved) return failure(moved.error);
                const renamed = moved.renamed;
                const { written, kept } = writePlanned(store, plan.files, args.overwrite);
                const at = new Date().toISOString();
                store.updateState(s => {
                    s.approvals.push({ what: `scaffold (${written.length} files)`, by: approval.by, at, note: approval.via });
                });
                for (const b of renamed) store.recordDecision(`Renamed the file ${b.file} to ${b.renameTo}`, `A folder called ${b.file} was needed for the framework; shown in the preview and approved`, approval.by);
                store.recordDecision(`Created the project framework: ${written.length} file(s) written${args.overwrite.length ? `, replaced ${args.overwrite.join(', ')}` : ''}`, `Approved ${approval.via === 'form' ? 'in a form' : 'in chat'}`, approval.by);
                completeActionStep(store, 'SCAFFOLD', `Scaffolded ${plan.packId ?? 'TestPilot files'}`);

                const installs = [];
                // A hosted server never runs installs; the team installs after delivery.
                if (args.install && plan.install.length && options.mode !== 'remote') {
                    const cwd = store.resolve(inTestRoot(config, '.') || '.');
                    for (const command of plan.install) {
                        const outcome = await runCommand(cwd, command);
                        installs.push(outcome);
                        if (!outcome.ok) break;
                    }
                }
                const failed = installs.find(i => !i.ok);
                const next = options.mode === 'remote' && plan.install.length ? `After delivery (hosted_workspace), install the tools with ${plan.install.map(c => `\`${c.join(' ')}\``).join(' then ')}.` : !args.install && plan.install.length ? `Next: install the tools with ${plan.install.map(c => `\`${c.join(' ')}\``).join(' then ')} (or call scaffold_project again with install: true after a fresh preview).` : '';
                const summary = [
                    `Wrote ${written.length} file(s).${kept.length ? ` Kept ${kept.length} existing file(s) unchanged.` : ''}`,
                    ...renamed.map(b => `Renamed the file "${b.file}" to "${b.renameTo}" so the "${b.file}" folder could be created. Nothing was deleted.`),
                    plan.manual ? `Framework setup${plan.packTitle ? ' (steps for the user)' : ''}:${plan.manual.includes('\n') ? '\n' : ' '}${plan.manual}` : '',
                    failed ? `Install failed at \`${failed.command}\`:\n${failed.tail}\nRun check_prerequisites for fixes.` : installs.length ? 'Dependencies installed.' : next,
                    'Then continue the wizard (action "next").'
                ]
                    .filter(Boolean)
                    .join('\n');
                return result(summary, { written, kept, renamed, approvedBy: approval.by, installs });
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
