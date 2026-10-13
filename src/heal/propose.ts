import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { isLikelyProduction } from '../core/app-target.js';
import { resolveBaseUrl } from '../core/env.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { readExploration } from '../explore/web.js';
import type { RunSummary, TestOutcome } from '../run/playwright.js';
import { inTestRoot } from '../scaffold/engine.js';
import {
    type Candidate,
    extractFailedLocator,
    findLocatorCalls,
    type PageElement,
    pageElements,
    type ParsedLocator,
    printLocator,
    quoteWith,
    rankCandidates,
    renderLocator,
    sameLocator,
    snapshotFromErrorContext
} from './locators.js';
import { healRuntime, PROPOSALS_FILE } from './runtime.js';

export interface HealEdit {
    /** Repository-relative file. */
    file: string;
    /** First and last line (1-based) of the changed block. */
    line: number;
    endLine: number;
    old: string;
    new: string;
}

export interface HealProposal {
    id: string;
    /** The failed tests this change should fix (one renamed button can break several tests). */
    tests: Array<{ id: string; title: string; file: string; project?: string }>;
    category?: string;
    oldLocator: string;
    newLocator: string;
    confidence: number;
    reason: string;
    /** Where TestPilot saw the page: the error-context Playwright saved at failure time, an earlier exploration, or a fresh visit. */
    pageSource: 'error-context' | 'exploration' | 'live page';
    edits: HealEdit[];
    diff: string;
    status: 'proposed' | 'healed' | 'reverted' | 'stale';
    createdAt: string;
}

export interface HealSkip {
    testId: string;
    title: string;
    reason: string;
}

export interface ProposalsFile {
    createdAt: string;
    run: string;
    proposals: HealProposal[];
    skipped: HealSkip[];
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'blob-report', '.testpilot', 'dist', 'build', 'coverage', 'allure-results', 'allure-report', 'target', '.venv', 'out']);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** Source files under the test root where locators can be written (page objects, specs, fixtures). */
export function listSourceFiles(store: ProjectStore, testRoot: string, ext = SOURCE_EXT): string[] {
    const out: string[] = [];
    const walk = (rel: string, depth: number) => {
        if (depth > 8 || out.length > 3000) return;
        let names: string[];
        try {
            names = readdirSync(store.resolve(rel || '.'));
        } catch {
            return;
        }
        for (const name of names.sort()) {
            const child = rel ? `${rel}/${name}` : name;
            let st;
            try {
                st = statSync(store.resolve(child));
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(child, depth + 1);
            } else if (ext.test(name) && st.size < 1_000_000) out.push(child);
        }
    };
    walk(testRoot === '.' ? '' : testRoot, 0);
    return out;
}

interface Occurrence {
    file: string;
    start: number;
    end: number;
    call: ReturnType<typeof findLocatorCalls>[number]['call'];
}

/** Where a locator is written in the project's source, matched by meaning (quotes and spacing may differ). */
export function findOccurrences(store: ProjectStore, files: string[], locator: ParsedLocator): Occurrence[] {
    const out: Occurrence[] = [];
    for (const file of files) {
        const text = store.read(file) ?? '';
        if (!text.includes(locator.method)) continue;
        for (const { call, locator: l } of findLocatorCalls(text)) if (sameLocator(l, locator)) out.push({ file, start: call.start, end: call.end, call });
    }
    return out;
}

/** The text of a locator call rewritten to the candidate, keeping the original quote style and other options. */
export function rewriteCall(source: string, occ: Occurrence, failed: ParsedLocator, next: Candidate['locator']): string {
    const call = occ.call;
    const original = source.slice(call.start, call.end);
    const first = call.args[0];
    const q = first?.type === 'string' ? first.quote : "'";
    const replace = (text: string, from: number, to: number, value: string) => text.slice(0, from - call.start) + value + text.slice(to - call.start);
    if (next.kind === failed.kind && failed.kind === 'role') {
        const opts = call.args[1];
        const name = opts?.type === 'object' ? opts.props.name : undefined;
        if (name && (name.type === 'string' || name.type === 'regex')) {
            let text = replace(original, name.start, name.end, quoteWith(next.value, name.type === 'string' ? name.quote : q));
            if (next.role !== failed.role && first?.type === 'string') text = replace(text, first.start, first.end, quoteWith(next.role ?? 'button', first.quote));
            return text;
        }
    } else if (next.kind === failed.kind && first && (first.type === 'string' || first.type === 'regex')) {
        return replace(original, first.start, first.end, quoteWith(next.value, first.type === 'string' ? first.quote : q));
    }
    return renderLocator(next, q);
}

