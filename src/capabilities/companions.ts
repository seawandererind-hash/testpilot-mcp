import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { loadClientMap } from '../knowledge/generate.js';
import type { PlannedFile } from '../scaffold/engine.js';
import { type CapabilityPlan, type CompanionId, emptyPlan, lineDiff, type PlanOutcome } from './shared.js';

/**
 * Companion MCP servers that work next to TestPilot. Versions are pinned to the
 * latest stable release that was at least two weeks old when checked on 2026-10-13
 * (npm registry), so a broken new release cannot reach the team unannounced.
 */
export const COMPANION_VERSIONS = {
    playwright: '0.0.83',
    appium: '1.95.1',
    browserstack: '2.0.0'
} as const;

type Client = 'claude' | 'cursor' | 'antigravity' | 'other';

interface Companion {
    id: CompanionId;
    title: string;
    why: string;
    /** The server entry for one AI tool's config file, or undefined when that tool cannot hold it safely. */
    entry: (client: Client) => Record<string, unknown> | undefined;
    note?: string;
}

/** Environment-variable references in each tool's own syntax, so values stay out of the file. */
function envRef(client: Client, name: string): string | undefined {
    if (client === 'claude') return `\${${name}}`;
    if (client === 'cursor') return `\${env:${name}}`;
    return undefined;
}

function stdio(client: Client, args: string[], env: string[] = []): Record<string, unknown> {
    const entry: Record<string, unknown> = client === 'claude' ? { type: 'stdio', command: 'npx', args } : { command: 'npx', args };
    const refs = env.map(name => [name, envRef(client, name)] as const).filter((pair): pair is readonly [string, string] => pair[1] !== undefined);
    if (refs.length) entry.env = Object.fromEntries(refs);
    return entry;
}

function remote(client: Client, url: string, headers: Record<string, string> = {}): Record<string, unknown> {
    const resolved = Object.entries(headers)
        .map(([key, value]) => {
            const name = value.match(/\{(\w+)\}/)?.[1];
            const ref = name ? envRef(client, name) : undefined;
            return ref ? ([key, value.replace(`{${name}}`, ref)] as const) : undefined;
        })
        .filter((pair): pair is readonly [string, string] => pair !== undefined);
    const extra = resolved.length ? { headers: Object.fromEntries(resolved) } : {};
    if (client === 'claude') return { type: 'http', url, ...extra };
    if (client === 'antigravity') return { serverUrl: url, ...extra };
    return { url, ...extra };
}

export const COMPANIONS: Record<CompanionId, Companion> = {
    playwright: {
        id: 'playwright',
        title: 'Playwright MCP',
        why: 'Lets your AI tool open a real browser, click through the app and read the page, which helps when writing or debugging a test.',
        entry: client => stdio(client, ['-y', `@playwright/mcp@${COMPANION_VERSIONS.playwright}`])
    },
    appium: {
        id: 'appium',
        title: 'Appium MCP',
        why: 'Lets your AI tool drive the app on an emulator, simulator or desktop session and inspect its screens while you write tests.',
        entry: client => stdio(client, ['-y', `appium-mcp@${COMPANION_VERSIONS.appium}`]),
        note: 'Appium MCP needs Appium and the platform tools (Android SDK or Xcode) on this computer.'
    },
    browserstack: {
        id: 'browserstack',
        title: 'BrowserStack MCP',
        why: 'Lets your AI tool start BrowserStack runs, open real devices and read test results and failure logs from BrowserStack.',
        entry: client => (client === 'antigravity' ? undefined : stdio(client, ['-y', `@browserstack/mcp-server@${COMPANION_VERSIONS.browserstack}`], ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY'])),
        note: 'BrowserStack MCP reads BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY from your shell environment. Set them in your profile, not in the config file.'
    },
    atlassian: {
        id: 'atlassian',
        title: 'Atlassian Rovo MCP',
        why: 'Lets your AI tool read and update Jira issues and Xray tests directly, for example to look up a story while writing its test.',
        entry: client => remote(client, 'https://mcp.atlassian.com/v1/mcp'),
        note: 'Atlassian signs you in through your browser (OAuth) the first time; no key goes in the file.'
    },
    github: {
        id: 'github',
        title: 'GitHub MCP',
        why: 'Lets your AI tool read pull requests, GitHub Actions runs and their logs, so it can explain why tests failed in CI.',
        entry: client => (client === 'antigravity' ? undefined : remote(client, 'https://api.githubcopilot.com/mcp/', { Authorization: 'Bearer {GITHUB_PAT}' })),
        note: 'GitHub MCP needs a personal access token in the GITHUB_PAT environment variable of your shell (never in the file). VS Code can sign in with OAuth instead.'
    }
};

/** Which companions fit this project, with the reason each was picked. */
export function recommendCompanions(config: Config): CompanionId[] {
    const out: CompanionId[] = [];
    const app = config.appType;
    if (!app || app === 'web' || app === 'electron' || app === 'hybrid') out.push('playwright');
    if (app && ['android', 'ios', 'android-ios', 'hybrid', 'windows', 'macos'].includes(app)) out.push('appium');
    if (config.execution.target === 'browserstack' || config.integrations.testCaseSource === 'browserstack') out.push('browserstack');
    if (config.integrations.testCaseSource === 'jira' || config.integrations.testCaseSource === 'xray' || config.integrations.defectTracker === 'jira') out.push('atlassian');
    if (config.integrations.ci === 'github-actions') out.push('github');
    return out;
}

function clientOf(file: string): Client {
    if (file === '.mcp.json') return 'claude';
    if (file.startsWith('.cursor/')) return 'cursor';
    if (file.startsWith('.agents/')) return 'antigravity';
    return 'other';
}

/** Merges servers into one MCP config file. Existing servers (and every other key) are never changed or removed. */
export function mergeMcpConfig(current: string | undefined, key: string, additions: Record<string, Record<string, unknown>>): { content: string; added: string[]; kept: string[] } | { error: string } {
    let json: Record<string, unknown> = {};
    if (current !== undefined && current.trim()) {
        try {
            const parsed = JSON.parse(current) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'not a JSON object' };
            json = parsed as Record<string, unknown>;
        } catch {
            return { error: 'not valid JSON' };
        }
    }
    const existing = json[key];
    if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) return { error: `"${key}" is not an object` };
    const servers = { ...((existing as Record<string, unknown>) ?? {}) };
    const added: string[] = [];
    const kept: string[] = [];
    for (const [name, entry] of Object.entries(additions)) {
        if (name in servers) kept.push(name);
        else {
            servers[name] = entry;
            added.push(name);
        }
    }
    json[key] = servers;
    return { content: JSON.stringify(json, null, 2) + '\n', added, kept };
}

