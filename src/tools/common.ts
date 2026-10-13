import { acceptedContent, type CallToolResult, inputRequired, type InputRequiredResult, inputResponse, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { detectRepo, type RepoDetection } from '../core/detect.js';
import { PathSandboxError, ProjectRootError, resolveProjectRoot } from '../core/paths.js';
import { redact } from '../core/redact.js';
import { ProjectStore } from '../core/store.js';
import { WizardInputError } from '../core/wizard.js';
import type { DownloadSigner, GitHubSettings } from '../remote/delivery.js';
import { resolveWorkspace } from '../remote/workspaces.js';

export interface HostedOptions {
    /** Folder holding every person's workspaces. */
    workspacesDir: string;
    /** This person's own folder (one per signed-in user). */
    userBase: string;
    /** Who is signed in, for the decision log. */
    user: string;
    /** Public origin of the server, e.g. https://testpilot.example.com, for download links. */
    publicOrigin: string;
    signer: DownloadSigner;
    github?: GitHubSettings;
}

export interface ServerOptions {
    /** Default project root (from --root or TESTPILOT_ROOT). */
    root?: string;
    /** 'local' writes to the repository on this machine; 'remote' is the hosted mode used by ChatGPT and claude.ai. */
    mode: 'local' | 'remote';
    version: string;
    hosted?: HostedOptions;
}

export const projectRootArg = z
    .string()
    .optional()
    .describe('Absolute path of the project repository. Omit to use the folder TestPilot was started in. On a hosted TestPilot (ChatGPT, claude.ai) this is a workspace name such as "shop-web" instead.');

/** The folder a tool call works in: a repository on this machine, or a hosted workspace. */
export function projectRootFor(options: ServerOptions, explicit?: string, create = true): string {
    if (options.mode === 'remote') {
        if (!options.hosted) throw new ProjectRootError('Hosted mode is not configured.');
        return resolveWorkspace(options.hosted.userBase, explicit, create);
    }
    return resolveProjectRoot(explicit ?? options.root);
}

/** Tools that run programs on the machine. A hosted server never runs them; the team runs tests locally or in CI. */
const HOSTED_UNAVAILABLE: Record<string, string> = {
    run_tests: 'A hosted TestPilot does not run tests. Deliver the project (hosted_workspace, action "zip" or "pull-request"), then run the tests on your machine or in CI with the pipeline from publish_results.',
    explore_app: 'A hosted TestPilot does not open browsers or apps. Exploration runs in a local TestPilot (Cursor, Claude Code, VS Code, Antigravity) against your test environment.',
    live_test: 'A hosted TestPilot does not open browsers. Live testing runs in a local TestPilot (Cursor, Claude Code, VS Code, Antigravity) against your test environment.',
    heal_tests: 'A hosted TestPilot has no test runs or traces to work from. Run a local TestPilot (Cursor, Claude Code, VS Code) next to your tests to heal, explain or quarantine them.',
    check_prerequisites: 'A hosted TestPilot cannot see your machine. Once the project is delivered, run a local TestPilot and call check_prerequisites there.'
    check_prerequisites: 'A hosted TestPilot cannot see your machine. Once the project is delivered, run a local TestPilot and call check_prerequisites there.',
    quality_scan: 'A hosted TestPilot does not run compilers, browsers or tests. Run quality_scan (gate, accessibility, visual) in a local TestPilot against your checked-out project.'
};

export interface ProjectContext {
    store: ProjectStore;
    detection: () => RepoDetection;
}

export function openProject(options: ServerOptions, explicit?: string): ProjectContext {
    const root = projectRootFor(options, explicit);
    const store = new ProjectStore(root);
    let cached: RepoDetection | undefined;
    return { store, detection: () => (cached ??= detectRepo(root)) };
}

/**
 * Builds a tool result with both a readable summary and structured JSON.
 * Structured output stays object-shaped for 2025-era clients, and the JSON is
 * repeated as text for clients that ignore structuredContent.
 */
export function result(summary: string, data: Record<string, unknown>): CallToolResult {
    const safe = redact(data);
    const text = `${summary}\n\n${JSON.stringify(safe, null, 2)}`;
    return {
        content: [{ type: 'text', text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated; full details are in the files listed above)` : text }],
        structuredContent: safe
    };
}

export function failure(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

const USER_ERRORS = [ProjectRootError, PathSandboxError, WizardInputError];

/** Wraps a handler: audits the call and turns expected errors into readable tool errors. */
export function guarded<A extends Record<string, unknown>, R>(toolName: string, options: ServerOptions, handler: (args: A, ctx: unknown) => Promise<R>): (args: A, ctx: unknown) => Promise<R | CallToolResult> {
    return async (args, ctx) => {
        if (options.mode === 'remote' && HOSTED_UNAVAILABLE[toolName]) return failure(HOSTED_UNAVAILABLE[toolName]);
        let store: ProjectStore | undefined;
        try {
            store = tryOpen(options, args.projectRoot as string | undefined);
        } catch {
            store = undefined;
        }
        try {
            const out = await handler(args, ctx);
            const isInput = typeof out === 'object' && out !== null && (out as { resultType?: string }).resultType === 'input_required';
            store?.audit(toolName, args, isInput ? 'input_required' : (out as CallToolResult)?.isError ? 'error' : 'ok');
            return out;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            store?.audit(toolName, args, 'error', message);
            if (USER_ERRORS.some(E => error instanceof E)) return failure(message);
            console.error(`[testpilot] ${toolName} failed:`, error);
            return failure(`${toolName} failed: ${message}`);
        }
    };
}

function tryOpen(options: ServerOptions, explicit?: string): ProjectStore | undefined {
    try {
        const store = new ProjectStore(projectRootFor(options, explicit, false));
        return store.hasConfig() || store.exists('.testpilot') ? store : undefined;
    } catch {
        return undefined;
    }
}

const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

/**
 * True when the connected client declared form elicitation. 2026-07-28 requests
 * carry capabilities in the per-request envelope; 2025-era connections declared
 * them at initialize.
 */
export function clientSupportsForms(server: McpServer, ctx?: { mcpReq?: { envelope?: Record<string, unknown> } }): boolean {
    try {
        const fromEnvelope = ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_KEY] as { elicitation?: Record<string, unknown> } | undefined;
        const caps = fromEnvelope ?? (server.server.getClientCapabilities() as { elicitation?: Record<string, unknown> } | undefined);
        return Boolean(caps?.elicitation && (caps.elicitation.form !== undefined || Object.keys(caps.elicitation).length === 0));
    } catch {
        return false;
    }
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const WRITES_STATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const WRITES_FILES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
export const EXTERNAL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export type ApprovalOutcome = { approved: true; by: string; via: 'form' | 'chat' } | { approved: false; reply: CallToolResult | InputRequiredResult };

const ApprovalForm = z.object({
    approve: z.boolean().meta({ title: 'Approve', description: 'Tick to go ahead. Leave unticked to cancel.' }),
    name: z.string().optional().meta({ title: 'Your name (for the decision log)' })
});

/**
 * The approval gate in front of every write the user should see first.
 * When the AI tool supports forms, the user always approves in a form, which the
 * model cannot fill in. Otherwise the model must ask in chat and pass userApproved: true.
 */
export function requireApproval(
    server: McpServer,
    rawCtx: unknown,
    request: { key: string; question: string; userApproved?: boolean; approver?: string }
): ApprovalOutcome {
    const ctx = rawCtx as ServerContext | undefined;
    if (ctx && clientSupportsForms(server, ctx as never)) {
        const key = `approve_${request.key}`;
        const view = inputResponse(ctx.mcpReq.inputResponses, key);
        if (view.kind === 'elicit') {
            const content = view.action === 'accept' ? acceptedContent(ctx.mcpReq.inputResponses, key, ApprovalForm) : undefined;
            if (content?.approve) return { approved: true, by: content.name?.trim() || 'user (approved in form)', via: 'form' };
            return { approved: false, reply: result('The user did not approve, so nothing was changed. Ask what they would like to adjust.', { approved: false }) };
        }
        return { approved: false, reply: inputRequired({ inputRequests: { [key]: inputRequired.elicit({ message: request.question, requestedSchema: ApprovalForm }) } }) };
    }
    if (request.userApproved === true) return { approved: true, by: request.approver?.trim() || 'user (confirmed in chat)', via: 'chat' };
    return {
        approved: false,
        reply: failure(`Approval needed. Show the user the preview and ask: "${request.question}". Call this tool again with userApproved: true only after they clearly say yes.`)
    };
}

export const userApprovedArg = z
    .boolean()
    .optional()
    .describe('Set to true only after the user has seen the preview and explicitly said yes in this conversation. Never assume it.');
export const approverArg = z.string().optional().describe('Name of the person who approved, for the decision log.');
