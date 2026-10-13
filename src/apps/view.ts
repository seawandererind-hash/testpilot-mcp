/**
 * The shared TestPilot MCP App view: one self-contained HTML page (no external
 * scripts, styles or network). It speaks the MCP Apps postMessage JSON-RPC with
 * the host: ui/initialize, ui/notifications/initialized, tool-input, tool-result,
 * host-context-changed, size-changed and tools/call for the refresh button.
 * It draws structuredContent by its `view` field: 'coverage', 'metrics', or a
 * generic table for anything else. All data is rendered with textContent.
 */

export const INSIGHTS_VIEW_URI = 'ui://testpilot/insights.html';

export function insightsViewHtml(): string {
    return VIEW_HTML;
}

const VIEW_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TestPilot insights</title>
<style>
:root { color-scheme: light dark;
  --fb-bg:#ffffff; --fb-panel:#f6f7f9; --fb-text:#1d2330; --fb-muted:#5d6678; --fb-line:#e3e6ec; --fb-accent:#3557d4;
  --s-passing:#0f8a3c; --s-automated:#3a6fd8; --s-covered:#8aa4c8; --s-failing:#d03b3b; --s-missing:#ec835a; --on-strong:#fff; --on-soft:#13203a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --fb-bg:#1b1f27; --fb-panel:#232833; --fb-text:#e6e9ef; --fb-muted:#9aa3b2; --fb-line:#2f3642; --fb-accent:#7f9cff;
  --s-passing:#2fb560; --s-automated:#5b8cf0; --s-covered:#6f86a8; --s-failing:#e25555; --on-soft:#0d1422; } }
:root[data-theme="dark"] {
  --fb-bg:#1b1f27; --fb-panel:#232833; --fb-text:#e6e9ef; --fb-muted:#9aa3b2; --fb-line:#2f3642; --fb-accent:#7f9cff;
  --s-passing:#2fb560; --s-automated:#5b8cf0; --s-covered:#6f86a8; --s-failing:#e25555; --on-soft:#0d1422; }
:root {
  --bg: var(--color-background-primary, var(--fb-bg)); --panel: var(--color-background-secondary, var(--fb-panel));
  --text: var(--color-text-primary, var(--fb-text)); --muted: var(--color-text-secondary, var(--fb-muted));
  --line: var(--color-border-primary, var(--fb-line)); --accent: var(--color-text-info, var(--fb-accent));
  --radius: var(--border-radius-md, 8px); }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--bg); color:var(--text); font: var(--font-text-md-size, 14px)/1.45 var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); }
