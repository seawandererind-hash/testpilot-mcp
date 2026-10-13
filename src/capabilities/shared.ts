import { statSync } from 'node:fs';

import type { EnvKey } from '../catalog/env-keys.js';
import { ENV_EXAMPLE_FILE, parseDotenv } from '../core/env.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { inTestRoot, type PackManifest, type PlannedFile, planPackageJson } from '../scaffold/engine.js';

export const CAPABILITIES = ['login-once', 'test-data', 'ci-speed', 'cloud-grid', 'openapi', 'companions', 'org-policy'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CLOUD_PROVIDERS = ['browserstack', 'saucelabs', 'lambdatest'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const COMPANION_IDS = ['playwright', 'appium', 'browserstack', 'atlassian', 'github'] as const;
export type CompanionId = (typeof COMPANION_IDS)[number];

/** Everything add_capability would do for one capability, compared with the repository as it is now. */
export interface CapabilityPlan {
    capability: Capability;
    title: string;
    /** Plain-language explanation shown first in the preview. */
    summary: string;
    files: PlannedFile[];
    /** Line diffs of existing files TestPilot patches, for the preview. */
    diffs: Array<{ path: string; diff: string }>;
    /** Text the user pastes themselves (when TestPilot cannot safely edit a file). */
    snippets: Array<{ title: string; content: string }>;
    notes: string[];
    /** Commands that install what the new files need, run in the test folder when install is true. */
    install: string[][];
    /** One line for .testpilot/decisions.md. */
    decision: string;
    data: Record<string, unknown>;
}

export type PlanOutcome = CapabilityPlan | { error: string };

export interface CapabilityInput {
    shards?: number;
    provider?: CloudProvider;
    ciProvider?: string;
    spec?: string;
    allowProduction?: boolean;
    servers?: CompanionId[];
    policy?: string;
    /** Injected in tests; defaults to global fetch. */
    fetch?: typeof fetch;
}

export function emptyPlan(capability: Capability, title: string, summary: string, decision: string): CapabilityPlan {
    return { capability, title, summary, files: [], diffs: [], snippets: [], notes: [], install: [], decision, data: {} };
}

export type Lang = { ext: 'ts' | 'js'; typescript: boolean };

/** The Playwright language of the project, or a friendly explanation when the stack is something else. */
export function playwrightLang(config: Config, what: string): Lang | { error: string } {
    const fw = config.stack.framework ?? '';
    const language = config.stack.language ?? 'typescript';
    if (!fw.startsWith('playwright')) {
        return { error: `${what} is written for Playwright projects, and this project uses ${fw || 'no framework yet'}. ${fw ? 'Ask your AI tool to apply the same idea with your framework\'s own features, or pick Playwright in the wizard.' : 'Finish the wizard (step FRAMEWORK) first.'}` };
    }
    if (language === 'typescript') return { ext: 'ts', typescript: true };
    if (language === 'javascript') return { ext: 'js', typescript: false };
    return { error: `${what} writes TypeScript or JavaScript files, and this project uses ${language}. Ask your AI tool to port the idea to ${language}; TestPilot does not write ${language} code for it yet.` };
}

/** playwright.config.(ts|js|mjs) in the test folder, when there is one. */
export function findPlaywrightConfig(store: ProjectStore, config: Config): string | undefined {
    return ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.mts'].map(f => inTestRoot(config, f)).find(f => store.exists(f));
}

/** Adds devDependencies and scripts to the test folder's package.json, keeping everything already there. */
export function planPackageAdditions(store: ProjectStore, config: Config, devDependencies: Record<string, string>, scripts: Record<string, string> = {}): PlannedFile {
    const pack: PackManifest = { id: 'capability', title: 'capability', appTypes: [], patterns: [], devDependencies, scripts, install: [], files: [] };
    return planPackageJson(store, config, pack);
}

/** Adds missing keys to .env.example in the same shape write_env_template uses; never removes a line. */
export function planEnvExample(store: ProjectStore, keys: EnvKey[]): PlannedFile {
    const current = store.read(ENV_EXAMPLE_FILE);
    const existing = current ?? '# Copy this file to .env and fill in the values. Never commit .env.\n';
    const present = parseDotenv(existing);
    const blocks: string[] = [];
    const added: string[] = [];
    for (const key of keys) {
        if (present.has(key.name) || new RegExp(`^\\s*#?\\s*${key.name}=`, 'm').test(existing)) continue;
        blocks.push(`# ${key.description}${key.required ? '' : ' (optional)'}\n# Where to get it: ${key.whereToGet}\n${key.name}=`);
        added.push(key.name);
    }
    if (!blocks.length) return { path: ENV_EXAMPLE_FILE, status: 'unchanged', content: existing };
    const content = `${existing.replace(/\s*$/, '\n')}\n${blocks.join('\n\n')}\n`;
    return current === undefined ? { path: ENV_EXAMPLE_FILE, status: 'new', content } : { path: ENV_EXAMPLE_FILE, status: 'merge', content, note: `Adds the key names ${added.join(', ')} (values go in .env).` };
}

/** Relative module path from one repo file to another, for import statements. */
export function relativeModule(fromFile: string, toFile: string, keepExtension: boolean): string {
    const from = fromFile.split('/').slice(0, -1);
    const to = toFile.split('/');
    while (from.length && to.length > 1 && from[0] === to[0]) {
        from.shift();
        to.shift();
    }
    const rel = [...from.map(() => '..'), ...to].join('/');
    const out = rel.startsWith('.') ? rel : `./${rel}`;
    return keepExtension ? out : out.replace(/\.(ts|js)$/, '');
}

/**
 * A short line diff (LCS) of two texts for previews: "+ " added, "- " removed,
 * with two lines of context around each change.
 */
export function lineDiff(before: string, after: string, context = 2): string {
    const a = before.split('\n');
    const b = after.split('\n');
    const n = a.length;
    const m = b.length;
    if (n * m > 4_000_000) return `(file too large to diff: ${n} → ${m} lines)`;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const ops: Array<{ kind: ' ' | '+' | '-'; line: string }> = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            ops.push({ kind: ' ', line: a[i] });
            i++;
            j++;
        } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
            ops.push({ kind: '-', line: a[i++] });
        } else {
            ops.push({ kind: '+', line: b[j++] });
        }
    }
    const keep = new Set<number>();
    ops.forEach((op, k) => {
        if (op.kind !== ' ') for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) keep.add(c);
    });
    const out: string[] = [];
    let last = -1;
    for (const k of [...keep].sort((x, y) => x - y)) {
        if (last !== -1 && k > last + 1) out.push('  …');
        out.push(`${ops[k].kind} ${ops[k].line}`);
        last = k;
    }
    return out.join('\n');
}

