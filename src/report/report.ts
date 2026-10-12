import type { Config, TestCase } from '../core/schema.js';
import { type ProjectStore, RUNS_DIR } from '../core/store.js';
import type { PlanMeta } from '../plan/plan.js';
import type { RunSummary, TestOutcome } from '../run/playwright.js';

export const REPORTS_DIR = '.testpilot/reports';

export interface ReportData {
    project: string;
    generatedAt: string;
    run?: RunSummary;
    history: Array<{ at: string; passRate: number; total: number }>;
    progress: { planned: number; generated: number; passing: number; failing: number; manual: number; rework: number; total: number };
    areas: Array<{ area: string; tests: number; passed: number; failed: number; flaky: number }>;
    failures: TestOutcome[];
    flaky: TestOutcome[];
}

export function collectReport(store: ProjectStore, config: Config, run: RunSummary | undefined, cases: TestCase[], plan: PlanMeta | undefined): ReportData {
    const byId = new Map(cases.map(tc => [tc.id, tc]));
    const history = store
        .list(RUNS_DIR, n => /^\d{8}-\d{6}\.json$/.test(n))
        .slice(-12)
        .map(file => {
            try {
                const r = JSON.parse(store.read(file)!) as RunSummary;
                const counted = r.stats.total - r.stats.skipped;
                return { at: r.startedAt, passRate: counted ? Math.round((r.stats.passed / counted) * 100) : 0, total: r.stats.total };
            } catch {
                return undefined;
            }
        })
        .filter((h): h is { at: string; passRate: number; total: number } => Boolean(h));
    const status = (s: string) => cases.filter(tc => tc.automation?.status === s).length;
    const progress = {
        total: cases.length,
        planned: plan ? plan.waves.reduce((n, w) => n + w.ids.length, 0) : 0,
        generated: status('generated') + status('passing') + status('failing'),
        passing: status('passing'),
        failing: status('failing'),
        manual: plan?.manual.length ?? status('manual'),
        rework: plan?.rework.length ?? cases.filter(tc => tc.review?.verdict === 'NEEDS-REWORK').length
    };
    const areaMap = new Map<string, ReportData['areas'][number]>();
    for (const t of run?.tests ?? []) {
        const area = byId.get(t.id)?.area ?? 'General';
        const a = areaMap.get(area) ?? { area, tests: 0, passed: 0, failed: 0, flaky: 0 };
        a.tests++;
        if (t.status === 'passed') a.passed++;
        if (t.status === 'failed') a.failed++;
        if (t.status === 'flaky') a.flaky++;
        areaMap.set(area, a);
    }
    return {
        project: config.project.name ?? store.root.split(/[\\/]/).pop() ?? 'Project',
        generatedAt: new Date().toISOString(),
        run,
        history,
        progress,
        areas: [...areaMap.values()].sort((a, b) => a.area.localeCompare(b.area)),
        failures: (run?.tests ?? []).filter(t => t.status === 'failed'),
        flaky: (run?.tests ?? []).filter(t => t.status === 'flaky')
    };
}

function passRate(run?: RunSummary): number | undefined {
    if (!run) return undefined;
    const counted = run.stats.total - run.stats.skipped;
    return counted ? Math.round((run.stats.passed / counted) * 100) : undefined;
}