export function planCompanions(store: ProjectStore, config: Config, servers?: CompanionId[]): PlanOutcome {
    const recommended = recommendCompanions(config);
    const chosen = servers?.length ? servers : recommended;
    if (!chosen.length) return { error: 'No companion servers fit this setup yet. Pick some with servers: playwright, appium, browserstack, atlassian, github.' };
    const plan: CapabilityPlan = emptyPlan(
        'companions',
        'Companion MCP servers',
        `Adds ${chosen.map(id => COMPANIONS[id].title).join(', ')} next to TestPilot in your AI tools' MCP config files. Servers you already have are kept as they are.`,
        `Added companion MCP servers: ${chosen.join(', ')}`
    );
    const map = loadClientMap();
    const skippedFor: string[] = [];
    for (const mcp of map.mcpConfigs) {
        const client = clientOf(mcp.file);
        const additions: Record<string, Record<string, unknown>> = {};
        for (const id of chosen) {
            const entry = COMPANIONS[id].entry(client);
            if (entry) additions[id] = entry;
            else skippedFor.push(`${COMPANIONS[id].title} for ${mcp.clients.join(', ')}`);
        }
        if (!Object.keys(additions).length) continue;
        const current = store.read(mcp.file);
        const merged = mergeMcpConfig(current, mcp.key, additions);
        if ('error' in merged) {
            plan.files.push({ path: mcp.file, status: 'skip', content: current ?? '', note: `Left alone: ${merged.error}. Add the servers by hand.` });
            continue;
        }
        let file: PlannedFile;
        if (current === undefined) file = { path: mcp.file, status: 'new', content: merged.content, note: `For ${mcp.clients.join(', ')}.` };
        else if (!merged.added.length) file = { path: mcp.file, status: 'unchanged', content: current };
        else {
            file = { path: mcp.file, status: 'merge', content: merged.content, note: `Adds ${merged.added.join(', ')}${merged.kept.length ? `; keeps your existing ${merged.kept.join(', ')}` : ''}.` };
            plan.diffs.push({ path: mcp.file, diff: lineDiff(current, merged.content) });
        }
        plan.files.push(file);
    }
    plan.notes.push(...chosen.map(id => `${COMPANIONS[id].title}: ${COMPANIONS[id].why}${COMPANIONS[id].note ? ` ${COMPANIONS[id].note}` : ''}`));
    if (skippedFor.length) plan.notes.push(`Not added for Antigravity, whose config file has no safe way to reference a key from the environment: ${[...new Set(skippedFor)].join('; ')}. Add it in Antigravity's own MCP settings (… → MCP Servers) so the key stays on your machine.`);
    plan.notes.push('Restart your AI tool (or reload its MCP servers) after the files are written.');
    plan.data = { recommended, chosen, versions: COMPANION_VERSIONS };
    return plan;
}
