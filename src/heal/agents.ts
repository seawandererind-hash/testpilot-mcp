import { readdirSync, statSync } from 'node:fs';

import type { ProjectStore } from '../core/store.js';

export const AGENTS_MIN_VERSION = '1.56.0';
export const AGENT_LOOPS = ['claude', 'vscode', 'opencode'] as const;

/** The Playwright version installed for the project, read from node_modules. */
export function playwrightVersion(store: ProjectStore, testRoot: string): string | undefined {
    for (const dir of [testRoot, '.']) {
        const raw = store.read(`${dir === '.' ? '' : `${dir}/`}node_modules/@playwright/test/package.json`);
        if (raw) {
            try {
                return (JSON.parse(raw) as { version?: string }).version;
            } catch {
                // fall through
            }
        }
    }
    return undefined;
}

export function versionAtLeast(version: string, min: string): boolean {
    const a = version.split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const b = min.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
}

const SKIP = new Set(['node_modules', '.git', '.testpilot', 'test-results', 'playwright-report', 'blob-report']);

/** Files under a folder with their modification times, to see what a command created or changed. */
export function fileTimes(store: ProjectStore, root: string): Map<string, number> {
    const out = new Map<string, number>();
    const walk = (rel: string, depth: number) => {
        if (depth > 6 || out.size > 5000) return;
        let names: string[] = [];
        try {
            names = readdirSync(store.resolve(rel || '.'));
        } catch {
            return;
        }
        for (const name of names) {
            const child = rel ? `${rel}/${name}` : name;
            try {
                const st = statSync(store.resolve(child));
                if (st.isDirectory()) {
                    if (!SKIP.has(name)) walk(child, depth + 1);
                } else out.set(child, st.mtimeMs);
            } catch {
                // unreadable entries are skipped
            }
        }
    };
    walk(root === '.' ? '' : root, 0);
    return out;
}

export function diffFiles(before: Map<string, number>, after: Map<string, number>): { created: string[]; changed: string[] } {
    const created: string[] = [];
    const changed: string[] = [];
    for (const [file, mtime] of after) {
        const was = before.get(file);
        if (was === undefined) created.push(file);
        else if (was !== mtime) changed.push(file);
    }
    return { created: created.sort(), changed: changed.sort() };
}
