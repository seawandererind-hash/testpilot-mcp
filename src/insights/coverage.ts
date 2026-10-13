import type { TestCase } from '../core/schema.js';
import type { RunSummary, TestOutcome } from '../run/playwright.js';
import { areaId, type ExplicitLinks, type Requirement, type RequirementSet } from './requirements.js';

/**
 * The requirement -> test cases -> automated tests -> latest result matrix.
 * Pure functions: the tool reads files and passes them in, so tests need no repo.
 */

/** Where one test case stands, from the latest run first, else its automation status. */
export type CaseState = 'passing' | 'failing' | 'flaky' | 'automated' | 'manual' | 'not-automated';

/** Where one requirement stands. Ordered from worst to best for sorting. */
export type RequirementState = 'missing' | 'failing' | 'covered' | 'automated' | 'passing';

export const REQUIREMENT_STATE_LABEL: Record<RequirementState, string> = {
    missing: 'No tests',
    failing: 'Failing',
    covered: 'Tested by hand only',
    automated: 'Automated, not yet passing',
    passing: 'Automated and passing'
};

export const CASE_STATE_LABEL: Record<CaseState, string> = {
    passing: 'passing',
    failing: 'failing',
    flaky: 'flaky',
    automated: 'automated, no result yet',
    manual: 'manual',
    'not-automated': 'not automated yet'
};

export interface CoverageCase {
    id: string;
    title: string;
    state: CaseState;
    /** Spec files or Playwright tests that automate this case. */
    tests: string[];
    lastResult?: TestOutcome['status'];
}

export interface CoverageRow {
    id: string;
    title: string;
    area: string;
    priority?: string;
    link?: string;
    state: RequirementState;
    cases: CoverageCase[];
}

