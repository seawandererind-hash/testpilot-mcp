import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server';

import { resolveProjectRoot } from './core/paths.js';
import { CONFIG_FILE, PLAN_FILE, ProjectStore, RUNS_DIR, STATE_FILE } from './core/store.js';
import type { ServerOptions } from './tools/common.js';

/** Read-only views of the repository state. They use the server's default project root. */
export function registerResources(server: McpServer, options: ServerOptions): void {
    const store = () => new ProjectStore(resolveProjectRoot(options.root));
    const text = (uri: URL, body: string | undefined, mimeType: string) => ({ contents: [{ uri: uri.href, mimeType, text: body ?? 'Not created yet.' }] });

    server.registerResource('state', 'testpilot://state', { title: 'Wizard state', description: 'Current step, completed steps and approvals (.testpilot/state.json).', mimeType: 'application/json' }, async uri =>
        text(uri, store().read(STATE_FILE), 'application/json')
    );
    server.registerResource('config', 'testpilot://config', { title: 'Saved choices', description: 'Every non-secret choice (.testpilot/config.yaml).', mimeType: 'application/yaml' }, async uri =>
        text(uri, store().read(CONFIG_FILE), 'application/yaml')
    );
    server.registerResource('plan', 'testpilot://plan', { title: 'Automation plan', description: 'plans/automation-plan.md', mimeType: 'text/markdown' }, async uri => text(uri, store().read(PLAN_FILE), 'text/markdown'));
    server.registerResource('latest-report', 'testpilot://reports/latest', { title: 'Latest run summary', description: 'Summary of the most recent test run.', mimeType: 'application/json' }, async uri => {
        const s = store();
        const runs = s.list(RUNS_DIR, name => name.endsWith('.json'));
        return text(uri, runs.length ? s.read(runs[runs.length - 1]) : undefined, 'application/json');
    });
    server.registerResource(
        'test-case',
        new ResourceTemplate('testpilot://test-cases/{id}', {
            list: async () => ({
                resources: store()
                    .readCases()
                    .slice(0, 500)
                    .map(tc => ({ uri: `testpilot://test-cases/${encodeURIComponent(tc.id)}`, name: `${tc.id} ${tc.title}`.slice(0, 120), mimeType: 'text/markdown' }))
            })
        }),
        { title: 'Test case', description: 'One imported test case in TestPilot\'s common format.', mimeType: 'text/markdown' },
        async (uri, { id }) => {
            const s = store();
            const caseId = decodeURIComponent(String(id));
            return text(uri, s.read(s.caseFile(caseId).replace(/\.json$/, '.md')), 'text/markdown');
        }
    );
}
