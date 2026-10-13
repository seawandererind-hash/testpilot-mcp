import type { Config } from '../core/schema.js';
import { RUNS_DIR, type ProjectStore, safeFileName } from '../core/store.js';
import type { RunSummary } from '../run/playwright.js';
import { inTestRoot } from '../scaffold/engine.js';
import { listSourceFiles } from './propose.js';
import { QUARANTINE_FILE, TICKETS_DIR } from './runtime.js';

export interface FlakyStat {
    id: string;
    title: string;
    file: string;
    project?: string;
    /** Saved runs the test appeared in (skipped runs excluded). */
    runs: number;
    /** Attempts across those runs (repeats count separately). */
    attempts: number;
    passes: number;
    passRate: number;
    /** Changes between pass and fail, in run order, plus each run that was itself mixed. */
    flips: number;
    lastSeen: string;
    /** Last results, oldest first: P passed, F failed, ~ mixed within the run. */
    recent: string;
    /** 0 (always the same result) to 100 (as unpredictable as it gets). */
    score: number;
    flaky: boolean;
    lastError?: string;
    trace?: string;
    /** When heal_tests last healed this test's locator, if it did. */
    healedAt?: string;
}

/** Every saved run, oldest first (latest.json is a copy of the newest one and is skipped). */
export function readRuns(store: ProjectStore): RunSummary[] {
    const runs: RunSummary[] = [];
    for (const file of store.list(RUNS_DIR, name => name.endsWith('.json') && name !== 'latest.json')) {
        try {
            const run = JSON.parse(store.read(file) ?? '') as RunSummary;
            if (Array.isArray(run.tests)) runs.push(run);
        } catch {
            // A damaged run file is ignored.
        }
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function flakyStats(runs: RunSummary[]): FlakyStat[] {
    const byKey = new Map<string, { stat: FlakyStat; seq: string[] }>();
    for (const run of runs) {
        for (const t of run.tests) {
            if (t.status === 'skipped' || !t.runs) continue;
            const key = `${t.id}|${t.project ?? ''}`;
            let entry = byKey.get(key);
            if (!entry) {
                entry = { stat: { id: t.id, title: t.title, file: t.file, project: t.project, runs: 0, attempts: 0, passes: 0, passRate: 0, flips: 0, lastSeen: run.startedAt, recent: '', score: 0, flaky: false }, seq: [] };
                byKey.set(key, entry);
            }
            const s = entry.stat;
            s.runs++;
            s.attempts += t.runs;
            s.passes += t.passes;
            s.lastSeen = run.startedAt;
            s.title = t.title;
            s.file = t.file;
            if (t.status !== 'passed' && t.error) {
                s.lastError = t.error.split('\n')[0];
                s.trace = t.attachments.find(a => a.name === 'trace')?.path ?? s.trace;
            }
            entry.seq.push(t.status === 'passed' ? 'P' : t.status === 'failed' ? 'F' : '~');
        }
    }
    const out: FlakyStat[] = [];
    for (const { stat, seq } of byKey.values()) {
        let flips = seq.filter(r => r === '~').length;
        let prev: string | undefined;
        for (const r of seq) {
            const v = r === '~' ? undefined : r;
            if (v && prev && v !== prev) flips++;
            if (v) prev = v;
        }
        stat.flips = flips;
        stat.passRate = stat.attempts ? Math.round((stat.passes / stat.attempts) * 100) / 100 : 0;
        stat.recent = seq.slice(-10).join('');
        stat.flaky = stat.passes > 0 && stat.passes < stat.attempts;
        if (stat.flaky) {
            // Balance of passes and failures (1 when half and half) and how often the result changes.
            const balance = 2 * Math.min(stat.passRate, 1 - stat.passRate);
            const churn = Math.min(1, flips / Math.max(1, seq.length - 1));
            stat.score = Math.max(1, Math.round(100 * (0.6 * balance + 0.4 * churn)));
        }
        out.push(stat);
    }
    return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Marks tests whose locator heal_tests healed, so failures from before the heal are not mistaken for flakiness. */
export function markHealed(stats: FlakyStat[], historyJsonl: string | undefined): void {
    for (const line of (historyJsonl ?? '').split('\n')) {
        try {
            const h = JSON.parse(line) as { ts: string; tests?: string[]; result?: string };
            if (h.result !== 'healed') continue;
            for (const s of stats) if (h.tests?.includes(s.id)) s.healedAt = h.ts;
        } catch {
            // blank or damaged line
        }
    }
}

export function renderFlakyReport(stats: FlakyStat[], runCount: number): string {
    const flaky = stats.filter(s => s.flaky);
    const lines = [
        '# Flaky tests',
        '',
        `From ${runCount} saved run(s) in ${RUNS_DIR}. A test is flaky when it both passed and failed: within one run (stabilityRuns), or across runs. Across runs, check whether the app or the test changed in between; that is a fix, not flakiness. Score: 0 is always the same result, 100 is a coin toss.`,
        ''
    ];
    if (!flaky.length) {
        lines.push(runCount < 2 ? 'Not enough history yet. Run the tests a few more times (or once with stabilityRuns: 3) to spot flaky ones.' : 'No flaky tests found. Every test gave the same result each time.');
        return lines.join('\n') + '\n';
    }
    lines.push('| Test | Score | Pass rate | Runs | Flips | Recent (old → new) | Last seen |', '|---|---|---|---|---|---|---|');
    for (const s of flaky) lines.push(`| ${s.title.replace(/\|/g, '\\|')}${s.project ? ` [${s.project}]` : ''}${s.healedAt ? ` (healed ${s.healedAt.slice(0, 10)})` : ''} | ${s.score} | ${Math.round(s.passRate * 100)}% (${s.passes}/${s.attempts}) | ${s.runs} | ${s.flips} | \`${s.recent}\` | ${s.lastSeen.slice(0, 16).replace('T', ' ')} |`);
    lines.push('', 'P passed, F failed, ~ passed and failed within the same run.', '');
    lines.push('What to do: open the trace of a failed attempt (heal_tests action "explain"), look for waits on fixed times, shared test data or order dependence. If a fix will take a while, quarantine the test (heal_tests action "quarantine") so it stops blocking the pipeline, and fix it from the ticket.');
    return lines.join('\n') + '\n';
}

// ---- quarantine -------------------------------------------------------------------

export interface QuarantineEntry {
    id: string;
    title: string;
    file: string;
    reason: string;
    since: string;
    score?: number;
}

export interface QuarantineFile {
    tests: QuarantineEntry[];
}

export function readQuarantine(store: ProjectStore): QuarantineFile {
    try {
        const q = JSON.parse(store.read(QUARANTINE_FILE) ?? '{"tests":[]}') as QuarantineFile;
        return { tests: Array.isArray(q.tests) ? q.tests : [] };
    } catch {
        return { tests: [] };
    }
}

export interface TitleEdit {
    id: string;
    file: string;
    line: number;
    old: string;
    new: string;
    title: string;
}

const TAG = '@quarantine';

function escapeFor(q: string, s: string): string {
    const esc = s.replace(/\\/g, '\\\\');
    return q === '"' ? esc.replace(/"/g, '\\"') : q === '`' ? esc.replace(/`/g, '\\`') : esc.replace(/'/g, "\\'");
}

/**
 * Finds the title of a test in the spec files and returns the edit that adds (or
 * removes) the @quarantine tag. Only a title found exactly once is edited.
 */
export function planTitleEdit(store: ProjectStore, config: Config, id: string, knownTitle: string | undefined, remove: boolean): TitleEdit | { id: string; problem: string } {
    const files = listSourceFiles(store, inTestRoot(config, '.') || '.').filter(f => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(tests?|e2e|specs?)\//.test(f));
    const hits: Array<{ file: string; index: number; literal: string; title: string; quote: string }> = [];
    const titleRe = /\b(?:test|it)(?:\.(?:only|fixme|fail|slow|skip))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (const file of files) {
        const text = store.read(file) ?? '';
        for (let m = titleRe.exec(text); m; m = titleRe.exec(text)) {
            const raw = m[2];
            const title = raw.replace(/\\(.)/g, '$1');
            const wanted = knownTitle ? title === knownTitle || title === `${knownTitle} ${TAG}` || (remove && title.replace(` ${TAG}`, '') === knownTitle.replace(` ${TAG}`, '')) : new RegExp(`(^|[\\s@])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(title);
            if (wanted) hits.push({ file, index: m.index + m[0].length - raw.length - 2, literal: `${m[1]}${raw}${m[1]}`, title, quote: m[1] });
        }
    }
    if (!hits.length) return { id, problem: `Could not find a test titled ${knownTitle ? `"${knownTitle}"` : `with ${id}`} in the spec files.` };
    if (hits.length > 1) return { id, problem: `Found ${hits.length} tests matching ${id} (${[...new Set(hits.map(h => h.file))].join(', ')}). Tag the right one by hand to be safe.` };
    const hit = hits[0];
    const has = hit.title.includes(TAG);
    if (!remove && has) return { id, problem: `${id} is already tagged ${TAG}.` };
    if (remove && !has) return { id, problem: `${id} is not tagged ${TAG}.` };
    const newTitle = remove ? hit.title.replace(new RegExp(`\\s*${TAG}\\b`), '') : `${hit.title} ${TAG}`;
    const text = store.read(hit.file) ?? '';
    const lineStart = text.lastIndexOf('\n', hit.index) + 1;
    const lineEnd = text.indexOf('\n', hit.index) === -1 ? text.length : text.indexOf('\n', hit.index);
    const oldLine = text.slice(lineStart, lineEnd);
    const newLiteral = `${hit.quote}${escapeFor(hit.quote, newTitle)}${hit.quote}`;
    const newLine = oldLine.slice(0, hit.index - lineStart) + newLiteral + oldLine.slice(hit.index - lineStart + hit.literal.length);
    return { id, file: hit.file, line: text.slice(0, hit.index).split('\n').length, old: oldLine, new: newLine, title: hit.title };
}

export function ticketMarkdown(entry: QuarantineEntry, stat: FlakyStat | undefined): string {
    const lines = [
        `# Flaky test: ${entry.title}`,
        '',
        `Quarantined on ${entry.since.slice(0, 10)} by TestPilot. Reason: ${entry.reason}`,
        '',
        '## Steps to reproduce',
        '',
        `1. Open the test in ${entry.file}.`,
        `2. Run it several times: \`npx playwright test --grep "${entry.id}" --repeat-each 10 --retries 0\`.`,
        '3. Compare a passing and a failing attempt in the trace viewer.',
        ''
    ];
    if (stat) {
        lines.push(
            '## Flaky history',
            '',
            `- Score: ${stat.score} of 100`,
            `- Passed ${stat.passes} of ${stat.attempts} attempts (${Math.round(stat.passRate * 100)}%) over ${stat.runs} run(s), ${stat.flips} flip(s)`,
            `- Recent results (old → new): \`${stat.recent}\``,
            `- Last seen: ${stat.lastSeen}`,
            ...(stat.lastError ? [`- Last error: ${stat.lastError}`] : []),
            ...(stat.trace ? [`- Trace: \`npx playwright show-trace ${stat.trace}\``] : []),
            ''
        );
    }
    lines.push('## Done when', '', `The test passes 10 times in a row with --repeat-each 10, and the ${TAG} tag is removed (heal_tests action "unquarantine").`, '');
    return lines.join('\n');
}

export function ticketPath(id: string): string {
    return `${TICKETS_DIR}/${safeFileName(id)}.md`;
}

export const CI_ADVICE = `In CI, run the blocking job with \`npx playwright test --grep-invert ${TAG}\` so quarantined tests cannot fail the build, and add a second, non-blocking job (GitHub Actions: continue-on-error: true; Azure DevOps: continueOnError: true; GitLab: allow_failure: true) that runs \`npx playwright test --grep ${TAG}\` to keep watching them.`;
