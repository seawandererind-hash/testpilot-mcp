import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { TestCase } from '../core/schema.js';
import { type ProjectStore, RUNS_DIR } from '../core/store.js';
import type { RunSummary } from '../run/playwright.js';
import { type CoverageData, esc, INSIGHTS_CSS } from './coverage.js';

/**
 * metrics.json: one small, shareable file per repository that a team dashboard
 * can combine. It holds counts and rates only, never test content or secrets.
 */

export const METRICS_SCHEMA = 'testpilot-metrics/1';
export const METRICS_FILE = '.testpilot/reports/metrics.json';
const DAY = 86_400_000;

export interface Metrics {
    schema: string;
    project: string;
    team?: string;
    generatedAt: string;
    cases: { total: number; automated: number; manual: number; rework: number; notAutomated: number; pctAutomated: number };
    requirements?: { source: string; total: number; withTests: number; automated: number; passing: number; pctWithTests: number; pctAutomated: number; pctPassing: number };
    latestRun?: { at: string; total: number; passed: number; failed: number; flaky: number; skipped: number; passRate: number };
    flaky: { ratePct: number; flakyTests: number; testsSeen: number; runsConsidered: number };
    runsLast30Days: number;
    runsTotal: number;
    history: Array<{ at: string; passRate: number; total: number }>;
    manualHoursSaved: { estimate: true; last30Days: number; allTime: number; automatedCases: number; minutesPerCase: number; note: string };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function passRateOf(run: Pick<RunSummary, 'stats'>): number {
    const counted = run.stats.total - run.stats.skipped;
    return pct(run.stats.passed, counted);
}

/** Saved runs (.testpilot/runs/YYYYMMDD-HHMMSS.json), oldest first. latest.json is a copy and is skipped. */
export function readSavedRuns(store: ProjectStore): RunSummary[] {
    return store
        .list(RUNS_DIR, n => /^\d{8}-\d{6}\.json$/.test(n))
        .map(file => {
            try {
                const r = JSON.parse(store.read(file)!) as RunSummary;
                return r && r.stats && Array.isArray(r.tests) ? r : undefined;
            } catch {
                return undefined;
            }
        })
        .filter((r): r is RunSummary => Boolean(r))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** A test is flaky when a run marked it flaky, or when it both passed and failed across saved runs. */
export function flakyAcrossRuns(runs: RunSummary[]): Metrics['flaky'] {
    const seen = new Map<string, { pass: boolean; fail: boolean; flaky: boolean }>();
    for (const run of runs) {
        for (const t of run.tests) {
            if (t.status === 'skipped') continue;
            const key = `${t.id}|${t.project ?? ''}`;
            const s = seen.get(key) ?? { pass: false, fail: false, flaky: false };
            if (t.status === 'passed') s.pass = true;
            if (t.status === 'failed') s.fail = true;
            if (t.status === 'flaky') s.flaky = true;
            seen.set(key, s);
        }
    }
    const flakyTests = [...seen.values()].filter(s => s.flaky || (s.pass && s.fail)).length;
    return { ratePct: pct(flakyTests, seen.size), flakyTests, testsSeen: seen.size, runsConsidered: runs.length };
}

export function buildMetrics(input: { project: string; team?: string; cases: TestCase[]; runs: RunSummary[]; latest?: RunSummary; coverage?: CoverageData; minutesPerCase: number; now?: Date }): Metrics {
    const now = input.now ?? new Date();
    const { cases, coverage } = input;
    const runs = input.runs.length ? input.runs : input.latest ? [input.latest] : [];
    const latest = input.latest ?? runs[runs.length - 1];
    const status = (s: string) => cases.filter(tc => tc.automation?.status === s).length;
    const automated = status('generated') + status('passing') + status('failing');
    const manual = cases.filter(tc => tc.automation?.status === 'manual' || (!tc.automation?.status && tc.review?.verdict === 'MANUAL')).length;
    const rework = cases.filter(tc => tc.review?.verdict === 'NEEDS-REWORK').length;
    const recent = runs.filter(r => now.getTime() - Date.parse(r.startedAt) <= 30 * DAY);
    const hours = (n: number) => round1((automated * n * input.minutesPerCase) / 60);
    return {
        schema: METRICS_SCHEMA,
        project: input.project,
        ...(input.team ? { team: input.team } : {}),
        generatedAt: now.toISOString(),
        cases: { total: cases.length, automated, manual, rework, notAutomated: Math.max(0, cases.length - automated - manual), pctAutomated: pct(automated, cases.length) },
        ...(coverage
            ? {
                  requirements: {
                      source: coverage.inferred ? 'inferred from test-case areas' : coverage.source,
                      total: coverage.totals.requirements,
                      withTests: coverage.totals.withTests,
                      automated: coverage.totals.automated,
                      passing: coverage.totals.passing,
                      pctWithTests: coverage.totals.pctWithTests,
                      pctAutomated: coverage.totals.pctAutomated,
                      pctPassing: coverage.totals.pctPassing
                  }
              }
            : {}),
        ...(latest
            ? { latestRun: { at: latest.startedAt, total: latest.stats.total, passed: latest.stats.passed, failed: latest.stats.failed, flaky: latest.stats.flaky, skipped: latest.stats.skipped, passRate: passRateOf(latest) } }
            : {}),
        flaky: flakyAcrossRuns(runs),
        runsLast30Days: recent.length,
        runsTotal: runs.length,
        history: runs.slice(-30).map(r => ({ at: r.startedAt, passRate: passRateOf(r), total: r.stats.total })),
        manualHoursSaved: {
            estimate: true,
            last30Days: hours(recent.length),
            allTime: hours(runs.length),
            automatedCases: automated,
            minutesPerCase: input.minutesPerCase,
            note: `Estimate only: automated cases x test runs x ${input.minutesPerCase} minutes a person would need to run one case by hand.`
        }
    };
}

// ---- team dashboard -------------------------------------------------------------

export interface DashboardEntry {
    /** Where it was read from, for the reader. */
    from: string;
    metrics: Metrics;
}

export interface DashboardInput {
    entries: DashboardEntry[];
    skipped: Array<{ path: string; reason: string }>;
}

const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES = 300;

/** True when parsed JSON looks like a TestPilot metrics.json. */
export function isMetrics(value: unknown): value is Metrics {
    const v = value as Partial<Metrics> | null;
    return Boolean(v && typeof v === 'object' && typeof v.project === 'string' && v.cases && typeof v.cases.total === 'number' && typeof v.generatedAt === 'string');
}

/** Copies only the known fields, as plain numbers and short strings, so odd files cannot inject anything. */
function sanitise(m: Metrics): Metrics {
    const s = (v: unknown, max = 120) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
        schema: s(m.schema, 40),
        project: s(m.project) || 'unnamed',
        ...(m.team ? { team: s(m.team) } : {}),
        generatedAt: s(m.generatedAt, 40),
        cases: { total: n(m.cases.total), automated: n(m.cases.automated), manual: n(m.cases.manual), rework: n(m.cases.rework), notAutomated: n(m.cases.notAutomated), pctAutomated: n(m.cases.pctAutomated) },
        ...(m.requirements
            ? { requirements: { source: s(m.requirements.source, 60), total: n(m.requirements.total), withTests: n(m.requirements.withTests), automated: n(m.requirements.automated), passing: n(m.requirements.passing), pctWithTests: n(m.requirements.pctWithTests), pctAutomated: n(m.requirements.pctAutomated), pctPassing: n(m.requirements.pctPassing) } }
            : {}),
        ...(m.latestRun ? { latestRun: { at: s(m.latestRun.at, 40), total: n(m.latestRun.total), passed: n(m.latestRun.passed), failed: n(m.latestRun.failed), flaky: n(m.latestRun.flaky), skipped: n(m.latestRun.skipped), passRate: n(m.latestRun.passRate) } } : {}),
        flaky: { ratePct: n(m.flaky?.ratePct), flakyTests: n(m.flaky?.flakyTests), testsSeen: n(m.flaky?.testsSeen), runsConsidered: n(m.flaky?.runsConsidered) },
        runsLast30Days: n(m.runsLast30Days),
        runsTotal: n(m.runsTotal),
        history: (Array.isArray(m.history) ? m.history : []).slice(-60).map(h => ({ at: s(h?.at, 40), passRate: n(h?.passRate), total: n(h?.total) })),
        manualHoursSaved: {
            estimate: true,
            last30Days: n(m.manualHoursSaved?.last30Days),
            allTime: n(m.manualHoursSaved?.allTime),
            automatedCases: n(m.manualHoursSaved?.automatedCases),
            minutesPerCase: n(m.manualHoursSaved?.minutesPerCase),
            note: s(m.manualHoursSaved?.note, 300)
        }
    };
}

/**
 * Finds metrics files under the given paths: a metrics.json file, a repository
 * root (its .testpilot/reports/metrics.json), or a folder where CI drops one
 * file per team (*.json, or <team>/metrics.json). `resolve` decides which paths
 * may be read (local mode allows explicit paths outside the project).
 */
export function collectDashboardSources(sources: string[], resolve: (p: string) => string): DashboardInput {
    const entries: DashboardEntry[] = [];
    const skipped: DashboardInput['skipped'] = [];
    const visited = new Set<string>();
    const readOne = (file: string, label: string) => {
        if (entries.length + skipped.length >= MAX_FILES) return;
        let real: string;
        try {
            real = realpathSync(file);
        } catch {
            skipped.push({ path: label, reason: 'not found' });
            return;
        }
        if (visited.has(real)) return;
        visited.add(real);
        try {
            if (statSync(real).size > MAX_FILE_BYTES) return void skipped.push({ path: label, reason: 'larger than 2 MB' });
            const parsed = JSON.parse(readFileSync(real, 'utf8')) as unknown;
            if (!isMetrics(parsed)) return void skipped.push({ path: label, reason: 'not a TestPilot metrics.json' });
            entries.push({ from: label, metrics: sanitise(parsed) });
        } catch {
            skipped.push({ path: label, reason: 'not valid JSON' });
        }
    };
    for (const source of sources) {
        let abs: string;
        try {
            abs = resolve(source);
        } catch (error) {
            skipped.push({ path: source, reason: (error as Error).message });
            continue;
        }
        if (!existsSync(abs)) {
            skipped.push({ path: source, reason: 'not found' });
            continue;
        }
        if (statSync(abs).isFile()) {
            readOne(abs, source);
            continue;
        }
        const repoMetrics = path.join(abs, METRICS_FILE);
        if (existsSync(repoMetrics)) {
            readOne(repoMetrics, path.join(source, METRICS_FILE));
            continue;
        }
        const names = readdirSync(abs).sort();
        let found = 0;
        for (const name of names) {
            const full = path.join(abs, name);
            const label = path.join(source, name);
            let st;
            try {
                st = statSync(full);
            } catch {
                continue;
            }
            if (st.isFile() && name.endsWith('.json')) {
                readOne(full, label);
                found++;
            } else if (st.isDirectory() && !name.startsWith('.') && name !== 'node_modules') {
                for (const candidate of [path.join(full, 'metrics.json'), path.join(full, METRICS_FILE)]) {
                    if (existsSync(candidate)) {
                        readOne(candidate, path.join(label, path.relative(full, candidate)));
                        found++;
                    }
                }
            }
        }
        if (!found) skipped.push({ path: source, reason: 'no metrics.json files in this folder' });
    }
    return { entries, skipped };
}

export interface TeamRow {
    key: string;
    team: string;
    project: string;
    latest: Metrics;
    from: string;
    /** Pass rate over time: run history of the latest file, or one point per snapshot when several files exist. */
    trend: Array<{ at: string; value: number }>;
    automationTrend: Array<{ at: string; value: number }>;
}

export interface DashboardData {
    generatedAt: string;
    teams: TeamRow[];
    totals: { teams: number; cases: number; automated: number; pctAutomated: number; avgPassRate?: number; runsLast30Days: number; hoursSaved30: number; hoursSavedAll: number; flakyTests: number };
    skipped: DashboardInput['skipped'];
}

export function buildDashboard(input: DashboardInput): DashboardData {
    const groups = new Map<string, DashboardEntry[]>();
    for (const e of input.entries) {
        const key = `${e.metrics.team ?? ''}|${e.metrics.project}`;
        groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const teams: TeamRow[] = [...groups.entries()].map(([key, list]) => {
        const sorted = [...list].sort((a, b) => a.metrics.generatedAt.localeCompare(b.metrics.generatedAt));
        const last = sorted[sorted.length - 1];
        const snapshots = sorted.filter(e => e.metrics.latestRun).map(e => ({ at: e.metrics.latestRun!.at, value: e.metrics.latestRun!.passRate }));
        const runTrend = last.metrics.history.map(h => ({ at: h.at, value: h.passRate }));
        const merged = new Map<string, number>();
        for (const p of [...snapshots, ...runTrend]) merged.set(p.at, p.value);
        return {
            key,
            team: last.metrics.team ?? last.metrics.project,
            project: last.metrics.project,
            latest: last.metrics,
            from: last.from,
            trend: [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([at, value]) => ({ at, value })),
            automationTrend: sorted.map(e => ({ at: e.metrics.generatedAt, value: e.metrics.cases.pctAutomated }))
        };
    });
    teams.sort((a, b) => a.team.localeCompare(b.team) || a.project.localeCompare(b.project));
    const sum = (f: (m: Metrics) => number) => teams.reduce((n, t) => n + f(t.latest), 0);
    const withRuns = teams.filter(t => t.latest.latestRun);
    const cases = sum(m => m.cases.total);
    const automated = sum(m => m.cases.automated);
    return {
        generatedAt: new Date().toISOString(),
        teams,
        totals: {
            teams: teams.length,
            cases,
            automated,
            pctAutomated: pct(automated, cases),
            avgPassRate: withRuns.length ? Math.round(withRuns.reduce((n, t) => n + t.latest.latestRun!.passRate, 0) / withRuns.length) : undefined,
            runsLast30Days: sum(m => m.runsLast30Days),
            hoursSaved30: round1(sum(m => m.manualHoursSaved.last30Days)),
            hoursSavedAll: round1(sum(m => m.manualHoursSaved.allTime)),
            flakyTests: sum(m => m.flaky.flakyTests)
        },
        skipped: input.skipped
    };
}

/** A small inline SVG line chart (0-100%) with a dot and a title on every point for hover. */
function sparkline(points: Array<{ at: string; value: number }>, label: string, width = 160, height = 40): string {
    if (points.length < 2) return '<span class="muted">not enough history</span>';
    const pad = 4;
    const x = (i: number) => pad + (i * (width - pad * 2)) / (points.length - 1);
    const y = (v: number) => pad + (1 - Math.max(0, Math.min(100, v)) / 100) * (height - pad * 2);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${i === points.length - 1 ? 3 : 2}"><title>${esc(p.at.slice(0, 16).replace('T', ' '))}: ${p.value}%</title></circle>`).join('');
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}"><line x1="0" x2="${width}" y1="${y(100)}" y2="${y(100)}" class="grid"/><line x1="0" x2="${width}" y1="${y(50)}" y2="${y(50)}" class="grid"/><path d="${d}"/>${dots}</svg>`;
}

export function renderDashboardHtml(d: DashboardData): string {
    const t = d.totals;
    const card = (label: string, value: string | number) => `<div class="card"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`;
    const rate = (v: number | undefined) => (v === undefined ? '<span class="muted">-</span>' : `${v}%`);
    const rows = d.teams
        .map(row => {
            const m = row.latest;
            return `<tr><td data-label="Team / repo"><strong>${esc(row.team)}</strong>${row.team !== row.project ? `<div class="muted">${esc(row.project)}</div>` : ''}<div class="muted small">${esc(row.from)}</div></td><td data-label="Test cases">${m.cases.total}</td><td data-label="Automated"><span>${m.cases.automated} <span class="muted">(${m.cases.pctAutomated}%)</span></span></td><td data-label="Manual">${m.cases.manual}</td><td data-label="Requirements with tests"><span>${m.requirements ? `${m.requirements.pctWithTests}%${/inferred/.test(m.requirements.source) ? ' <span class="muted">(areas)</span>' : ''}` : '<span class="muted">-</span>'}</span></td><td data-label="Pass rate">${rate(m.latestRun?.passRate)}</td><td data-label="Flaky">${m.flaky.testsSeen ? `${m.flaky.ratePct}%` : '<span class="muted">-</span>'}</td><td data-label="Runs (30 days)">${m.runsLast30Days}</td><td data-label="Hours saved (30 days, est.)">${m.manualHoursSaved.last30Days}</td><td data-label="Updated" class="nowrap">${esc(m.generatedAt.slice(0, 10))}</td><td data-label="Pass-rate trend">${sparkline(row.trend, `${row.team} pass rate trend`)}</td></tr>`;
        })
        .join('');
    const bars = d.teams
        .map(row => `<div class="barrow"><div class="barlabel">${esc(row.team)}</div><div class="bartrack" title="${esc(`${row.team}: ${row.latest.cases.automated} of ${row.latest.cases.total} automated`)}"><span style="width:${row.latest.cases.pctAutomated}%"></span></div><div class="barvalue">${row.latest.cases.pctAutomated}%</div></div>`)
        .join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team test dashboard</title>
<style>${INSIGHTS_CSS}
.small { font-size:12px; overflow-wrap:anywhere; } .nowrap { white-space:nowrap; }
svg.spark { display:block; max-width:100%; } svg.spark path { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; } svg.spark circle { fill:var(--accent); } svg.spark .grid { stroke:var(--line); stroke-width:1; }
.barrow { display:grid; grid-template-columns:minmax(90px, 180px) 1fr 48px; gap:10px; align-items:center; padding:4px 0; }
.barlabel { overflow-wrap:anywhere; font-size:14px; } .barvalue { text-align:right; font-variant-numeric:tabular-nums; }
.bartrack { height:12px; background:var(--line); border-radius:4px; overflow:hidden; } .bartrack span { display:block; height:100%; background:var(--accent); border-radius:0 4px 4px 0; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; }
td { font-variant-numeric: tabular-nums; }
@media (max-width: 700px) {
  table.teams thead { display:none; } table.teams tr { display:block; border-bottom:1px solid var(--line); padding:8px 0; }
  table.teams td { display:flex; justify-content:space-between; gap:12px; border:0; padding:3px 12px; } table.teams td[data-label]::before { content: attr(data-label); color:var(--muted); font-size:13px; }
  table.teams td:first-child { display:block; } table.teams td:first-child::before { content:none; }
}
</style>
</head>
<body>
<main>
<h1>Team test dashboard</h1>
<div class="muted">${t.teams} team(s) or repositories · generated ${esc(d.generatedAt.slice(0, 16).replace('T', ' '))} UTC by TestPilot</div>
<div class="cards">${card('test cases', t.cases)}${card('automated', `${t.pctAutomated}%`)}${card('average pass rate', t.avgPassRate === undefined ? '-' : `${t.avgPassRate}%`)}${card('test runs, last 30 days', t.runsLast30Days)}${card('manual hours saved, 30 days (estimate)', t.hoursSaved30)}${card('flaky tests', t.flakyTests)}</div>
<h2>Teams and repositories</h2>
<div class="table-wrap"><table class="teams"><thead><tr><th>Team / repo</th><th>Test cases</th><th>Automated</th><th>Manual</th><th>Req. with tests</th><th>Pass rate</th><th>Flaky</th><th>Runs (30 d)</th><th>Hours saved (30 d, est.)</th><th>Updated</th><th>Pass-rate trend</th></tr></thead><tbody>${rows || '<tr><td colspan="11" class="muted">No metrics found.</td></tr>'}</tbody></table></div>
<h2>Share of test cases automated</h2>
<div class="panel">${bars || '<span class="muted">No teams yet.</span>'}</div>
${d.skipped.length ? `<h2>Files not used</h2><ul class="gaps">${d.skipped.map(s => `<li><code>${esc(s.path)}</code>: ${esc(s.reason)}</li>`).join('')}</ul>` : ''}
<p class="muted" style="margin-top:28px">Hours saved is an estimate: automated cases x test runs x the minutes one manual run of a case takes (set per repository, default 5). Each repository writes its numbers with the TestPilot insights tool (action "metrics") to .testpilot/reports/metrics.json.</p>
</main>
</body>
</html>
`;
}