/** Line-based edits between two versions of a file. */
export function lineEdits(file: string, before: string, after: string): HealEdit[] {
    const a = before.split('\n');
    const b = after.split('\n');
    if (a.length === b.length) {
        return a.flatMap((line, i) => (line === b[i] ? [] : [{ file, line: i + 1, endLine: i + 1, old: line, new: b[i] }]));
    }
    let top = 0;
    while (top < a.length && top < b.length && a[top] === b[top]) top++;
    let bottom = 0;
    while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++;
    return [{ file, line: top + 1, endLine: a.length - bottom, old: a.slice(top, a.length - bottom).join('\n'), new: b.slice(top, b.length - bottom).join('\n') }];
}

export function renderDiff(edits: HealEdit[]): string {
    const out: string[] = [];
    let current = '';
    for (const e of edits) {
        if (e.file !== current) {
            out.push(`--- a/${e.file}`, `+++ b/${e.file}`);
            current = e.file;
        }
        const oldLines = e.old.split('\n');
        const newLines = e.new.split('\n');
        out.push(`@@ -${e.line},${oldLines.length} +${e.line},${newLines.length} @@`, ...oldLines.map(l => `-${l}`), ...newLines.map(l => `+${l}`));
    }
    return out.join('\n');
}

export interface ProposeOptions {
    /** Open the page with the project's Playwright when no saved page state exists. */
    reopenPage: boolean;
}

interface PageState {
    elements: PageElement[];
    testIds: string[];
    source: HealProposal['pageSource'];
}

function pageFromErrorContext(store: ProjectStore, t: TestOutcome): PageState | undefined {
    const ctx = t.attachments.find(a => a.name === 'error-context');
    const md = ctx ? safeRead(store, ctx.path) : undefined;
    const snapshot = md ? snapshotFromErrorContext(md) : undefined;
    return snapshot ? { elements: pageElements(snapshot), testIds: [], source: 'error-context' } : undefined;
}

function safeRead(store: ProjectStore, rel: string): string | undefined {
    try {
        return store.read(rel);
    } catch {
        return undefined;
    }
}

