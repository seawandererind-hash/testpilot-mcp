import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { INTEGRATION_KEYS, integrationsFor, keysFor } from '../catalog/env-keys.js';
import { testConnection } from '../core/connections.js';
import { checkEnv, ENV_EXAMPLE_FILE, loadEnvValues, writeEnvTemplate } from '../core/env.js';
import { completeActionStep } from '../core/wizard.js';
import { guarded, openProject, projectRootArg, READ_ONLY, result, type ServerOptions } from './common.js';

const integrationsArg = z
    .array(z.enum(Object.keys(INTEGRATION_KEYS) as [string, ...string[]]))
    .optional()
    .describe('Integrations to include. Omit to derive them from the saved setup.');

export function registerEnvTools(server: McpServer, options: ServerOptions): void {
    server.registerTool(
        'write_env_template',
        {
            title: 'Write .env template',
            description:
                'Adds the credential keys this setup needs to .env.example, with a note on where to get each one, and makes sure .env is git-ignored. Never writes values. Afterwards, ask the user to copy .env.example to .env and fill it in themselves; never ask for secrets in chat.',
            inputSchema: z.object({ projectRoot: projectRootArg, integrations: integrationsArg }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        guarded('write_env_template', options, async ({ projectRoot, integrations }: { projectRoot?: string; integrations?: string[] }) => {
            const { store } = openProject(options, projectRoot);
            const config = store.readConfig();
            const wanted = integrations ?? integrationsFor(config);
            const keys = keysFor(wanted);
            const { added, gitignoreUpdated } = writeEnvTemplate(store, keys);
            const lines = keys.map(k => `- ${k.name}${k.required ? '' : ' (optional)'}: ${k.description}. Where to get it: ${k.whereToGet}`);
            return result(
                `${added.length ? `Added ${added.length} key(s) to ${ENV_EXAMPLE_FILE}.` : `${ENV_EXAMPLE_FILE} already lists every key.`} ${gitignoreUpdated.length ? '.gitignore now ignores .env and test output.' : ''}\n\nTell the user: copy .env.example to .env and fill in:\n${lines.join('\n')}`,
                { integrations: wanted, keys: keys.map(({ name, description, whereToGet, required }) => ({ name, description, whereToGet, required })), added, gitignoreUpdated }
            );
        })
    );

    server.registerTool(
        'check_env',
        {
            title: 'Check .env',
            description:
                'Checks that each needed key is filled in .env with a plausible format, reporting only present / missing / invalid-format (never values). With testConnections, it also tries to log in to each integration and reports ok or the error. Completes the wizard\'s credentials step when everything required is present.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                integrations: integrationsArg,
                testConnections: z.boolean().default(false).describe('Also try to connect to Jira, BrowserStack, etc. with the stored credentials.')
            }),
            annotations: { ...READ_ONLY, openWorldHint: true }
        },
        guarded('check_env', options, async ({ projectRoot, integrations, testConnections }: { projectRoot?: string; integrations?: string[]; testConnections: boolean }) => {
            const { store } = openProject(options, projectRoot);
            const config = store.readConfig();
            const wanted = integrations ?? integrationsFor(config);
            const outcome = checkEnv(store, keysFor(wanted));
            const connections = testConnections && outcome.ok ? await Promise.all(wanted.filter(i => i !== 'mobile').map(i => testConnection(i, loadEnvValues(store)))) : [];
            const missing = outcome.checks.filter(c => c.required && c.status !== 'present');
            if (outcome.ok && store.hasConfig() && !store.readState().completed.includes('SECRETS')) {
                completeActionStep(store, 'SECRETS', `Credentials present for: ${wanted.join(', ')}`);
            }
            const summary = !outcome.envFileExists
                ? 'There is no .env file yet. Ask the user to copy .env.example to .env and fill it in.'
                : outcome.ok
                  ? `All required keys are present.${connections.length ? ` Connections: ${connections.map(c => `${c.integration} ${c.ok ? 'ok' : 'failed'}`).join(', ')}.` : ''}`
                  : `Still needed: ${missing.map(m => `${m.key} (${m.status})`).join(', ')}.`;
            return result(summary, { ...outcome, connections });
        })
    );
}