export interface CoverageData {
    project: string;
    generatedAt: string;
    source: RequirementSet['source'];
    sourceRef: string;
    inferred: boolean;
    run?: { at: string; total: number; passed: number; failed: number; flaky: number };
    rows: CoverageRow[];
    areas: Array<{ area: string; total: number } & Record<RequirementState, number>>;
    /** Test cases that match no requirement. */
    unlinkedCases: Array<{ id: string; title: string; state: CaseState }>;
    totals: {
        requirements: number;
        withTests: number;
        automated: number;
        passing: number;
        failing: number;
        missing: number;
        cases: number;
        linkedCases: number;
        pctWithTests: number;
        pctAutomated: number;
        pctPassing: number;
    };
    warnings: string[];
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `id` appears in text as a whole token (REQ-1 does not match REQ-12). */
export function mentions(text: string, id: string): boolean {
    if (!text || !id) return false;
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`, 'i').test(text);
}

/** Merges the outcomes of one case across browsers/projects into one result. */
function mergedResult(outcomes: TestOutcome[]): TestOutcome['status'] | undefined {
    if (!outcomes.length) return undefined;
    if (outcomes.some(o => o.status === 'failed')) return 'failed';
    if (outcomes.some(o => o.status === 'flaky')) return 'flaky';
    if (outcomes.some(o => o.status === 'passed')) return 'passed';
    return 'skipped';
}

export function caseState(tc: TestCase, result: TestOutcome['status'] | undefined): CaseState {
    if (result === 'passed') return 'passing';
    if (result === 'failed') return 'failing';
    if (result === 'flaky') return 'flaky';
    const status = tc.automation?.status;
    if (status === 'passing' || status === 'failing') return status;
    if (status === 'generated' || result === 'skipped') return 'automated';
    if (status === 'manual' || tc.review?.verdict === 'MANUAL') return 'manual';
    return 'not-automated';
}

const AUTOMATED: CaseState[] = ['passing', 'failing', 'flaky', 'automated'];

export function requirementState(cases: CoverageCase[]): RequirementState {
    if (!cases.length) return 'missing';
    if (cases.some(c => c.state === 'failing' || c.state === 'flaky')) return 'failing';
    if (cases.some(c => c.state === 'passing') && cases.filter(c => AUTOMATED.includes(c.state)).every(c => c.state === 'passing')) return 'passing';
    if (cases.some(c => AUTOMATED.includes(c.state))) return 'automated';
    return 'covered';
}

/** Finds which requirements each case belongs to: explicit links, Jira issue links, then ids mentioned in the case. */
export function linkCases(requirements: Requirement[], cases: TestCase[], explicit: ExplicitLinks, inferred: boolean): Map<string, Set<string>> {
    const byReq = new Map<string, Set<string>>(requirements.map(r => [r.id, new Set<string>()]));
    const reqIds = new Map(requirements.map(r => [r.id.toUpperCase(), r.id]));
    const caseIds = new Map(cases.map(tc => [tc.id.toUpperCase(), tc.id]));
    const add = (reqId: string, caseId: string) => {
        const r = reqIds.get(reqId.toUpperCase());
        const c = caseIds.get(caseId.toUpperCase());
        if (r && c) byReq.get(r)!.add(c);
    };
    for (const [caseId, reqs] of Object.entries(explicit)) for (const r of reqs ?? []) add(r, caseId);
    for (const r of requirements) for (const c of r.linkedCases ?? []) add(r.id, c);
    for (const tc of cases) {
        if (inferred) {
            add(areaId(tc.area?.trim() || 'General'), tc.id);
            continue;
        }
        const haystack = [tc.id, ...tc.tags, tc.title, tc.description ?? '', tc.source.ref ?? '', tc.source.link ?? ''].join('\n');
        for (const r of requirements) if (mentions(haystack, r.id)) add(r.id, tc.id);
    }
    return byReq;
}

export function buildCoverage(input: { project: string; set: RequirementSet; cases: TestCase[]; run?: RunSummary; links: ExplicitLinks }): CoverageData {
    const { set, cases, run, links } = input;
    const inferred = set.source === 'inferred';
    const outcomes = new Map<string, TestOutcome[]>();
    for (const t of run?.tests ?? []) {
        const key = t.id.toUpperCase();
        outcomes.set(key, [...(outcomes.get(key) ?? []), t]);
    }
    const coverageCase = new Map<string, CoverageCase>();
    for (const tc of cases) {
        const results = outcomes.get(tc.id.toUpperCase()) ?? [];
        const lastResult = mergedResult(results);
        const ran = results.map(o => `${o.file}${o.line ? `:${o.line}` : ''}`);
        const spec = tc.automation?.specFile;
        const tests = [...new Set([...(spec && !results.some(o => o.file === spec) ? [spec] : []), ...ran])];
        coverageCase.set(tc.id, { id: tc.id, title: tc.title, state: caseState(tc, lastResult), tests, lastResult });
    }
    const byReq = linkCases(set.requirements, cases, links, inferred);
    const linked = new Set<string>();
    const rows: CoverageRow[] = set.requirements.map(r => {
        const ids = [...(byReq.get(r.id) ?? [])].sort();
        ids.forEach(id => linked.add(id));
        const rowCases = ids.map(id => coverageCase.get(id)!).filter(Boolean);
        return { id: r.id, title: r.title, area: r.area?.trim() || 'General', priority: r.priority, link: r.link, state: requirementState(rowCases), cases: rowCases };
    });
    const areaMap = new Map<string, CoverageData['areas'][number]>();
    for (const row of rows) {
        const a = areaMap.get(row.area) ?? { area: row.area, total: 0, missing: 0, failing: 0, covered: 0, automated: 0, passing: 0 };
        a.total++;
        a[row.state]++;
        areaMap.set(row.area, a);
    }
    const count = (s: RequirementState) => rows.filter(r => r.state === s).length;
    const withTests = rows.length - count('missing');
    const automated = rows.filter(r => r.cases.some(c => AUTOMATED.includes(c.state))).length;
    const warnings = [...set.warnings];
    const unknownLinks = Object.entries(links).flatMap(([caseId, reqs]) => [
        ...(cases.some(tc => tc.id.toUpperCase() === caseId.toUpperCase()) ? [] : [`Link for unknown test case ${caseId} was ignored.`]),
        ...(reqs ?? []).filter(r => !set.requirements.some(q => q.id.toUpperCase() === r.toUpperCase())).map(r => `Link to unknown requirement ${r} (from ${caseId}) was ignored.`)
    ]);
    warnings.push(...unknownLinks.slice(0, 20));
    return {
        project: input.project,
        generatedAt: new Date().toISOString(),
        source: set.source,
        sourceRef: set.ref,
        inferred,
        run: run ? { at: run.startedAt, total: run.stats.total, passed: run.stats.passed, failed: run.stats.failed, flaky: run.stats.flaky } : undefined,
        rows,
        areas: [...areaMap.values()].sort((a, b) => a.area.localeCompare(b.area)),
        unlinkedCases: cases.filter(tc => !linked.has(tc.id)).map(tc => ({ id: tc.id, title: tc.title, state: coverageCase.get(tc.id)!.state })),
        totals: {
            requirements: rows.length,
            withTests,
            automated,
            passing: count('passing'),
            failing: count('failing'),
            missing: count('missing'),
            cases: cases.length,
            linkedCases: linked.size,
            pctWithTests: pct(withTests, rows.length),
            pctAutomated: pct(automated, rows.length),
            pctPassing: pct(count('passing'), rows.length)
        },
        warnings
    };
}

// ---- rendering -----------------------------------------------------------------

export function esc(s: unknown): string {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function md(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const STATE_ORDER: RequirementState[] = ['passing', 'automated', 'covered', 'failing', 'missing'];

export function renderCoverageMarkdown(d: CoverageData): string {
    const t = d.totals;
    const lines = [`# Requirement coverage: ${d.project}`, '', `Generated ${d.generatedAt.slice(0, 16).replace('T', ' ')} UTC by TestPilot. Requirements from ${d.inferred ? 'test-case areas (inferred: no requirements were given)' : `${d.source === 'jira' ? 'Jira' : 'file'} ${d.sourceRef}`}.`, ''];
    if (d.inferred) lines.push('> These "requirements" are the test-case areas, so this shows how tests spread across areas, not true requirement coverage.', '');
    lines.push(
        `- **${t.pctWithTests}%** of ${t.requirements} requirements have at least one test case (${t.withTests}).`,
        `- **${t.pctAutomated}%** have at least one automated test (${t.automated}).`,
        `- **${t.pctPassing}%** are automated and passing in the latest run (${t.passing}).`,
        `- ${t.failing} requirement(s) have a failing or flaky test; ${t.missing} have no tests at all.`,
        ''
    );
    lines.push('## By area', '', '| Area | Requirements | Passing | Automated | Manual only | Failing | No tests |', '|---|---|---|---|---|---|---|');
    for (const a of d.areas) lines.push(`| ${md(a.area)} | ${a.total} | ${a.passing} | ${a.automated} | ${a.covered} | ${a.failing} | ${a.missing} |`);
    lines.push('');
    const gaps = d.rows.filter(r => r.state === 'missing');
    lines.push('## Requirements with no tests', '');
    if (gaps.length) lines.push(...gaps.map(r => `- ${md(r.id)}: ${md(r.title)} (${md(r.area)}${r.priority ? `, priority ${md(r.priority)}` : ''})`));
    else lines.push('Every requirement has at least one test case.');
    lines.push('', '## Traceability', '', '| Requirement | Area | Status | Test cases | Automated tests |', '|---|---|---|---|---|');
    for (const r of d.rows) {
        lines.push(
            `| ${md(r.id)} ${md(r.title)} | ${md(r.area)} | ${REQUIREMENT_STATE_LABEL[r.state]} | ${r.cases.map(c => `${md(c.id)} (${CASE_STATE_LABEL[c.state]})`).join('<br>') || '-'} | ${r.cases.flatMap(c => c.tests).map(md).join('<br>') || '-'} |`
        );
    }
    if (d.unlinkedCases.length) lines.push('', '## Test cases not linked to any requirement', '', ...d.unlinkedCases.map(c => `- ${md(c.id)}: ${md(c.title)}`));
    if (d.warnings.length) lines.push('', '## Notes', '', ...d.warnings.map(w => `- ${md(w)}`));
    lines.push('');
    return lines.join('\n');
}

/** Shared look for TestPilot's insight pages: light and dark, phone friendly, no scripts or external assets. */
export const INSIGHTS_CSS = `
:root { color-scheme: light dark; --bg:#f7f8fa; --panel:#fff; --text:#1d2330; --muted:#5d6678; --line:#e3e6ec; --accent:#3557d4;
  --s-passing:#0f8a3c; --s-automated:#3a6fd8; --s-covered:#8aa4c8; --s-failing:#d03b3b; --s-missing:#ec835a; --on-strong:#fff; --on-soft:#13203a; }
@media (prefers-color-scheme: dark) { :root { --bg:#12151b; --panel:#1b1f27; --text:#e6e9ef; --muted:#9aa3b2; --line:#2b313c; --accent:#7f9cff;
  --s-passing:#2fb560; --s-automated:#5b8cf0; --s-covered:#6f86a8; --s-failing:#e25555; --s-missing:#ec835a; --on-strong:#fff; --on-soft:#0d1422; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 10px; }
.muted { color: var(--muted); }
.note { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--s-missing); border-radius:8px; padding:10px 12px; margin-top:14px; }
.cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-top:16px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.card .value { font-size:26px; font-weight:650; line-height:1.2; } .card .label { color:var(--muted); font-size:13px; }
.card .meter { height:6px; background:var(--line); border-radius:4px; overflow:hidden; margin-top:8px; }
.card .meter span { display:block; height:100%; background:var(--accent); border-radius:4px; }
.legend { display:flex; flex-wrap:wrap; gap:6px 14px; margin:6px 0 10px; font-size:13px; color:var(--muted); }
.legend span { display:inline-flex; align-items:center; gap:6px; }
.sw { width:12px; height:12px; border-radius:3px; display:inline-block; }
.st-passing { background:var(--s-passing); color:var(--on-strong); } .st-automated { background:var(--s-automated); color:var(--on-strong); }
.st-covered { background:var(--s-covered); color:var(--on-soft); } .st-failing { background:var(--s-failing); color:var(--on-strong); }
.st-missing { background:var(--s-missing); color:var(--on-soft); }
.heat { display:grid; grid-template-columns: minmax(110px, 200px) 1fr; gap:8px 12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; }
.heat .area { font-weight:600; font-size:14px; overflow-wrap:anywhere; } .heat .area small { display:block; color:var(--muted); font-weight:400; }
.tiles { display:flex; flex-wrap:wrap; gap:4px; align-content:flex-start; }
.tile { min-width:64px; max-width:140px; padding:4px 6px; border-radius:5px; font-size:12px; line-height:1.3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tile b { font-weight:600; }
.stack { display:flex; height:8px; border-radius:4px; overflow:hidden; gap:2px; margin-top:6px; background:var(--line); }
table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; font-size:13px; }
tr:last-child td { border-bottom:0; }
.chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; white-space:nowrap; margin:1px 0; }
.chip.plain { border:1px solid var(--line); color:var(--muted); }
code { font-size:12.5px; overflow-wrap:anywhere; }
@media (min-width: 601px) { table.trace td code { white-space:nowrap; overflow-wrap:normal; } }
.table-wrap { overflow-x:auto; }
ul.gaps { background:var(--panel); border:1px solid var(--line); border-radius:10px; margin:0; padding:10px 12px 10px 30px; }
a { color: var(--accent); }
@media (max-width: 600px) {
  .heat { grid-template-columns: 1fr; } .heat .area { margin-top:6px; }
  table.trace thead { display:none; } table.trace tr { display:block; border-bottom:1px solid var(--line); padding:6px 0; }
  table.trace td { display:block; border:0; padding:3px 10px; } table.trace td[data-label]::before { content: attr(data-label) ": "; color:var(--muted); font-size:12px; }
}
`;

export function legendHtml(): string {
    return `<div class="legend">${STATE_ORDER.map(s => `<span><i class="sw st-${s}"></i>${esc(REQUIREMENT_STATE_LABEL[s])}</span>`).join('')}</div>`;
}

const CASE_CHIP: Record<CaseState, RequirementState | 'plain'> = { passing: 'passing', failing: 'failing', flaky: 'failing', automated: 'automated', manual: 'covered', 'not-automated': 'plain' };

export function renderCoverageHtml(d: CoverageData): string {
    const t = d.totals;
    const card = (label: string, value: string | number, meter?: number) =>
        `<div class="card"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div>${meter !== undefined ? `<div class="meter"><span style="width:${meter}%"></span></div>` : ''}</div>`;
    const tile = (r: CoverageRow) => `<div class="tile st-${r.state}" title="${esc(`${r.id}: ${r.title} (${REQUIREMENT_STATE_LABEL[r.state]}, ${r.cases.length} case(s))`)}"><b>${esc(r.id)}</b> ${esc(r.title)}</div>`;
    const heat = d.areas
        .map(a => {
            const rows = d.rows.filter(r => r.area === a.area).sort((x, y) => STATE_ORDER.indexOf(y.state) - STATE_ORDER.indexOf(x.state));
            const stack = STATE_ORDER.filter(s => a[s]).map(s => `<span class="st-${s}" style="flex:${a[s]}" title="${esc(`${REQUIREMENT_STATE_LABEL[s]}: ${a[s]}`)}"></span>`).join('');
            return `<div class="area">${esc(a.area)}<small>${a.total} requirement(s), ${a.missing} without tests</small><div class="stack">${stack}</div></div><div class="tiles">${rows.map(tile).join('')}</div>`;
        })
        .join('');
    const gaps = d.rows.filter(r => r.state === 'missing');
    const trace = d.rows
        .map(
            r => `<tr><td data-label="Requirement"><strong>${r.link && /^https?:\/\//i.test(r.link) ? `<a href="${esc(r.link)}">${esc(r.id)}</a>` : esc(r.id)}</strong> ${esc(r.title)}${r.priority ? ` <span class="chip plain">${esc(r.priority)}</span>` : ''}</td><td data-label="Area">${esc(r.area)}</td><td data-label="Status"><span class="chip st-${r.state}">${esc(REQUIREMENT_STATE_LABEL[r.state])}</span></td><td data-label="Test cases">${
                r.cases.map(c => `<div>${esc(c.id)} <span class="chip ${CASE_CHIP[c.state] === 'plain' ? 'plain' : `st-${CASE_CHIP[c.state]}`}">${esc(CASE_STATE_LABEL[c.state])}</span></div>`).join('') || '<span class="muted">none</span>'
            }</td><td data-label="Automated tests">${r.cases.flatMap(c => c.tests).map(f => `<div><code>${esc(f)}</code></div>`).join('') || '<span class="muted">none</span>'}</td></tr>`
        )
        .join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coverage: ${esc(d.project)}</title>
<style>${INSIGHTS_CSS}</style>
</head>
<body>
<main>
<h1>Requirement coverage: ${esc(d.project)}</h1>
<div class="muted">Requirements from ${d.inferred ? 'test-case areas (inferred)' : `${d.source === 'jira' ? 'Jira' : 'file'} ${esc(d.sourceRef)}`} · ${d.run ? `latest run ${esc(d.run.at.slice(0, 16).replace('T', ' '))} UTC` : 'no test run yet'} · generated ${esc(d.generatedAt.slice(0, 16).replace('T', ' '))} UTC by TestPilot</div>
${d.inferred ? '<div class="note">No requirements were given, so each test-case area counts as one requirement. This shows how tests spread across areas, not true requirement coverage.</div>' : ''}
<div class="cards">${card('requirements with at least one test', `${t.pctWithTests}%`, t.pctWithTests)}${card('requirements with an automated test', `${t.pctAutomated}%`, t.pctAutomated)}${card('requirements automated and passing', `${t.pctPassing}%`, t.pctPassing)}${card('requirements', t.requirements)}${card('with no tests', t.missing)}${card('with a failing test', t.failing)}</div>
<h2>Coverage by area</h2>
${legendHtml()}
<div class="heat">${heat || '<div class="muted">No requirements.</div>'}</div>
<h2>Requirements with no tests (${gaps.length})</h2>
${gaps.length ? `<ul class="gaps">${gaps.map(r => `<li><strong>${esc(r.id)}</strong> ${esc(r.title)} <span class="muted">(${esc(r.area)}${r.priority ? `, priority ${esc(r.priority)}` : ''})</span></li>`).join('')}</ul>` : '<p class="muted">Every requirement has at least one test case.</p>'}
<h2>Traceability</h2>
<div class="table-wrap"><table class="trace"><thead><tr><th>Requirement</th><th>Area</th><th>Status</th><th>Test cases</th><th>Automated tests</th></tr></thead><tbody>${trace}</tbody></table></div>
${d.unlinkedCases.length ? `<h2>Test cases not linked to a requirement (${d.unlinkedCases.length})</h2><ul class="gaps">${d.unlinkedCases.map(c => `<li><strong>${esc(c.id)}</strong> ${esc(c.title)}</li>`).join('')}</ul>` : ''}
${d.warnings.length ? `<h2>Notes</h2><ul class="gaps">${d.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<p class="muted" style="margin-top:28px">A requirement counts as linked to a test case when its id appears in the case's tags, title, description or source, in a Jira issue link, or in .testpilot/requirements/links.json.</p>
</main>
</body>
</html>
`;
}
