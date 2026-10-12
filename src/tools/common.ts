import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { detectRepo, type RepoDetection } from '../core/detect.js';
import { PathSandboxError, ProjectRootError, resolveProjectRoot } from '../core/paths.js';
import { redact } from '../core/redact.js';
import { ProjectStore } from '../core/store.js';
import { WizardInputError } from '../core/wizard.js';

export interface ServerOptions {
    /** Default project root (from --root or TESTPILOT_ROOT). */
    root?: string;
    /** 'local' writes to disk; 'remote' is the hosted mode used by ChatGPT / claude.ai. */
    mode: 'local' | 'remote';
    version: string;
}

export const projectRootArg = z
    .string()
    .optional()
    .describe('Absolute path of the project repository. Omit to use the folder TestPilot was started in.');

export interface ProjectContext {
    store: ProjectStore;
    detection: () => RepoDetection;
}

export function openProject(options: ServerOptions, explicit?: string): ProjectContext {
    const root = resolveProjectRoot(explicit ?? options.root);
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
        const store = new ProjectStore(resolveProjectRoot(explicit ?? options.root));
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