/** The path a page object opens, e.g. `readonly path = '/login'`. */
function pagePathIn(store: ProjectStore, files: string[]): string | undefined {
    for (const f of files) {
        const m = (store.read(f) ?? '').match(/\bpath\s*=\s*['"`](\/[^'"`]*)['"`]/);
        if (m) return m[1];
    }
    return undefined;
}

function pageFromExploration(store: ProjectStore, pagePath?: string): PageState | undefined {
    const pages = readExploration(store).filter(p => !p.error);
    if (!pages.length) return undefined;
    const chosen = pagePath ? pages.filter(p => p.path === pagePath) : [];
    const use = chosen.length ? chosen : pages;
    return {
        elements: use.flatMap(p => p.elements.map(e => ({ role: e.role, name: e.name, count: e.count }))),
        testIds: use.flatMap(p => p.testIds.map(t => t.value)),
        source: 'exploration'
    };
}

/** Builds heal proposals for the locator failures of a run. Nothing is written except proposals.json. */
export async function proposeHeals(store: ProjectStore, config: Config, run: RunSummary, options: ProposeOptions): Promise<ProposalsFile> {
    const testRoot = inTestRoot(config, '.') || '.';
    const files = listSourceFiles(store, testRoot);
    const proposals: HealProposal[] = [];
    const skipped: HealSkip[] = [];
    const now = new Date().toISOString();
    const liveCache = new Map<string, PageState | undefined>();
    const seen = new Set<string>();

    for (const t of run.tests.filter(x => x.status === 'failed' || x.status === 'flaky')) {
        const key = `${t.id}|${t.file}|${t.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const skip = (reason: string) => skipped.push({ testId: t.id, title: t.title, reason });
        const error = t.error ?? '';
        if (t.category === 'assertion') {
            skip('This is an assertion failure: the app showed something different from what the test expects. That may be a real bug, so TestPilot does not change the test. Open the trace and decide with the team.');
            continue;
        }
        const failed = extractFailedLocator(error);
        if (!failed || !['locator', 'timing', 'unknown'].includes(t.category ?? 'unknown')) {
            skip(failed ? `The failure looks like ${t.category} trouble, not a broken locator, so there is nothing to heal. ${t.advice ?? ''}`.trim() : 'The error does not name a locator the test was waiting for, so there is nothing to heal automatically.');
            continue;
        }
        if (failed.strict) {
            skip(`${printLocator(failed.locator)} matched more than one element. Renaming will not help: make it more specific (scope it inside its section, or use filter({ hasText })).`);
            continue;
        }
        const occurrences = findOccurrences(store, files, failed.locator);
        if (!occurrences.length) {
            skip(`Could not find ${printLocator(failed.locator)} written in the test code (it may be built from a variable). Search the page objects for it and fix it by hand.`);
            continue;
        }

        let page = pageFromErrorContext(store, t);
        const pagePath = pagePathIn(store, [...new Set(occurrences.map(o => o.file))]);
        page ??= pageFromExploration(store, pagePath);
        if (!page && options.reopenPage) {
            const base = resolveBaseUrl(store, config);
            if (base && !isLikelyProduction(base)) {
                const url = new URL(pagePath ?? '/', base).href;
                if (!liveCache.has(url)) {
                    const live = await healRuntime.snapshot(store, store.resolve(testRoot), url).catch(() => ({ fatal: 'failed' }) as { fatal: string; snapshot?: string; testIds?: string[] });
                    liveCache.set(url, live.snapshot ? { elements: pageElements(live.snapshot), testIds: live.testIds ?? [], source: 'live page' } : undefined);
                }
                page = liveCache.get(url);
            }
        }
        if (!page) {
            skip('There is no record of what the page showed when the test failed (no error-context from Playwright and no exploration). Run explore_app, or re-run the test so Playwright saves the page state, then propose again.');
            continue;
        }

        const ranked = rankCandidates(failed.locator, page.elements, page.testIds);
        if (ranked.present) {
            skip(`${printLocator(failed.locator)} is on the page, so the locator is not what broke. The element was probably hidden, disabled, covered or slow to appear: check the trace.`);
            continue;
        }
        if (!ranked.candidates.length) {
            skip(`Nothing on the page looks like ${printLocator(failed.locator)}. The test may have been on the wrong page, or an earlier step did not work. Open the trace (heal_tests action "explain").`);
            continue;
        }
        for (const c of ranked.candidates) {
            const edits: HealEdit[] = [];
            const byFile = new Map<string, Occurrence[]>();
            for (const o of occurrences) byFile.set(o.file, [...(byFile.get(o.file) ?? []), o]);
            for (const [file, occs] of byFile) {
                const before = store.read(file) ?? '';
                let after = before;
                for (const o of [...occs].sort((x, y) => y.start - x.start)) after = after.slice(0, o.start) + rewriteCall(before, o, failed.locator, c.locator) + after.slice(o.end);
                edits.push(...lineEdits(file, before, after));
            }
            const newLocator = renderLocator(c.locator);
            const id = `heal-${createHash('sha1').update(`${printLocator(failed.locator)}|${newLocator}`).digest('hex').slice(0, 8)}`;
            const test = { id: t.id, title: t.title, file: t.file, project: t.project };
            const same = proposals.find(p => p.id === id);
            if (same) {
                if (!same.tests.some(x => x.id === t.id && x.project === t.project)) same.tests.push(test);
                continue;
            }
            proposals.push({
                id,
                tests: [test],
                category: t.category,
                oldLocator: printLocator(failed.locator),
                newLocator,
                confidence: c.confidence,
                reason: c.reason,
                pageSource: page.source,
                edits,
                diff: renderDiff(edits),
                status: 'proposed',
                createdAt: now
            });
        }
    }
    const file: ProposalsFile = { createdAt: now, run: run.startedAt, proposals, skipped };
    store.write(PROPOSALS_FILE, JSON.stringify(file, null, 2) + '\n');
    return file;
}

export function readProposals(store: ProjectStore): ProposalsFile | undefined {
    const raw = store.read(PROPOSALS_FILE);
    if (!raw) return undefined;
    try {
        return JSON.parse(raw) as ProposalsFile;
    } catch {
        return undefined;
    }
}

/** True when every edit still matches the file, so it can be applied safely. */
export function editsApply(store: ProjectStore, edits: HealEdit[], side: 'old' | 'new' = 'old'): boolean {
    return edits.every(e => {
        const lines = (store.read(e.file) ?? '').split('\n');
        return lines.slice(e.line - 1, e.line - 1 + e[side].split('\n').length).join('\n') === e[side];
    });
}

/** Applies (or, with reverse, undoes) edits. Edits of one file are applied bottom-up so line numbers stay valid. */
export function patchFiles(store: ProjectStore, edits: HealEdit[], reverse = false): string[] {
    const byFile = new Map<string, HealEdit[]>();
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    for (const [file, list] of byFile) {
        const lines = (store.read(file) ?? '').split('\n');
        for (const e of [...list].sort((a, b) => b.line - a.line)) {
            const from = reverse ? e.new : e.old;
            const to = reverse ? e.old : e.new;
            lines.splice(e.line - 1, from.split('\n').length, ...to.split('\n'));
        }
        store.write(file, lines.join('\n'));
    }
    return [...byFile.keys()];
}

/** The spec file of a test relative to the test root, for re-running just that file. */
export function specRelativeToTestRoot(config: Config, file: string): string {
    const root = inTestRoot(config, '.') || '.';
    return root === '.' ? file : path.posix.relative(root, file);
}