#app { padding: 14px 14px 16px; }
header { display:flex; gap:10px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; }
h1 { font-size:16px; margin:0; } h2 { font-size:14px; margin:16px 0 8px; }
.muted { color:var(--muted); } .small { font-size:12px; }
button { font:inherit; font-size:13px; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:5px 12px; cursor:pointer; }
button:hover { border-color:var(--accent); } button:disabled { opacity:.6; cursor:default; }
.cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:8px; margin-top:12px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:10px 12px; }
.card .v { font-size:22px; font-weight:650; line-height:1.2; } .card .l { color:var(--muted); font-size:12px; }
.meter { height:5px; background:var(--line); border-radius:4px; overflow:hidden; margin-top:6px; } .meter span { display:block; height:100%; background:var(--accent); }
.legend { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:12px; color:var(--muted); margin:4px 0 8px; }
.legend span { display:inline-flex; align-items:center; gap:5px; } .sw { width:10px; height:10px; border-radius:3px; display:inline-block; }
.st-passing { background:var(--s-passing); color:var(--on-strong); } .st-automated { background:var(--s-automated); color:var(--on-strong); }
.st-covered { background:var(--s-covered); color:var(--on-soft); } .st-failing { background:var(--s-failing); color:var(--on-strong); } .st-missing { background:var(--s-missing); color:var(--on-soft); }
.heat { display:grid; grid-template-columns:minmax(90px, 170px) 1fr; gap:6px 10px; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:10px; }
.area { font-weight:600; font-size:13px; overflow-wrap:anywhere; } .area small { display:block; font-weight:400; color:var(--muted); }
.tiles { display:flex; flex-wrap:wrap; gap:3px; align-content:flex-start; }
.tile { max-width:130px; padding:3px 6px; border-radius:4px; font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
ul.list { margin:0; padding:8px 10px 8px 26px; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); }
.note { border-left:3px solid var(--s-missing); background:var(--panel); padding:8px 10px; border-radius:6px; margin-top:10px; font-size:13px; }
.wrap { overflow-x:auto; } table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; font-size:12px; }
.empty { padding:24px 0; text-align:center; color:var(--muted); }
@media (max-width: 520px) { .heat { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div id="app"><div class="empty">Waiting for TestPilot results...</div></div>
<script>
(function () {
    'use strict';
    var PROTOCOL_VERSION = '2026-01-26';
    var app = document.getElementById('app');
    var nextId = 1;
    var pending = {};
    var toolArgs = null;
    var current = null;
    var LABELS = { passing: 'Automated and passing', automated: 'Automated, not yet passing', covered: 'Tested by hand only', failing: 'Failing', missing: 'No tests' };
    var ORDER = ['passing', 'automated', 'covered', 'failing', 'missing'];

    function post(msg) { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); }
    function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
    function request(method, params) {
        var id = nextId++;
        post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
        return new Promise(function (resolve, reject) {
            pending[id] = { resolve: resolve, reject: reject };
            setTimeout(function () { if (pending[id]) { delete pending[id]; reject(new Error('The host did not answer in time.')); } }, 120000);
        });
    }

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) for (var k in attrs) {
            if (k === 'text') node.textContent = attrs[k];
            else if (k === 'class') node.className = attrs[k];
            else if (k === 'style') node.setAttribute('style', attrs[k]);
            else node.setAttribute(k, attrs[k]);
        }
        (children || []).forEach(function (c) { if (c !== null && c !== undefined) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
        return node;
    }
    function card(label, value, meter) {
        var kids = [el('div', { class: 'v', text: String(value) }), el('div', { class: 'l', text: label })];
        if (typeof meter === 'number') kids.push(el('div', { class: 'meter' }, [el('span', { style: 'width:' + Math.max(0, Math.min(100, meter)) + '%' })]));
        return el('div', { class: 'card' }, kids);
    }
    function legend() {
        return el('div', { class: 'legend' }, ORDER.map(function (s) { return el('span', null, [el('i', { class: 'sw st-' + s }), LABELS[s]]); }));
    }
    function pct(v) { return typeof v === 'number' ? v + '%' : '-'; }

    function renderCoverage(d) {
        var t = d.totals || {};
        var out = [];
        if (d.inferred) out.push(el('div', { class: 'note', text: 'No requirements were given, so each test-case area counts as one requirement. This shows how tests spread across areas, not true requirement coverage.' }));
        out.push(el('div', { class: 'cards' }, [
            card('requirements with a test', pct(t.pctWithTests), t.pctWithTests),
            card('with an automated test', pct(t.pctAutomated), t.pctAutomated),
            card('automated and passing', pct(t.pctPassing), t.pctPassing),
            card('requirements', t.requirements || 0),
            card('with no tests', t.missing || 0),
            card('with a failing test', t.failing || 0)
        ]));
        out.push(el('h2', { text: 'Coverage by area' }), legend());
        var rows = Array.isArray(d.rows) ? d.rows : [];
        var heat = el('div', { class: 'heat' });
        (Array.isArray(d.areas) ? d.areas : []).forEach(function (a) {
            heat.appendChild(el('div', { class: 'area' }, [String(a.area), el('small', { text: a.total + ' requirement(s), ' + (a.missing || 0) + ' without tests' })]));
            var tiles = el('div', { class: 'tiles' });
            rows.filter(function (r) { return r.area === a.area; })
                .sort(function (x, y) { return ORDER.indexOf(y.state) - ORDER.indexOf(x.state); })
                .forEach(function (r) {
                    tiles.appendChild(el('div', { class: 'tile st-' + (ORDER.indexOf(r.state) >= 0 ? r.state : 'missing'), title: r.id + ': ' + r.title + ' (' + (LABELS[r.state] || r.state) + ', ' + (r.cases || 0) + ' case(s))' }, [el('b', { text: String(r.id) }), ' ' + String(r.title || '')]));
                });
            heat.appendChild(tiles);
        });
        out.push(heat);
        var gaps = rows.filter(function (r) { return r.state === 'missing'; });
        out.push(el('h2', { text: 'Requirements with no tests (' + gaps.length + ')' }));
        out.push(gaps.length ? el('ul', { class: 'list' }, gaps.slice(0, 100).map(function (r) { return el('li', null, [el('b', { text: String(r.id) }), ' ' + String(r.title || '') + ' ', el('span', { class: 'muted', text: '(' + r.area + ')' })]); }))
                             : el('div', { class: 'muted', text: 'Every requirement has at least one test case.' }));
        if (d.truncated) out.push(el('div', { class: 'muted small', text: 'Showing the first ' + rows.length + ' requirements. The full map is in ' + (d.files ? d.files[0] : 'the HTML report') + '.' }));
        return out;
    }

    function renderMetrics(d) {
        var m = d.metrics || d;
        var c = m.cases || {};
        var r = m.latestRun;
        var cards = [
            card('test cases', c.total || 0),
            card('automated', pct(c.pctAutomated), c.pctAutomated),
            card('latest pass rate', r ? pct(r.passRate) : '-', r ? r.passRate : undefined),
            card('flaky rate across runs', m.flaky && m.flaky.testsSeen ? pct(m.flaky.ratePct) : '-'),
            card('test runs, last 30 days', m.runsLast30Days || 0),
            card('manual hours saved, 30 days (estimate)', m.manualHoursSaved ? m.manualHoursSaved.last30Days : 0)
        ];
        if (m.requirements) cards.push(card('requirements with a test', pct(m.requirements.pctWithTests), m.requirements.pctWithTests));
        var out = [el('div', { class: 'cards' }, cards)];
        out.push(el('div', { class: 'cards' }, [card('manual', c.manual || 0), card('need rework', c.rework || 0), card('not automated yet', c.notAutomated || 0)]));
        if (m.manualHoursSaved && m.manualHoursSaved.note) out.push(el('p', { class: 'muted small', text: m.manualHoursSaved.note }));
        return out;
    }

    function cellText(v) {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return Array.isArray(v) ? v.map(cellText).join(', ') : JSON.stringify(v).slice(0, 120);
        return String(v);
    }
    function renderTable(d) {
        var out = [];
        var scalars = [];
        var tables = [];
        Object.keys(d).forEach(function (k) {
            if (k === 'view' || k === 'title' || k === 'subtitle' || k === 'rerun') return;
            var v = d[k];
            if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) tables.push([k, v]);
            else if (v !== null && typeof v !== 'object') scalars.push([k, v]);
            else if (v && typeof v === 'object' && !Array.isArray(v)) Object.keys(v).forEach(function (k2) { if (typeof v[k2] !== 'object') scalars.push([k + ' ' + k2, v[k2]]); });
        });
        if (scalars.length) out.push(el('div', { class: 'cards' }, scalars.slice(0, 12).map(function (s) { return card(s[0], cellText(s[1])); })));
        tables.forEach(function (pair) {
            var rows = pair[1].slice(0, 100);
            var cols = [];
            rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0 && cols.length < 8) cols.push(k); }); });
            out.push(el('h2', { text: pair[0] }));
            out.push(el('div', { class: 'wrap' }, [el('table', null, [
                el('thead', null, [el('tr', null, cols.map(function (c) { return el('th', { text: c }); }))]),
                el('tbody', null, rows.map(function (r) { return el('tr', null, cols.map(function (c) { return el('td', { text: cellText(r[c]) }); })); }))
            ])]));
        });
        if (!out.length) out.push(el('div', { class: 'empty', text: 'Nothing to show.' }));
        return out;
    }

    var TITLES = { coverage: 'Requirement coverage', metrics: 'Test automation metrics' };

    function render(data, note) {
        current = data;
        app.textContent = '';
        if (!data || typeof data !== 'object') { app.appendChild(el('div', { class: 'empty', text: note || 'No structured result to show.' })); return; }
        var button = data.rerun ? el('button', { type: 'button', text: 'Refresh' }) : null;
        if (button) button.addEventListener('click', function () { rerun(button); });
        app.appendChild(el('header', null, [
            el('div', null, [el('h1', { text: data.title || TITLES[data.view] || 'TestPilot' }), data.subtitle ? el('div', { class: 'muted small', text: String(data.subtitle) }) : null]),
            button
        ]));
        var body = data.view === 'coverage' ? renderCoverage(data) : data.view === 'metrics' ? renderMetrics(data) : renderTable(data);
        body.forEach(function (n) { app.appendChild(n); });
        if (note) app.appendChild(el('p', { class: 'muted small', text: note }));
        reportSize();
    }

    function fromResult(result) {
        if (!result) return render(null);
        if (result.isError) {
            var msg = (result.content || []).map(function (c) { return c && c.type === 'text' ? c.text : ''; }).join('\n');
            return render(current, 'The last call failed: ' + msg.slice(0, 400));
        }
        render(result.structuredContent || null);
    }

    function rerun(button) {
        var r = current && current.rerun;
        if (!r) return;
        button.disabled = true;
        button.textContent = 'Refreshing...';
        request('tools/call', { name: r.tool, arguments: r.arguments || toolArgs || {} })
            .then(fromResult)
            .catch(function (e) { render(current, 'Could not refresh: ' + (e && e.message ? e.message : String(e))); });
    }

    function applyContext(ctx) {
        if (!ctx) return;
        if (ctx.theme === 'light' || ctx.theme === 'dark') document.documentElement.setAttribute('data-theme', ctx.theme);
        var vars = ctx.styles && ctx.styles.variables;
        if (vars) Object.keys(vars).forEach(function (k) { if (/^--[a-z0-9-]+$/i.test(k) && vars[k]) document.documentElement.style.setProperty(k, String(vars[k])); });
    }

    var lastSize = '';
    function reportSize() {
        var h = Math.ceil(document.documentElement.scrollHeight);
        var w = Math.ceil(document.documentElement.scrollWidth);
        var key = w + 'x' + h;
        if (key === lastSize) return;
        lastSize = key;
        notify('ui/notifications/size-changed', { width: w, height: h });
    }

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        var m = event.data;
        if (!m || m.jsonrpc !== '2.0') return;
        if (m.method === undefined && m.id !== undefined) {
            var p = pending[m.id];
            if (!p) return;
            delete pending[m.id];
            if (m.error) p.reject(new Error(m.error.message || 'Host error')); else p.resolve(m.result);
            return;
        }
        var params = m.params || {};
        switch (m.method) {
            case 'ui/notifications/tool-input': toolArgs = params.arguments || null; break;
            case 'ui/notifications/tool-result': fromResult(params); break;
            case 'ui/notifications/tool-cancelled': render(current, 'The tool call was cancelled' + (params.reason ? ': ' + params.reason : '.')); break;
            case 'ui/notifications/host-context-changed': applyContext(params); break;
            case 'ui/resource-teardown': post({ jsonrpc: '2.0', id: m.id, result: {} }); break;
            default:
                if (m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not supported by this view' } });
        }
    });

    if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.documentElement);

    request('ui/initialize', { protocolVersion: PROTOCOL_VERSION, appCapabilities: { availableDisplayModes: ['inline'] }, clientInfo: { name: 'testpilot-insights-view', version: '1.0.0' } })
        .then(function (res) {
            applyContext(res && res.hostContext);
            notify('ui/notifications/initialized', {});
            reportSize();
        })
        .catch(function () { /* Opened outside a host: keep waiting for data. */ });
})();
</script>
</body>
</html>
`;