function md(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderReportMarkdown(d: ReportData): string {
    const r = d.run;
    const rate = passRate(r);
    const lines = [`# Test report: ${d.project}`, '', `Generated ${d.generatedAt.slice(0, 16).replace('T', ' ')} UTC by TestPilot.`, ''];
    if (r) {
        lines.push(
            `**${rate ?? 0}% passed**: ${r.stats.passed} passed, ${r.stats.failed} failed, ${r.stats.flaky} flaky, ${r.stats.skipped} skipped, in ${Math.round(r.stats.durationMs / 1000)}s.`,
            '',
            `Run ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC${r.baseUrl ? ` against ${r.baseUrl}` : ''}${r.repeat > 1 ? `, each test ${r.repeat} times` : ''}. Full Playwright report: \`playwright-report/index.html\`.`,
            ''
        );
    } else lines.push('No test run yet. Run the tests with run_tests first.', '');
    const p = d.progress;
    lines.push('## Automation progress', '', '| Test cases | Planned | Generated | Passing | Failing | Manual | Need rework |', '|---|---|---|---|---|---|---|', `| ${p.total} | ${p.planned} | ${p.generated} | ${p.passing} | ${p.failing} | ${p.manual} | ${p.rework} |`, '');
    if (d.areas.length) {
        lines.push('## By area', '', '| Area | Tests | Passed | Failed | Flaky |', '|---|---|---|---|---|', ...d.areas.map(a => `| ${md(a.area)} | ${a.tests} | ${a.passed} | ${a.failed} | ${a.flaky} |`), '');
    }
    if (d.failures.length) {
        lines.push('## Failures', '');
        for (const f of d.failures) lines.push(`- **${md(f.title)}** (${f.category ?? 'unknown'}): ${md((f.error ?? '').split('\n')[0]).slice(0, 200)}`, `  - ${f.advice ?? ''}`);
        lines.push('');
    }
    if (d.flaky.length) lines.push('## Flaky', '', ...d.flaky.map(f => `- ${md(f.title)}: passed ${f.passes} of ${f.runs} runs`), '');
    if (d.history.length > 1) lines.push('## Trend', '', '| Run | Tests | Pass rate |', '|---|---|---|', ...d.history.map(h => `| ${h.at.slice(0, 16).replace('T', ' ')} | ${h.total} | ${h.passRate}% |`), '');
    return lines.join('\n');
}

function esc(s: unknown): string {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A self-contained HTML page for people who do not read Markdown: no scripts, no external assets. */
export function renderReportHtml(d: ReportData): string {
    const r = d.run;
    const rate = passRate(r) ?? 0;
    const card = (label: string, value: string | number, tone = '') => `<div class="card ${tone}"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`;
    const p = d.progress;
    const trend = d.history
        .map(h => `<div class="bar" title="${esc(h.at.slice(0, 16).replace('T', ' '))}: ${h.passRate}%"><span style="height:${Math.max(2, h.passRate)}%"></span></div>`)
        .join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report: ${esc(d.project)}</title>
<style>
:root { --bg:#f7f8fa; --panel:#fff; --text:#1d2330; --muted:#5d6678; --line:#e3e6ec; --ok:#1f8a4c; --bad:#c23b3b; --warn:#b7791f; --accent:#3557d4; }
@media (prefers-color-scheme: dark) { :root { --bg:#12151b; --panel:#1b1f27; --text:#e6e9ef; --muted:#9aa3b2; --line:#2b313c; --ok:#4cc38a; --bad:#ef6b6b; --warn:#e6b450; --accent:#7f9cff; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 10px; }
.muted { color: var(--muted); }
.cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:10px; margin-top:16px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.card .value { font-size:24px; font-weight:650; } .card .label { color:var(--muted); font-size:13px; }
.card.ok .value { color:var(--ok); } .card.bad .value { color:var(--bad); } .card.warn .value { color:var(--warn); }
.meter { height:10px; background:var(--line); border-radius:6px; overflow:hidden; margin-top:14px; }
.meter span { display:block; height:100%; background:var(--ok); }
table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; font-size:13px; }
tr:last-child td { border-bottom:0; }
.tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
pre { white-space:pre-wrap; word-break:break-word; margin:6px 0 0; font-size:12.5px; color:var(--muted); }
.trend { display:flex; gap:6px; align-items:flex-end; height:80px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; }
.bar { flex:1; height:100%; display:flex; align-items:flex-end; } .bar span { display:block; width:100%; background:var(--accent); border-radius:4px 4px 0 0; }
.table-wrap { overflow-x:auto; }
</style>
</head>
<body>
<main>
<h1>Test report: ${esc(d.project)}</h1>
<div class="muted">${r ? `Run ${esc(r.startedAt.slice(0, 16).replace('T', ' '))} UTC${r.baseUrl ? ` against ${esc(r.baseUrl)}` : ''}${r.repeat > 1 ? `, each test ${r.repeat}×` : ''}` : 'No test run yet'} · generated by TestPilot</div>
${
    r
        ? `<div class="cards">${card('pass rate', `${rate}%`, rate === 100 ? 'ok' : rate < 80 ? 'bad' : 'warn')}${card('passed', r.stats.passed, 'ok')}${card('failed', r.stats.failed, r.stats.failed ? 'bad' : '')}${card('flaky', r.stats.flaky, r.stats.flaky ? 'warn' : '')}${card('skipped', r.stats.skipped)}${card('duration', `${Math.round(r.stats.durationMs / 1000)}s`)}</div>
<div class="meter" aria-label="pass rate ${rate}%"><span style="width:${rate}%"></span></div>`
        : ''
}
<h2>Automation progress</h2>
<div class="cards">${card('test cases', p.total)}${card('planned', p.planned)}${card('generated', p.generated)}${card('passing', p.passing, 'ok')}${card('failing', p.failing, p.failing ? 'bad' : '')}${card('manual', p.manual)}${card('need rework', p.rework, p.rework ? 'warn' : '')}</div>
${
    d.areas.length
        ? `<h2>By area</h2><div class="table-wrap"><table><thead><tr><th>Area</th><th>Tests</th><th>Passed</th><th>Failed</th><th>Flaky</th></tr></thead><tbody>${d.areas.map(a => `<tr><td>${esc(a.area)}</td><td>${a.tests}</td><td>${a.passed}</td><td>${a.failed}</td><td>${a.flaky}</td></tr>`).join('')}</tbody></table></div>`
        : ''
}
${
    d.failures.length
        ? `<h2>Failures</h2><div class="table-wrap"><table><thead><tr><th>Test</th><th>Likely cause</th></tr></thead><tbody>${d.failures
              .map(f => `<tr><td><strong>${esc(f.title)}</strong><div class="muted">${esc(f.file)}${f.line ? `:${f.line}` : ''}</div><pre>${esc((f.error ?? '').split('\n').slice(0, 4).join('\n'))}</pre></td><td><span class="tag">${esc(f.category ?? 'unknown')}</span><div class="muted">${esc(f.advice ?? '')}</div></td></tr>`)
              .join('')}</tbody></table></div>`
        : ''
}
${d.flaky.length ? `<h2>Flaky</h2><div class="table-wrap"><table><tbody>${d.flaky.map(f => `<tr><td>${esc(f.title)}</td><td>passed ${f.passes} of ${f.runs}</td></tr>`).join('')}</tbody></table></div>` : ''}
${d.history.length > 1 ? `<h2>Pass rate, last ${d.history.length} runs</h2><div class="trend">${trend}</div>` : ''}
<p class="muted" style="margin-top:28px">Step-by-step details, screenshots and traces: open <code>playwright-report/index.html</code>.</p>
</main>
</body>
</html>
`;
}

/** Builds JUnit XML from a run, with each test-case id as a test_key property (Xray, Zephyr and others read it). */
export function junitFromRun(run: RunSummary): string {
    const x = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const failures = run.tests.filter(t => t.status === 'failed').length;
    const skipped = run.tests.filter(t => t.status === 'skipped').length;
    const cases = run.tests.map(t => {
        const inner = [`      <properties><property name="test_key" value="${x(t.id)}"/></properties>`];
        if (t.status === 'failed') inner.push(`      <failure message="${x((t.error ?? 'failed').split('\n')[0].slice(0, 300))}" type="${x(t.category ?? 'failure')}">${x(t.error ?? '')}</failure>`);
        if (t.status === 'skipped') inner.push('      <skipped/>');
        if (t.status === 'flaky') inner.push(`      <system-out>Flaky: passed ${t.passes} of ${t.runs} runs</system-out>`);
        return `    <testcase name="${x(t.title)}" classname="${x(t.file)}" time="${(t.durationMs / 1000).toFixed(3)}">\n${inner.join('\n')}\n    </testcase>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="TestPilot" tests="${run.tests.length}" failures="${failures}" skipped="${skipped}" time="${(run.stats.durationMs / 1000).toFixed(3)}">
  <testsuite name="TestPilot run ${x(run.startedAt)}" tests="${run.tests.length}" failures="${failures}" skipped="${skipped}" timestamp="${x(run.startedAt)}">
${cases.join('\n')}
  </testsuite>
</testsuites>
`;
}