/** Fetches a text file over http(s) with a timeout and a size cap. */
export async function fetchText(url: string, doFetch: typeof fetch = fetch, timeoutMs = 15_000, maxBytes = 5_000_000): Promise<string> {
    let res: Response;
    try {
        res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' } });
    } catch (error) {
        const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? `no answer within ${timeoutMs / 1000} s` : error instanceof Error ? error.message : String(error);
        throw new Error(`Could not download ${url}: ${reason}.`);
    }
    if (!res.ok) throw new Error(`Could not download ${url}: the server answered ${res.status}.`);
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`${url} is larger than ${Math.round(maxBytes / 1_000_000)} MB, which is too big to read.`);
    return text;
}

/** Recursively lists files under a folder (POSIX paths), skipping node_modules and hidden folders. */
export function walk(store: ProjectStore, dir: string, accept: (file: string) => boolean, limit = 3000): string[] {
    const out: string[] = [];
    const stack = [dir];
    while (stack.length && out.length < limit) {
        const current = stack.pop()!;
        for (const entry of store.list(current)) {
            const name = entry.split('/').pop()!;
            if (name === 'node_modules' || name.startsWith('.')) continue;
            let stats;
            try {
                stats = statSync(store.resolve(entry));
            } catch {
                continue;
            }
            if (stats.isDirectory()) stack.push(entry);
            else if (stats.isFile() && accept(entry)) out.push(entry);
        }
    }
    return out.sort();
}
