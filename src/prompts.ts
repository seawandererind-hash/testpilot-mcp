import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

const RULES =
    'Rules: ask one question at a time in plain words and show TestPilot\'s recommendation; never invent the user\'s answers; never ask for passwords or API keys in chat (they go in .env); show every preview and wait for an explicit yes before calling a tool with userApproved: true.';

/** Slash commands (MCP prompts) that start each part of the workflow. */
export function registerPrompts(server: McpServer): void {
    server.registerPrompt(
        'qa-setup',
        {
            title: 'Set up test automation',
            description: 'Start or resume TestPilot\'s guided setup for this repository.',
            argsSchema: z.object({ projectRoot: z.string().optional().describe('Repository folder, if not the current one') })
        },
        ({ projectRoot }) =>
            user(
                `Help me set up test automation with TestPilot${projectRoot ? ` in ${projectRoot}` : ''}. First call testpilot_status, then detect_repo. Then run the wizard: call wizard with action "next", ask me each question, and save my answers with action "answer" until the wizard reaches an action step; for action steps follow the instructions the wizard gives. ${RULES}`
            )
    );
    server.registerPrompt(
        'qa-import',
        { title: 'Import and review test cases', description: 'Import test cases from Jira, Xray, Zephyr, BrowserStack, TestRail, Azure DevOps, Excel, CSV, Word, Gherkin or Markdown and review them.', argsSchema: z.object({ source: z.string().optional(), location: z.string().optional().describe('File path, JQL, project or plan id') }) },
        ({ source, location }) =>
            user(`Import my test cases${source ? ` from ${source}` : ''}${location ? ` (${location})` : ''} with import_test_cases, then run review_test_cases. Summarise the verdicts (automate / manual / needs rework), show the top suggestions, and ask whether to apply any rewrites. ${RULES}`)
    );
    server.registerPrompt('qa-plan', { title: 'Build the automation plan', description: 'Create plans/automation-plan.md from the reviewed test cases and get it approved.' }, () =>
        user(`Call automation_plan with action "generate". Summarise scope, waves, page objects, risks and open questions. Ask me who approves the plan; call automation_plan with action "approve" only after I explicitly approve. ${RULES}`)
    );
    server.registerPrompt('qa-generate', { title: 'Generate tests', description: 'Write tests for the next wave of the approved plan.', argsSchema: z.object({ wave: z.string().optional() }) }, ({ wave }) =>
        user(`Call generate_tests with action "preview"${wave ? ` for wave ${wave}` : ''}, show me the files, and after I agree call it with action "apply" and the confirmToken. Then implement every step marked TODO(testpilot) using the page objects and the write-*-test skill, keeping one behaviour per test and no fixed sleeps. ${RULES}`)
    );
    server.registerPrompt('qa-run', { title: 'Run and triage tests', description: 'Run tests, triage failures and propose fixes.', argsSchema: z.object({ selection: z.string().optional().describe('A test id, tag or file') }) }, ({ selection }) =>
        user(`Call run_tests${selection ? ` with selection "${selection}"` : ''}. For each failure explain the triage category and propose a fix as a diff. Never weaken or delete an assertion without asking me. When tests pass, run them again with stabilityRuns: 2. ${RULES}`)
    );
    server.registerPrompt('qa-status', { title: 'Where are we?', description: 'Show where this repository is in the TestPilot workflow.' }, () =>
        user('Call testpilot_status and tell me in a few lines where we are, what is done, and what the next step is.')
    );
}
