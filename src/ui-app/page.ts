/**
 * The TestPilot app page: one self-contained HTML document (no external scripts, fonts
 * or images). It talks only to the local app server (/api/*), which calls the same
 * TestPilot tools the AI chats use. Everything from a tool is shown with textContent.
 * The page script avoids backticks and "${" so it can live in this template string.
 */
export function appPageHtml(): string {
    return PAGE_HTML;
}

const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TestPilot</title>
<style>
:root {
  --bg: #f6f7fb; --panel: #ffffff; --panel-2: #f0f2f8; --text: #1b1f2a; --muted: #5d6475; --line: #dfe3ec;
  --accent: #3b5bdb; --accent-text: #ffffff; --accent-soft: #e7ecff; --ok: #1f8a4c; --ok-soft: #e3f5ea;
  --warn: #a15c00; --warn-soft: #fff3df; --bad: #c62f2f; --bad-soft: #fde8e8; --shadow: 0 1px 2px rgba(20,30,60,.06), 0 4px 16px rgba(20,30,60,.05);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12151c; --panel: #1a1e27; --panel-2: #222734; --text: #e7e9ef; --muted: #9aa2b4; --line: #2e3443;
  --accent: #7c95ff; --accent-text: #0d1020; --accent-soft: #252d4d; --ok: #4cc283; --ok-soft: #173326;
  --warn: #f0b35a; --warn-soft: #3a2c14; --bad: #ff7b7b; --bad-soft: #3d1c1c; --shadow: none;
} }
:root[data-theme="dark"] {
  --bg: #12151c; --panel: #1a1e27; --panel-2: #222734; --text: #e7e9ef; --muted: #9aa2b4; --line: #2e3443;
  --accent: #7c95ff; --accent-text: #0d1020; --accent-soft: #252d4d; --ok: #4cc283; --ok-soft: #173326;
  --warn: #f0b35a; --warn-soft: #3a2c14; --bad: #ff7b7b; --bad-soft: #3d1c1c; --shadow: none;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--accent); }
header { display: flex; align-items: center; gap: 14px; padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
.logo { font-weight: 700; font-size: 18px; display: flex; align-items: center; gap: 8px; }
.logo-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accent-text); display: grid; place-items: center; font-size: 15px; }
.project { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.project b { color: var(--text); font-weight: 600; }
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: calc(100vh - 57px); }
nav { border-right: 1px solid var(--line); padding: 14px 10px; background: var(--panel); }
nav button { display: flex; width: 100%; align-items: center; gap: 10px; border: 0; background: transparent; padding: 9px 12px; border-radius: 8px; cursor: pointer; text-align: left; color: var(--muted); }
nav button:hover { background: var(--panel-2); color: var(--text); }
nav button[aria-current="page"] { background: var(--accent-soft); color: var(--text); font-weight: 600; }
nav .ico { width: 20px; text-align: center; }
nav hr { border: 0; border-top: 1px solid var(--line); margin: 10px 4px; }
main:focus { outline: none; }
main { padding: 24px clamp(16px, 3vw, 36px) 60px; max-width: 1100px; width: 100%; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 0 0 10px; }
h3 { font-size: 15px; margin: 16px 0 8px; }
.lead { color: var(--muted); margin: 0 0 20px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; box-shadow: var(--shadow); }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; cursor: pointer; text-align: left; box-shadow: var(--shadow); }
.tile:hover { border-color: var(--accent); }
.tile b { display: block; margin-bottom: 4px; }
.tile span { color: var(--muted); font-size: 13px; }
.btn { border: 1px solid var(--line); background: var(--panel); padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: 500; }
.btn:hover { border-color: var(--accent); }
.btn.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.btn.primary:hover { filter: brightness(1.08); }
.btn.danger { border-color: var(--bad); color: var(--bad); }
.btn:disabled { opacity: .5; cursor: default; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
label.field { display: block; margin: 10px 0; }
label.field > span { display: block; font-weight: 600; margin-bottom: 4px; font-size: 14px; }
label.row > span { flex: 1; min-width: 200px; }
label.field small { display: block; color: var(--muted); font-weight: 400; }
input[type=text], input[type=number], input[type=url], select, textarea { width: 100%; max-width: 560px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
textarea { min-height: 90px; }
.options { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); margin: 14px 0; }
.option { text-align: left; border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 12px 14px; cursor: pointer; position: relative; }
.option:hover { border-color: var(--accent); }
.option.selected { border-color: var(--accent); background: var(--accent-soft); }
.option b { display: block; }
.option span { color: var(--muted); font-size: 13px; }
.badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; background: var(--accent-soft); color: var(--accent); margin-left: 6px; vertical-align: middle; }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.bad { background: var(--bad-soft); color: var(--bad); }
.note { border-left: 4px solid var(--accent); background: var(--accent-soft); padding: 10px 14px; border-radius: 6px; margin: 12px 0; }
.note.warn { border-color: var(--warn); background: var(--warn-soft); }
.note.ok { border-color: var(--ok); background: var(--ok-soft); }
.note.bad { border-color: var(--bad); background: var(--bad-soft); }
.result { white-space: pre-wrap; overflow-wrap: anywhere; }
.steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
.steps li { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; }
.steps li.current { background: var(--accent-soft); font-weight: 600; }
.steps .dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; border: 1px solid var(--line); flex: none; }
.steps li.done .dot { background: var(--ok); border-color: var(--ok); color: #fff; }
.steps li.current .dot { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.steps li button { margin-left: auto; font-size: 12px; padding: 2px 8px; }
.progress { height: 8px; background: var(--panel-2); border-radius: 99px; overflow: hidden; margin: 8px 0 4px; }
.progress > div { height: 100%; background: var(--accent); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: break-word; }
th { white-space: nowrap; }
td { min-width: 3.5em; }
th { color: var(--muted); font-weight: 600; background: var(--panel-2); }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
details { margin: 10px 0; }
summary { cursor: pointer; color: var(--muted); }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 6px 0; font-size: 13px; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; overflow-wrap: anywhere; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
.filelist { max-height: 280px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
.overlay { position: fixed; inset: 0; background: rgba(10,14,25,.45); display: none; align-items: center; justify-content: center; z-index: 20; padding: 16px; }
.overlay.show { display: flex; }
.dialog { background: var(--panel); border-radius: 14px; padding: 22px; width: min(520px, 100%); box-shadow: 0 10px 40px rgba(0,0,0,.3); }
.spinner { width: 34px; height: 34px; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--accent); animation: spin 1s linear infinite; margin: 0 auto 12px; }
@keyframes spin { to { transform: rotate(360deg); } }
.chat-log { display: flex; flex-direction: column; gap: 10px; min-height: 240px; max-height: 60vh; overflow-y: auto; padding: 4px 2px 10px; }
.bubble { max-width: 85%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble.me { align-self: flex-end; background: var(--accent); color: var(--accent-text); border-bottom-right-radius: 4px; }
.bubble.ai { align-self: flex-start; background: var(--panel-2); border-bottom-left-radius: 4px; }
.bubble.err { align-self: flex-start; background: var(--bad-soft); color: var(--text); border-left: 4px solid var(--bad); }
.bubble code { background: rgba(127,127,127,.18); padding: 1px 5px; border-radius: 4px; }
.chip { display: inline-block; align-self: flex-start; font-size: 12px; color: var(--muted); background: var(--panel-2); border: 1px dashed var(--line); border-radius: 99px; padding: 2px 10px; }
.engines { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); margin-bottom: 12px; }
.chat-input { display: flex; gap: 10px; align-items: flex-end; }
.chat-input textarea { flex: 1; max-width: none; min-height: 52px; resize: vertical; }
.suggest { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.suggest button { font-size: 13px; padding: 5px 10px; border-radius: 99px; }
.toast { position: fixed; bottom: 18px; right: 18px; background: var(--text); color: var(--bg); padding: 10px 16px; border-radius: 10px; opacity: 0; transition: opacity .2s; z-index: 30; max-width: 360px; }
.toast.show { opacity: 1; }
iframe.view { width: 100%; border: 1px solid var(--line); border-radius: 10px; min-height: 300px; background: var(--panel); }
.muted { color: var(--muted); }
.hidden { display: none !important; }
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; }
  nav { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 6px; gap: 4px; }
  nav button { width: auto; white-space: nowrap; }
  nav hr { display: none; }
}
</style>
</head>
<body>
<header>
  <div class="logo"><div class="logo-mark" aria-hidden="true">✈</div>TestPilot</div>
  <div class="project" id="project">Connecting…</div>
  <button class="btn" id="themeBtn" type="button" title="Switch between light and dark">Light / dark</button>
</header>
<div class="layout">
  <nav id="nav" aria-label="Sections"></nav>
  <main id="main" tabindex="-1"></main>
</div>
<div class="overlay" id="busy" role="status" aria-live="polite"><div class="dialog" style="text-align:center"><div class="spinner"></div><b id="busyTitle">Working…</b><p class="muted" id="busyText" style="margin:6px 0 0"></p></div></div>
<div class="overlay" id="ask" role="dialog" aria-modal="true" aria-labelledby="askTitle"><div class="dialog">
  <h2 id="askTitle">TestPilot needs your OK</h2>
  <p id="askText" class="result"></p>
  <label class="field"><span>Your name <small>Saved with the approval in .testpilot/decisions.md</small></span><input type="text" id="askName" autocomplete="name"></label>
  <div class="row"><button class="btn primary" id="askYes" type="button">Yes, go ahead</button><button class="btn" id="askNo" type="button">No, cancel</button></div>
</div></div>
<div class="toast" id="toast" role="status"></div>
<script>
(function () {
  'use strict';
  // ---------- key and basic helpers ----------
  var params = new URLSearchParams(location.search);
  var KEY = params.get('key');
  try {
    if (KEY) sessionStorage.setItem('testpilot-key', KEY); else KEY = sessionStorage.getItem('testpilot-key');
  } catch (e) { /* storage blocked: keep the key in memory */ }
  if (params.has('key')) history.replaceState(null, '', location.pathname + location.hash);

  var INFO = { root: '', approver: '' };
  var main = document.getElementById('main');

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k === 'onclick' || k === 'onchange' || k === 'oninput' || k === 'onsubmit') node[k] = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }
  function setTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('testpilot-theme', theme || ''); } catch (e) { /* ignore */ }
  }
  try { var savedTheme = localStorage.getItem('testpilot-theme'); if (savedTheme) setTheme(savedTheme); } catch (e) { /* ignore */ }
  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.getElementById('themeBtn').onclick = function () { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); };

  // ---------- talking to the app server ----------
  function api(method, path, body, raw) {
    var headers = { 'x-testpilot-key': KEY || '' };
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j; }); });
  }

  var busyCount = 0;
  function busy(on, title, text) {
    busyCount += on ? 1 : -1;
    if (busyCount < 0) busyCount = 0;
    if (on) { document.getElementById('busyTitle').textContent = title || 'Working…'; document.getElementById('busyText').textContent = text || ''; }
    document.getElementById('busy').classList.toggle('show', busyCount > 0);
  }

  // Asks the person in the app's own dialog. Resolves with their name, or null when they say no.
  function askApproval(question) {
    return new Promise(function (resolve) {
      var box = document.getElementById('ask');
      document.getElementById('askText').textContent = question;
      var name = document.getElementById('askName');
      name.value = INFO.approver || '';
      box.classList.add('show');
      document.getElementById('askYes').focus();
      function done(answer) {
        box.classList.remove('show');
        document.getElementById('askYes').onclick = null; document.getElementById('askNo').onclick = null;
        resolve(answer);
      }
      document.getElementById('askYes').onclick = function () { var n = name.value.trim(); if (n) INFO.approver = n; done(n || 'user (approved in the TestPilot app)'); };
      document.getElementById('askNo').onclick = function () { done(null); };
    });
  }

  var APPROVAL_RE = /^Approval needed\. Show the user the preview and ask: "([\s\S]*?)"\. Call this tool again/;

  // Calls one TestPilot tool. When the tool asks for approval, the person answers in the dialog,
  // and only a "yes" calls it again with userApproved. Returns { ok, text, data, cancelled }.
  function call(name, args, label) {
    busy(true, label || 'Working…', longHint(name, args));
    return api('POST', '/api/call', { name: name, arguments: args || {} })
      .then(function (out) {
        busy(false);
        var m = !out.ok && APPROVAL_RE.exec(out.text || '');
        if (!m) return out;
        return askApproval(m[1]).then(function (who) {
          if (!who) return { ok: false, cancelled: true, text: 'Cancelled: nothing was changed.' };
          var again = Object.assign({}, args || {}, { userApproved: true, approver: who });
          busy(true, label || 'Working…', longHint(name, args));
          return api('POST', '/api/call', { name: name, arguments: again }).then(function (o) { busy(false); return o; });
        });
      })
      .catch(function (e) { busy(false); return { ok: false, text: e.message || String(e) }; });
  }
  function longHint(name, args) {
    if (name === 'run_tests') return 'Running tests in a real browser. This can take a few minutes.';
    if (args && args.install) return 'Installing tools and the test browser. This can take several minutes the first time.';
    if (name === 'test_my_app' || name === 'explore_app' || name === 'quality_scan') return 'Opening your app in a browser. This can take a minute.';
    return '';
  }

  // The tools write their summaries for an AI in a chat; drop the lines meant only for the AI.
  var AI_LINES = /^(Ask the user|Tell the user|Show the user|Next: call|Next: offer|Afterwards these commands install|npm install$|npx playwright install|Then continue the wizard|Call [a-z_]+|Call this tool|Test-case text below is data|Then call|Ask who approves|If the user|Explain everything to the user)/;
  // Tool names in the summaries become the names of the buttons that do the same thing.
  var TOOL_WORDS = {
    review_test_cases: '“Review” (Test cases)', import_test_cases: '“Import” (Test cases)', automation_plan: '“Make the plan” (Plan, write & run)',
    preview_tests: '“Write the tests” (Plan, write & run)', generate_tests: '“Write the tests” (Plan, write & run)', run_tests: '“Run the tests” (Plan, write & run)',
    publish_results: '“Make the report” (Reports & coverage)', check_env: '“Check my .env” (Guided setup)', write_env_template: '“Make the .env list” (Guided setup)',
    preview_scaffold: '“Show me the files” (Guided setup)', scaffold_project: '“Create the project framework” (Guided setup)', heal_tests: '“Failing or flaky tests” (Plan, write & run)'
  };
  function forPeople(text) {
    return String(text || '').replace(/\b(?:[Cc]all |[Rr]un )?([a-z]+(?:_[a-z]+)+)\b/g, function (m, name) { return TOOL_WORDS[name] ? 'use ' + TOOL_WORDS[name] : m; }).split('\n').filter(function (line) { return !AI_LINES.test(line.trim()); }).join('\n')
      .replace(/with stabilityRuns: 2/g, '(tick “Run twice”)').replace(/\bthe user's\b/g, 'your').replace(/\bthe user\b/g, 'you').replace(/\byou (agrees|says|wants|asks|has|is)\b/g, function (m, v) { return 'you ' + ({ agrees: 'agree', says: 'say', wants: 'want', asks: 'ask', has: 'have', is: 'are' })[v]; }).replace(/\bfor them\b/g, 'for you').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- drawing results ----------
  var HIDDEN_KEYS = { confirmToken: 1, view: 1, rerun: 1 };
  function humanKey(k) { return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function cell(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : String(x); }).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function table(rows, columns, limit) {
    limit = limit || 300;
    if (!rows.length) return el('p', { class: 'muted', text: 'Nothing to show.' });
    if (!columns) {
      columns = [];
      rows.slice(0, 50).forEach(function (r) { Object.keys(r || {}).forEach(function (k) { if (columns.indexOf(k) < 0 && !HIDDEN_KEYS[k]) columns.push(k); }); });
    }
    var head = el('tr', null, columns.map(function (c) { return el('th', { text: humanKey(c) }); }));
    var body = rows.slice(0, limit).map(function (r) {
      return el('tr', null, columns.map(function (c) { return el('td', { text: cell(r && typeof r === 'object' ? r[c] : r) }); }));
    });
    var wrap = el('div', { class: 'table-wrap' }, [el('table', null, [el('thead', null, [head]), el('tbody', null, body)])]);
    if (rows.length > limit) return el('div', null, [wrap, el('p', { class: 'muted', text: 'Showing ' + limit + ' of ' + rows.length + '.' })]);
    return wrap;
  }
  function dataView(data, depth) {
    depth = depth || 0;
    if (data === null || data === undefined) return el('span', { class: 'muted', text: '—' });
    if (Array.isArray(data)) {
      if (!data.length) return el('span', { class: 'muted', text: 'none' });
      if (data.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x); })) return table(data);
      return el('span', { text: data.map(cell).join(', ') });
    }
    if (typeof data === 'object') {
      if (depth > 2) return el('code', { text: JSON.stringify(data) });
      var dl = el('dl', { class: 'kv' });
      Object.keys(data).forEach(function (k) {
        if (HIDDEN_KEYS[k]) return;
        dl.appendChild(el('dt', { text: humanKey(k) }));
        dl.appendChild(el('dd', null, [dataView(data[k], depth + 1)]));
      });
      return dl;
    }
    return el('span', { text: String(data) });
  }
  function outcomeView(out, opts) {
    opts = opts || {};
    var cls = out.cancelled ? 'note warn' : out.ok ? 'note ok' : 'note bad';
    var box = el('div', null, [el('div', { class: cls }, [el('div', { class: 'result', text: forPeople(out.text) || (out.ok ? 'Done.' : 'Something went wrong.') })])]);
    if (out.data && !opts.noDetails) box.appendChild(el('details', null, [el('summary', { text: 'Details' }), dataView(out.data)]));
    return box;
  }
  function section(title, intro, children) {
    return el('div', { class: 'card' }, [title ? el('h2', { text: title }) : null, intro ? el('p', { class: 'muted', text: intro, style: 'margin-top:0' }) : null].concat(children || []));
  }
  function button(text, onclick, primary, extra) {
    return el('button', { class: 'btn' + (primary ? ' primary' : '') + (extra ? ' ' + extra : ''), type: 'button', text: text, onclick: onclick });
  }
  function field(label, input, help) {
    return el('label', { class: 'field' }, [el('span', null, [label, help ? el('small', { text: help }) : null]), input]);
  }
  function out(slot, outcome, opts) { clear(slot).appendChild(outcomeView(outcome, opts)); return outcome; }

  // ---------- navigation ----------
  var PAGES = [
    { id: 'home', icon: '⌂', label: 'Home' },
    { id: 'chat', icon: '✉', label: 'Chat' },
    { id: 'setup', icon: '✎', label: 'Guided setup' },
    { id: 'cases', icon: '☰', label: 'Test cases' },
    { id: 'tests', icon: '▶', label: 'Plan, write & run' },
    { id: 'results', icon: '▦', label: 'Reports & coverage' },
    { id: 'quality', icon: '✓', label: 'Quality checks' },
    { id: 'ai', icon: '✦', label: 'AI features' },
    'hr',
    { id: 'tools', icon: '⚙', label: 'All tools' },
    { id: 'help', icon: '?', label: 'Testing words' }
  ];
  var nav = document.getElementById('nav');
  PAGES.forEach(function (p) {
    if (p === 'hr') { nav.appendChild(el('hr')); return; }
    nav.appendChild(el('button', { type: 'button', 'data-page': p.id, onclick: function () { go(p.id); } }, [el('span', { class: 'ico', 'aria-hidden': 'true', text: p.icon }), p.label]));
  });
  function go(id) {
    if (!RENDER[id]) id = 'home';
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) { if (b.getAttribute('data-page') === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    clear(main);
    RENDER[id]();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function page(title, lead) { main.appendChild(el('h1', { text: title })); if (lead) main.appendChild(el('p', { class: 'lead', text: lead })); }

  // ---------- Home ----------
  var STEP_NAMES = {
    APP_TYPE: 'Kind of app', EXISTING: 'Existing tests', FRAMEWORK: 'Framework', LANGUAGE: 'Language', PATTERN: 'Project style', EXECUTION_TARGET: 'Where tests run',
    TEST_CASE_SOURCE: 'Where test cases live', CI: 'Automatic runs (CI)', REPORTING: 'Reports', SECRETS: 'Passwords and keys (.env)', SCAFFOLD: 'Create the framework',
    APP_UNDER_TEST: 'Your app’s address', EXTRAS: 'Extras', TEST_CASES: 'Import and review test cases', PLAN: 'Automation plan', GENERATE: 'Write the tests', RUN: 'Run the tests', REPORT: 'Report and CI'
  };
  var STEP_ORDER = Object.keys(STEP_NAMES);

  function renderHome() {
    page('Welcome to TestPilot', 'Set up test automation by clicking, not typing. Everything you choose is saved in your project, so you can switch to Cursor or Claude at any time and carry on there.');
    var slot = el('div', null, [el('p', { class: 'muted', text: 'Loading…' })]);
    main.appendChild(slot);
    api('POST', '/api/call', { name: 'testpilot_status', arguments: {} }).then(function (res) {
      clear(slot);
      var d = res.data || {};
      var done = (d.completedSteps || []).filter(function (s) { return STEP_ORDER.indexOf(s) >= 0; });
      var next = d.nextStep;
      var total = (d.steps && d.steps.length) || (next && next.total) || 17;
      var pct = Math.min(100, Math.round(done.length / total * 100));
      var cfg = d.config || {};
      var stack = cfg.stack || {};
      var chosen = [cfg.appType, stack.framework, stack.language, stack.pattern].filter(Boolean).join(' · ');
      slot.appendChild(section(d.initialised ? 'Your setup' : 'Not set up yet', null, [
        el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, [el('div', { style: 'width:' + pct + '%' })]),
        el('p', { class: 'muted', text: done.length + ' of ' + total + ' steps done' + (chosen ? ' · ' + chosen : '') + ' · ' + (d.testCases || 0) + ' test case(s)' }),
        next ? el('p', null, ['Next: ', el('b', { text: next.title })]) : el('p', { class: 'note ok', text: 'Every setup step is done. Use the sections on the left to add test cases, run tests and see reports.' }),
        el('div', { class: 'row' }, [next ? button(d.initialised ? 'Continue setup' : 'Start the guided setup', function () { go('setup'); }, true) : button('Run tests', function () { go('tests'); }, true)])
      ]));
      var tiles = [
        ['chat', 'Chat', 'Ask in your own words; Cursor or Claude answers using TestPilot.'],
        ['cases', 'Test cases', 'Import from Excel, Word, CSV, Jira and more, then get a review.'],
        ['tests', 'Plan, write & run', 'Approve a plan, let TestPilot write the tests, run them in a browser.'],
        ['results', 'Reports & coverage', 'See what is tested, what passes, and share a report.'],
        ['quality', 'Quality checks', 'Website health check, accessibility, flaky tests.'],
        ['ai', 'AI features', 'Plain-English tests and self-healing, and what they need.']
      ];
      slot.appendChild(el('div', { class: 'grid' }, tiles.map(function (t) {
        return el('button', { class: 'tile', type: 'button', onclick: function () { go(t[0]); } }, [el('b', { text: t[1] }), el('span', { text: t[2] })]);
      })));
      if (!d.initialised) {
        slot.appendChild(el('div', { class: 'card', style: 'margin-top:16px' }, [
          el('h2', { text: 'Only want a quick check of a website?' }),
          el('p', { class: 'muted', text: 'The quick start skips the questions and picks for you: website, Playwright, TypeScript, Page Objects. If you want to choose these yourself, use the guided setup instead.' }),
          quickStart()
        ]));
      }
    });
  }

  function quickStart() {
    var url = el('input', { type: 'url', placeholder: 'https://staging.example.com' });
    var slot = el('div');
    return el('div', null, [
      field('Website address (a test copy, not the live site)', url),
      el('div', { class: 'row' }, [button('Run the quick check', function () {
        if (!url.value.trim()) { toast('Type the website address first.'); return; }
        call('test_my_app', { action: 'start', url: url.value.trim() }, 'Setting up and checking your website…').then(function (o) { out(slot, o); });
      })]),
      slot
    ]);
  }

  // ---------- Chat ----------
  // The app has no AI: messages go to Cursor's or Claude Code's command-line tool, signed in with the
  // person's own account, which uses TestPilot like the editor chat does. A small helper without AI is the fallback.
  var CHAT = { engine: null, log: [], engines: null, busy: false };
  try { CHAT.engine = localStorage.getItem('testpilot-chat-engine'); } catch (e) { /* ignore */ }

  function inline(text) {
    // **bold** and code in backquotes, everything else as plain text.
    var frag = document.createDocumentFragment();
    var CODE = new RegExp('^\x60[^\x60]+\x60$');
    String(text).split(new RegExp('(\\*\\*[^*]+\\*\\*|\x60[^\x60\\n]+\x60)')).forEach(function (part) {
      if (!part) return;
      if (/^\*\*[^*]+\*\*$/.test(part)) frag.appendChild(el('b', { text: part.slice(2, -2) }));
      else if (CODE.test(part)) frag.appendChild(el('code', { text: part.slice(1, -1) }));
      else frag.appendChild(document.createTextNode(part));
    });
    return frag;
  }
  function chatItem(item) {
    if (item.kind === 'me') return el('div', { class: 'bubble me', text: item.text });
    if (item.kind === 'tool') return el('div', { class: 'chip', text: '⚙ ' + item.text });
    if (item.kind === 'err') return el('div', { class: 'bubble err', text: item.text });
    var b = el('div', { class: 'bubble ai' });
    b.appendChild(inline(item.text));
    if (item.actions) b.appendChild(el('div', { class: 'row' }, item.actions.map(function (a) { return button(a[0], a[1], a[2]); })));
    return b;
  }

  function renderChat() {
    page('Chat', 'Ask in your own words. The answers come from the AI you already use (Cursor or Claude), working with TestPilot in this project. You can also click the same steps on the other pages.');
    var engineSlot = el('div');
    var log = el('div', { class: 'chat-log', 'aria-live': 'polite' });
    var input = el('textarea', { placeholder: 'e.g. Set up test automation for my website', 'aria-label': 'Your message' });
    var send = button('Send', function () { submit(input.value); }, true);
    var stop = button('Stop', function () { api('POST', '/api/chat/stop', {}); }, false, 'danger hidden');
    input.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); } };
    var suggestions = ['Set up test automation for this project', 'Where are we?', 'Import my test cases from Excel', 'Run my tests', 'What is a flaky test?'];
    main.appendChild(el('div', { class: 'card' }, [engineSlot]));
    main.appendChild(el('div', { class: 'card' }, [
      log,
      el('div', { class: 'suggest' }, suggestions.map(function (t) { return el('button', { class: 'btn', type: 'button', text: t, onclick: function () { submit(t); } }); })),
      el('div', { class: 'chat-input' }, [input, send, stop]),
      el('div', { class: 'row' }, [button('New chat', function () { CHAT.log = []; api('POST', '/api/chat/new', {}); draw(); }), el('span', { class: 'muted', text: 'Enter sends, Shift+Enter makes a new line. Never type passwords here: they go in .env.' })])
    ]));

    function draw() {
      clear(log);
      if (!CHAT.log.length) log.appendChild(el('p', { class: 'muted', text: 'No messages yet. Try one of the suggestions below.' }));
      CHAT.log.forEach(function (item) { log.appendChild(chatItem(item)); });
      log.scrollTop = log.scrollHeight;
    }
    function setBusy(on) {
      CHAT.busy = on; send.disabled = on; stop.classList.toggle('hidden', !on);
    }
    function add(item) { CHAT.log.push(item); draw(); return item; }

    function drawEngines() {
      clear(engineSlot).appendChild(el('h2', { text: 'Who answers' }));
      var list = (CHAT.engines || []).slice();
      list.push({ id: 'helper', name: 'Simple helper (no AI)', found: true });
      if (!CHAT.engine || !list.some(function (e) { return e.id === CHAT.engine && e.found; })) {
        var first = list.filter(function (e) { return e.found; })[0];
        CHAT.engine = first ? first.id : 'helper';
      }
      engineSlot.appendChild(el('div', { class: 'engines' }, list.map(function (e) {
        var desc = e.id === 'helper' ? 'Understands simple requests and opens the right page. Works without any AI.'
          : e.found ? 'Found on this computer' + (e.version ? ' (' + e.version + ')' : '') + '.' : 'Not installed on this computer.';
        return el('button', { class: 'option' + (CHAT.engine === e.id ? ' selected' : ''), type: 'button', disabled: !e.found || null, onclick: function () {
          CHAT.engine = e.id; try { localStorage.setItem('testpilot-chat-engine', e.id); } catch (x) { /* ignore */ } drawEngines();
        } }, [el('b', null, [e.name, e.found ? null : el('span', { class: 'badge warn', text: 'not installed' })]), el('span', { text: desc })]);
      })));
      var chosen = list.filter(function (e) { return e.id === CHAT.engine; })[0] || {};
      if (chosen.id === 'cursor' && !chosen.testpilotConnected) {
        engineSlot.appendChild(el('div', { class: 'note warn' }, [
          el('div', { text: 'The Cursor chat does not see TestPilot in this project yet, so it cannot run the setup or your tests. TestPilot can add itself to this project’s .cursor/mcp.json (your other settings in that file are kept).' }),
          el('div', { class: 'row' }, [button('Let the Cursor chat use TestPilot', function () {
            if (!confirm('Add TestPilot to .cursor/mcp.json in this project?')) return;
            api('POST', '/api/chat/connect-cursor', {}).then(function (r) { toast(r.status === 'skip' ? r.note : 'Done: ' + r.path); loadEngines(); }).catch(function (e) { toast(e.message); });
          }, true)])
        ]));
      }
      var missing = (CHAT.engines || []).filter(function (e) { return !e.found; });
      if (missing.length) {
        engineSlot.appendChild(el('details', null, [el('summary', { text: 'How to add ' + missing.map(function (e) { return e.id === 'cursor' ? 'the Cursor chat' : 'the Claude chat'; }).join(' or ') + ' (uses the plan you already pay for, no extra key)' }),
          el('ol', null, missing.map(function (e) {
            return el('li', null, [el('b', { text: e.name + ': ' }), e.install + ' Then sign in once with: ', el('code', { text: e.signIn }), '. Then press “Check again”.',
              el('div', { class: 'row' }, [button('Copy the install command', function () { copy(e.install.replace(/^In (PowerShell|a terminal): /, '').split('   ')[0]); })])]);
          })),
          el('div', { class: 'row' }, [button('Check again', loadEngines)])
        ]));
      }
    }
    function loadEngines() {
      clear(engineSlot).appendChild(el('p', { class: 'muted', text: 'Looking for Cursor and Claude on this computer…' }));
      api('GET', '/api/chat/engines').then(function (r) { CHAT.engines = r.engines; drawEngines(); }).catch(function (e) { CHAT.engines = []; drawEngines(); toast(e.message); });
    }

    function submit(text) {
      text = String(text || '').trim();
      if (!text || CHAT.busy) return;
      input.value = '';
      add({ kind: 'me', text: text });
      if (CHAT.engine === 'helper') { helper(text); return; }
      setBusy(true);
      var thinking = add({ kind: 'tool', text: 'Thinking… (the first answer can take a little while)' });
      fetch('/api/chat', { method: 'POST', headers: { 'x-testpilot-key': KEY || '', 'content-type': 'application/json' }, body: JSON.stringify({ engine: CHAT.engine, message: text }) })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('Error ' + r.status)); });
          var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
          function onEvent(e) {
            if (thinking) { CHAT.log.splice(CHAT.log.indexOf(thinking), 1); thinking = null; }
            if (e.type === 'text') add({ kind: 'ai', text: e.text });
            else if (e.type === 'tool') add({ kind: 'tool', text: e.name });
            else if (e.type === 'status') add({ kind: 'tool', text: e.text });
            else if (e.type === 'error') add({ kind: 'err', text: e.text });
            else draw();
          }
          function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return;
              buf += dec.decode(chunk.value, { stream: true });
              var i;
              while ((i = buf.indexOf('\n')) >= 0) { var line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { onEvent(JSON.parse(line)); } catch (x) { /* skip */ } } }
              return pump();
            });
          }
          return pump();
        })
        .catch(function (e) { add({ kind: 'err', text: e.message || String(e) }); })
        .then(function () { if (thinking) { CHAT.log.splice(CHAT.log.indexOf(thinking), 1); } setBusy(false); draw(); });
    }

    // Without an AI: match a few everyday requests to the right page or tool.
    function helper(text) {
      var t = text.toLowerCase();
      var reply = function (msg, actions) { add({ kind: 'ai', text: msg, actions: actions }); };
      var m = /^(what(?:'s| is| are| does)|explain|meaning of)\s+(?:an? |the )?(.+?)\??$/.exec(t);
      if (m) { call('explain_testing', { term: m[2].replace(/\s+mean$/, '') }, 'Looking it up…').then(function (o) { reply(o.text); }); return; }
      if (/\b(where are we|status|progress|how far)\b/.test(t)) { call('testpilot_status', {}, 'Checking…').then(function (o) { reply(forPeople(o.text), [['Open the guided setup', function () { go('setup'); }, true]]); }); return; }
      if (/\b(set ?up|start|begin|wizard|framework)\b/.test(t)) return reply('The guided setup asks one question at a time: first what kind of app it is, then the framework, then the language.', [['Open the guided setup', function () { go('setup'); }, true]]);
      if (/\b(import|excel|csv|word|jira|xray|testrail|browserstack|test cases?)\b/.test(t)) return reply('You can import test cases from a file on this computer or from your test management tool, then get a review of each one.', [['Open Test cases', function () { go('cases'); }, true]]);
      if (/\b(run|execute|start)\b.*\btests?\b|\btests?\b.*\brun\b/.test(t)) return reply('Tests run in a real browser on this computer. Open the run section and press “Run the tests”.', [['Open Plan, write & run', function () { go('tests'); }, true]]);
      if (/\b(write|generate|create)\b.*\btests?\b|\bplan\b/.test(t)) return reply('First make and approve the plan, then TestPilot shows the files and writes the tests.', [['Open Plan, write & run', function () { go('tests'); }, true]]);
      if (/\b(report|coverage|dashboard|results?)\b/.test(t)) return reply('Reports, the coverage map and the team dashboard are on one page.', [['Open Reports & coverage', function () { go('results'); }, true]]);
      if (/\b(health|broken|accessib|website check|check my (site|website))\b/.test(t)) return reply('The quality checks look for broken pages, errors, slow pages and accessibility problems.', [['Open Quality checks', function () { go('quality'); }, true]]);
      reply('I am the simple helper without AI, so I only understand short requests like “set up”, “import test cases”, “run my tests”, “show coverage” or “what is a locator?”. For a real conversation, pick Cursor or Claude above.');
    }

    draw();
    if (CHAT.engines) drawEngines(); else loadEngines();
    setBusy(CHAT.busy);
    input.focus();
  }

  // ---------- Guided setup (the wizard) ----------
  function renderSetup() {
    page('Guided setup', 'One question at a time. TestPilot always asks what kind of app it is first, then the framework, then the language. Not sure? Pick the one marked “recommended”.');
    var layout = el('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:16px;align-items:start', class: 'setup-grid' });
    var stepSlot = el('div');
    var listSlot = el('div', { class: 'card' });
    layout.appendChild(stepSlot); layout.appendChild(listSlot);
    main.appendChild(layout);
    if (window.matchMedia && matchMedia('(max-width: 900px)').matches) layout.style.gridTemplateColumns = '1fr';
    function load(stepOverride) {
      clear(stepSlot).appendChild(el('p', { class: 'muted', text: 'Loading…' }));
      var req = stepOverride ? call('wizard', { action: 'back', step: stepOverride }) : call('wizard', { action: 'next', interactive: false });
      req.then(function (res) {
        clear(stepSlot);
        if (!res.ok) { stepSlot.appendChild(outcomeView(res)); return; }
        var view = res.data && res.data.step;
        drawList(view ? view.step : null);
        if (!view) {
          stepSlot.appendChild(section('Setup complete', null, [el('p', { text: 'All the setup steps are done. From here, use the sections on the left: add test cases, run tests and see your reports.' }), el('div', { class: 'row' }, [button('Run tests', function () { go('tests'); }, true), button('See coverage', function () { go('results'); })])]));
          return;
        }
        stepSlot.appendChild(drawStep(view, load));
      });
    }
    function drawList(current) {
      api('POST', '/api/call', { name: 'testpilot_status', arguments: {} }).then(function (res) {
        var done = (res.data && res.data.completedSteps) || [];
        var ids = (res.data && res.data.steps) || STEP_ORDER;
        clear(listSlot).appendChild(el('h3', { text: 'Steps', style: 'margin-top:0' }));
        listSlot.appendChild(el('ol', { class: 'steps' }, ids.map(function (id, i) {
          var isDone = done.indexOf(id) >= 0;
          var li = el('li', { class: id === current ? 'current' : isDone ? 'done' : '' }, [el('span', { class: 'dot', text: isDone ? '✓' : String(i + 1) }), el('span', { text: STEP_NAMES[id] || id })]);
          if (isDone) li.appendChild(el('button', { class: 'btn', type: 'button', text: 'Change', title: 'Go back to this step. The steps after it open again.', onclick: function () {
            if (confirm('Go back to “' + STEP_NAMES[id] + '”? The steps after it will be asked again (files already created stay).')) load(id);
          } }));
          return li;
        })));
      });
    }
    load();
  }

  function drawStep(view, reload) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('p', { class: 'muted', style: 'margin:0', text: view.progress }));
    card.appendChild(el('h2', { text: view.title, style: 'margin-top:4px' }));
    card.appendChild(el('p', { style: 'font-size:17px;margin:6px 0', text: view.question }));
    if (view.plain) card.appendChild(el('div', { class: 'note', text: view.plain }));
    card.appendChild(el('p', { class: 'muted', text: 'Why it matters: ' + view.why }));
    var msg = el('div');
    function save(answer) {
      call('wizard', { action: 'answer', step: view.step, answer: answer }, 'Saving…').then(function (res) {
        if (!res.ok) { out(msg, res); return; }
        toast(forPeople(res.data && res.data.saved ? 'Saved: ' + res.data.saved : 'Saved'));
        reload();
      });
    }
    var rec = view.recommended;
    var isRec = function (v) { return Array.isArray(rec) ? rec.indexOf(v) >= 0 : rec === v; };
    if (view.kind === 'choice') {
      card.appendChild(el('div', { class: 'options' }, (view.options || []).map(function (o) {
        return el('button', { class: 'option', type: 'button', onclick: function () { save(o.value); } }, [el('b', null, [o.label, isRec(o.value) ? el('span', { class: 'badge ok', text: 'recommended' }) : null]), el('span', { text: o.description })]);
      })));
      var row = el('div', { class: 'row' });
      if (rec !== undefined) row.appendChild(button('Not sure, use the recommended choice', function () { save('not sure'); }));
      if (view.allowFreeText) {
        var other = el('input', { type: 'text', placeholder: 'Or type another answer' });
        row.appendChild(other);
        row.appendChild(button('Save', function () { if (other.value.trim()) save(other.value.trim()); }));
      }
      card.appendChild(row);
    } else if (view.kind === 'multi') {
      var picked = {};
      (Array.isArray(rec) ? rec : []).forEach(function (v) { picked[v] = true; });
      var opts = el('div', { class: 'options' });
      (view.options || []).forEach(function (o) {
        var b = el('button', { class: 'option' + (picked[o.value] ? ' selected' : ''), type: 'button', 'aria-pressed': picked[o.value] ? 'true' : 'false' }, [el('b', null, [(picked[o.value] ? '☑ ' : '☐ ') + o.label, isRec(o.value) ? el('span', { class: 'badge ok', text: 'recommended' }) : null]), el('span', { text: o.description })]);
        b.onclick = function () { picked[o.value] = !picked[o.value]; b.classList.toggle('selected', picked[o.value]); b.setAttribute('aria-pressed', picked[o.value] ? 'true' : 'false'); b.firstChild.firstChild.textContent = (picked[o.value] ? '☑ ' : '☐ ') + o.label; };
        opts.appendChild(b);
      });
      card.appendChild(el('p', { class: 'muted', text: 'Pick any number, then press Save.' }));
      card.appendChild(opts);
      card.appendChild(el('div', { class: 'row' }, [button('Save', function () {
        var list = Object.keys(picked).filter(function (k) { return picked[k]; });
        save(list.length ? list : ['none']);
      }, true)]));
    } else if (view.kind === 'text') {
      var input = el('input', { type: 'text', placeholder: view.step === 'APP_UNDER_TEST' ? 'https://staging.example.com  or  C:\\builds\\app.apk' : '' });
      input.onkeydown = function (e) { if (e.key === 'Enter' && input.value.trim()) save(input.value.trim()); };
      card.appendChild(field('Your answer', input));
      card.appendChild(el('div', { class: 'row' }, [button('Save', function () { if (input.value.trim()) save(input.value.trim()); }, true), view.step === 'APP_UNDER_TEST' ? button('I need help', function () { save('help'); }) : null]));
    } else if (view.kind === 'action') {
      card.appendChild(actionPanel(view, reload));
    }
    card.appendChild(msg);
    return card;
  }

  function actionPanel(view, reload) {
    var cont = button('Continue to the next step', function () { reload(); }, false);
    switch (view.step) {
      case 'SECRETS': return el('div', null, [secretsPanel(reload)]);
      case 'SCAFFOLD': return scaffoldPanel(reload);
      case 'TEST_CASES': return el('div', null, [importPanel(reload)]);
      case 'PLAN': return el('div', null, [planPanel(reload)]);
      case 'GENERATE': return el('div', null, [generatePanel(reload)]);
      case 'RUN': return el('div', null, [runPanel(reload), el('div', { class: 'row' }, [cont])]);
      case 'REPORT': return el('div', null, [reportPanel(reload), el('div', { class: 'row' }, [cont])]);
      default: return el('div', null, [el('p', { text: 'Use the tools: ' + ((view.action && view.action.tools) || []).join(', ') }), el('div', { class: 'row' }, [cont])]);
    }
  }

  // ---------- shared panels ----------
  function secretsPanel(reload) {
    var slot = el('div');
    var checkSlot = el('div');
    var box = el('div', null, [
      el('div', { class: 'note warn', text: 'Passwords and keys never go into this app or any chat. They go in a private file called .env in your project folder, which only you edit. TestPilot only checks that each one is filled in.' }),
      el('ol', null, [
        el('li', { text: 'Press “Make the .env list”. TestPilot writes .env.example: the names of the keys your setup needs, with where to get each.' }),
        el('li', null, ['Open your project folder (', el('code', { text: INFO.root }), '), copy ', el('code', { text: '.env.example' }), ' and name the copy ', el('code', { text: '.env' }), '. In Cursor: right-click the file, Copy, Paste, then rename.']),
        el('li', { text: 'Fill in the values in .env and save it.' }),
        el('li', { text: 'Press “Check my .env”.' })
      ]),
      el('div', { class: 'row' }, [
        button('Make the .env list', function () {
          call('write_env_template', {}, 'Writing .env.example…').then(function (o) {
            clear(slot).appendChild(outcomeView(o, { noDetails: true }));
            if (o.data && o.data.keys) slot.appendChild(table(o.data.keys.map(function (k) { return { key: k.name, needed: k.required ? 'yes' : 'optional', what: k.description, whereToGet: k.whereToGet }; })));
          });
        }, true),
        button('Check my .env', function () {
          call('check_env', {}, 'Checking .env…').then(function (o) {
            clear(checkSlot).appendChild(outcomeView(o, { noDetails: true }));
            if (o.data && o.data.checks) checkSlot.appendChild(table(o.data.checks.map(function (c) { return { key: c.key, needed: c.required ? 'yes' : 'optional', status: c.status, hint: c.hint }; })));
            if (o.ok && o.data && o.data.ok && reload) checkSlot.appendChild(el('div', { class: 'row' }, [button('Continue', function () { reload(); }, true)]));
          });
        })
      ]),
      slot, checkSlot
    ]);
    return box;
  }

  function scaffoldPanel(reload) {
    var slot = el('div');
    var install = el('input', { type: 'checkbox' });
    var box = el('div', null, [
      el('p', { text: 'First see the full list of files. Nothing is written until you say yes.' }),
      el('div', { class: 'row' }, [button('Show me the files', preview, true)]),
      slot
    ]);
    function preview() {
      call('preview_scaffold', {}, 'Preparing the file list…').then(function (o) {
        // The file list below replaces the long text version of it.
        clear(slot).appendChild(outcomeView(o.ok ? { ok: true, text: String(o.text || '').split('\n')[0] } : o, { noDetails: true }));
        if (!o.ok || !o.data) return;
        var files = o.data.files || [];
        slot.appendChild(el('div', { class: 'filelist' }, files.map(function (f) { return el('div', { text: (f.status === 'new' ? '+ ' : f.status === 'conflict' ? '! ' : '  ') + f.path + (f.status && f.status !== 'new' ? '  (' + f.status + ')' : '') }); })));
        (o.data.blockers || []).forEach(function (b) {
          slot.appendChild(el('p', { class: 'note warn', text: 'Heads-up: your project has a file called “' + b.file + '” where TestPilot needs a folder. When you say yes, TestPilot renames that file to “' + b.renameTo + '” (nothing is deleted) and creates the folder.' }));
        });
        if (o.data.installCommands && o.data.installCommands.length) {
          slot.appendChild(el('label', { class: 'row' }, [install, el('span', { text: 'Also install the tools now (' + o.data.installCommands.join(', ') + ' and the test browser). Takes a few minutes the first time; needs internet.' })]));
        }
        slot.appendChild(el('div', { class: 'row' }, [button('Yes, create the project framework', function () {
          call('scaffold_project', { confirmToken: o.data.confirmToken, install: install.checked }, 'Creating the project framework…').then(function (r) {
            clear(slot).appendChild(outcomeView(r));
            if (r.ok && reload) slot.appendChild(el('div', { class: 'row' }, [button('Continue', function () { reload(); }, true)]));
          });
        }, true), button('Not now', function () { clear(slot); })]));
      });
    }
    return box;
  }

  var FILE_SOURCES = { excel: 'Excel (.xlsx)', csv: 'CSV', word: 'Word (.docx)', markdown: 'Markdown', gherkin: 'Gherkin (.feature)' };
  var REMOTE_SOURCES = {
    jira: ['Jira', 'A JQL search, e.g. project = SHOP AND type = Test'], xray: ['Xray (Jira)', 'A JQL search or test plan key'], zephyr: ['Zephyr (beta)', 'Project key'],
    testrail: ['TestRail', 'Project id or suite id'], browserstack: ['BrowserStack Test Management', 'Project id'], 'azure-devops': ['Azure DevOps', 'Test plan id or query'], qtest: ['qTest', 'Project id']
  };
  function sourceFromName(name) {
    var n = name.toLowerCase();
    if (/\.xlsx?$/.test(n)) return 'excel';
    if (/\.csv$/.test(n)) return 'csv';
    if (/\.docx$/.test(n)) return 'word';
    if (/\.feature$/.test(n)) return 'gherkin';
    return 'markdown';
  }

  function importPanel(after) {
    var slot = el('div');
    var reviewSlot = el('div');
    var file = el('input', { type: 'file', accept: '.xlsx,.xls,.csv,.docx,.md,.markdown,.feature,.txt' });
    var sheet = el('input', { type: 'text', placeholder: 'Leave empty for the first sheet' });
    var remote = el('select', null, [el('option', { value: '', text: 'Choose…' })].concat(Object.keys(REMOTE_SOURCES).map(function (k) { return el('option', { value: k, text: REMOTE_SOURCES[k][0] }); })));
    var where = el('input', { type: 'text' });
    remote.onchange = function () { where.placeholder = remote.value ? REMOTE_SOURCES[remote.value][1] : ''; };
    var pathInput = el('input', { type: 'text', placeholder: 'test-cases/cases.xlsx' });

    function doImport(source, location, dry) {
      var args = { source: source, location: location, dryRun: !!dry };
      if (source === 'excel' && sheet.value.trim()) args.sheet = sheet.value.trim();
      return call('import_test_cases', args, dry ? 'Reading your test cases…' : 'Importing…').then(function (o) {
        clear(slot).appendChild(outcomeView(o, { noDetails: true }));
        if (o.data && o.data.cases) slot.appendChild(table(o.data.cases, ['id', 'title', 'area', 'priority', 'steps']));
        if (o.ok && dry) slot.appendChild(el('div', { class: 'row' }, [button('Looks right, import them', function () { doImport(source, location, false); }, true), button('Cancel', function () { clear(slot); })]));
        if (o.ok && !dry) slot.appendChild(el('div', { class: 'row' }, [button('Review them now', review, true)]));
        return o;
      });
    }
    function review() {
      call('review_test_cases', {}, 'Reviewing your test cases…').then(function (o) {
        clear(reviewSlot).appendChild(outcomeView(o, { noDetails: true }));
        if (o.data && o.data.reviews) reviewSlot.appendChild(table(o.data.reviews.map(function (r) { return { id: r.id, score: r.score, verdict: r.verdict, effort: r.effort, issues: (r.issues || []).join(' '), suggestions: (r.suggestions || []).join(' ') }; })));
        if (o.ok && after) reviewSlot.appendChild(el('div', { class: 'row' }, [button('Continue', function () { after(); }, true)]));
      });
    }
    return el('div', null, [
      el('h3', { text: 'From a file on this computer' }),
      field('Choose the file', file, 'Excel, CSV, Word, Markdown or Gherkin. A copy goes into the test-cases folder of your project.'),
      field('Excel sheet (optional)', sheet),
      el('div', { class: 'row' }, [button('Read the file', function () {
        var f = file.files && file.files[0];
        if (!f) { toast('Choose a file first.'); return; }
        busy(true, 'Copying the file into your project…');
        api('POST', '/api/upload?name=' + encodeURIComponent(f.name), f, true).then(function (u) {
          busy(false);
          doImport(sourceFromName(f.name), u.path, true);
        }).catch(function (e) { busy(false); out(slot, { ok: false, text: e.message }); });
      }, true)]),
      el('details', null, [el('summary', { text: 'Or: a file that is already in the project folder' }),
        field('Path inside the project', pathInput),
        el('div', { class: 'row' }, [button('Read it', function () { var p = pathInput.value.trim(); if (p) doImport(sourceFromName(p), p, true); })])
      ]),
      el('h3', { text: 'From a test management tool' }),
      el('p', { class: 'muted', text: 'Needs that tool’s address and key in your .env (see Guided setup → Passwords and keys).' }),
      field('Tool', remote), field('What to import', where),
      el('div', { class: 'row' }, [button('Preview the import', function () { if (!remote.value) { toast('Choose the tool first.'); return; } doImport(remote.value, where.value.trim() || undefined, true); })]),
      slot,
      el('div', { class: 'row' }, [button('Review the test cases I already have', review)]),
      reviewSlot
    ]);
  }

  function planPanel(after) {
    var slot = el('div');
    var size = el('input', { type: 'number', min: '1', value: '10', style: 'max-width:120px' });
    function draw(o) {
      clear(slot).appendChild(outcomeView(o, { noDetails: true }));
      var plan = o.data && o.data.plan;
      if (!plan) return;
      if (plan.waves) slot.appendChild(table(plan.waves.map(function (w) { return { wave: w.number, name: w.name, tests: (w.ids || []).length, ids: (w.ids || []).join(', ') }; })));
      var extra = [];
      if (plan.manual && plan.manual.length) extra.push('Kept manual: ' + plan.manual.join(', '));
      if (plan.rework && plan.rework.length) extra.push('Need rework first: ' + plan.rework.join(', '));
      if (extra.length) slot.appendChild(el('p', { class: 'muted', text: extra.join(' · ') }));
      if (o.data.approved || plan.approved) {
        slot.appendChild(el('div', { class: 'note ok', text: 'Approved' + (plan.approved && plan.approved.by ? ' by ' + plan.approved.by : '') + '.' }));
        if (after) slot.appendChild(el('div', { class: 'row' }, [button('Continue', function () { after(); }, true)]));
      } else {
        slot.appendChild(el('div', { class: 'row' }, [button('Approve this plan', function () { call('automation_plan', { action: 'approve' }, 'Saving the approval…').then(draw); }, true)]));
      }
    }
    return el('div', null, [
      el('p', { text: 'The plan puts the tests in “waves”: the most important ones first. You approve it before any test code is written.' }),
      field('Tests in the first wave', size),
      el('div', { class: 'row' }, [
        button('Make the plan', function () { call('automation_plan', { action: 'generate', wave1Size: Number(size.value) || 10 }, 'Making the plan…').then(draw); }, true),
        button('Show the saved plan', function () { call('automation_plan', { action: 'show' }).then(draw); })
      ]),
      slot
    ]);
  }

  function generatePanel(after) {
    var slot = el('div');
    var wave = el('input', { type: 'number', min: '1', value: '1', style: 'max-width:120px' });
    return el('div', null, [
      el('p', { text: 'TestPilot writes one test per test case, in your chosen language and style. You see the files first.' }),
      field('Wave', wave),
      el('div', { class: 'row' }, [button('Show me what will be written', function () {
        call('preview_tests', { wave: Number(wave.value) || 1 }, 'Preparing the tests…').then(function (o) {
          clear(slot).appendChild(outcomeView(o, { noDetails: true }));
          if (!o.ok || !o.data) return;
          if (o.data.cases) slot.appendChild(table(o.data.cases.map(function (c) { return { id: c.id, file: c.spec, stepsLeftForAI: c.todos }; })));
          if (o.data.files) slot.appendChild(el('div', { class: 'filelist' }, o.data.files.map(function (f) { return el('div', { text: (f.status === 'new' ? '+ ' : '~ ') + f.path }); })));
          slot.appendChild(el('div', { class: 'row' }, [button('Yes, write these tests', function () {
            call('generate_tests', { wave: Number(wave.value) || 1, confirmToken: o.data.confirmToken }, 'Writing the tests…').then(function (r) {
              clear(slot).appendChild(outcomeView(r));
              var todo = r.data && r.data.cases && r.data.cases.filter(function (c) { return c.todos; });
              if (todo && todo.length) slot.appendChild(el('div', { class: 'note warn', text: todo.length + ' test(s) have steps TestPilot could not write on its own (marked TODO). Ask the AI in Cursor or Claude: “finish the TODO steps in the TestPilot tests”. The other tests are ready to run.' }));
              if (r.ok && after) slot.appendChild(el('div', { class: 'row' }, [button('Continue', function () { after(); }, true)]));
            });
          }, true)]));
        });
      }, true)]),
      slot
    ]);
  }

  function runPanel() {
    var slot = el('div');
    var wave = el('input', { type: 'number', min: '1', placeholder: 'All', style: 'max-width:120px' });
    var twice = el('input', { type: 'checkbox' });
    return el('div', null, [
      el('p', { text: 'Runs the tests in a real browser on this computer and explains any failure in plain words.' }),
      field('Only this wave (optional)', wave),
      el('label', { class: 'row' }, [twice, el('span', { text: 'Run twice to catch flaky tests (a test only counts as done when it passes twice)' })]),
      el('div', { class: 'row' }, [button('Run the tests', function () {
        var args = {};
        if (wave.value) args.wave = Number(wave.value);
        if (twice.checked) args.stabilityRuns = 2;
        call('run_tests', args, 'Running your tests…').then(function (o) { drawRun(slot, o); });
      }, true)]),
      slot
    ]);
  }
  function drawRun(slot, o) {
    clear(slot).appendChild(outcomeView(o, { noDetails: true }));
    var run = (o.data && o.data.run) || {};
    var tests = Array.isArray(run.tests) ? run.tests : [];
    if (tests.length) slot.appendChild(table(tests.map(function (t) { return { test: t.title || t.id, id: t.id, result: t.status, seconds: t.durationMs ? Math.round(t.durationMs / 100) / 10 : '' }; })));
    if (o.data) slot.appendChild(el('details', null, [el('summary', { text: 'Details' }), dataView(o.data)]));
    var failures = tests.filter(function (t) { return t.status === 'failed' || t.status === 'flaky'; });
    if (failures.length) {
      slot.appendChild(el('div', { class: 'row' }, [button('Explain the failures in plain words', function () {
        call('heal_tests', { action: 'explain' }, 'Looking at the failures…').then(function (r) { slot.appendChild(outcomeView(r)); });
      })]));
    }
  }

  function reportPanel() {
    var slot = el('div');
    var provider = el('select', null, ['github-actions', 'azure-devops', 'gitlab', 'jenkins'].map(function (p) { return el('option', { value: p, text: p }); }));
    return el('div', null, [
      el('div', { class: 'row' }, [
        button('Make the report', function () { call('publish_results', { action: 'report' }, 'Making the report…').then(function (o) { out(slot, o); }); }, true)
      ]),
      field('Automatic runs (CI) on', provider, 'TestPilot writes the pipeline file so your tests run on every change.'),
      el('div', { class: 'row' }, [button('Create the CI pipeline file', function () { call('publish_results', { action: 'ci', provider: provider.value }, 'Writing the pipeline…').then(function (o) { out(slot, o); }); })]),
      slot
    ]);
  }

  // ---------- pages built from the panels ----------
  function renderCases() {
    page('Test cases', 'Bring in the test cases you already have, get a review of each one, and see them all in one list.');
    main.appendChild(section('Import', null, [importPanel(function () { go('cases'); })]));
    var listSlot = el('div');
    var search = el('input', { type: 'text', placeholder: 'Search titles' });
    var verdict = el('select', null, [['', 'Any review result'], ['AUTOMATE', 'Ready to automate'], ['NEEDS-REWORK', 'Needs rework'], ['MANUAL', 'Keep manual']].map(function (v) { return el('option', { value: v[0], text: v[1] }); }));
    function load() {
      var args = { limit: 500 };
      if (search.value.trim()) args.search = search.value.trim();
      if (verdict.value) args.verdict = verdict.value;
      call('list_test_cases', args, 'Loading…').then(function (o) {
        clear(listSlot).appendChild(el('p', { class: 'muted', text: forPeople(o.text).split('\n')[0] }));
        if (o.data && o.data.cases) listSlot.appendChild(table(o.data.cases, ['id', 'title', 'area', 'priority', 'steps', 'verdict', 'score', 'status', 'wave']));
      });
    }
    search.onkeydown = function (e) { if (e.key === 'Enter') load(); };
    verdict.onchange = load;
    main.appendChild(section('All test cases', null, [el('div', { class: 'row' }, [search, verdict, button('Search', load)]), listSlot]));
    main.appendChild(section('Add one by hand', 'Write a test case in plain words. It is saved with your other test cases in .testpilot/.', [manualCase()]));
    load();
  }

  function manualCase() {
    var id = el('input', { type: 'text', placeholder: 'e.g. SHOP-10' });
    var title = el('input', { type: 'text', placeholder: 'e.g. Customer can add a product to the cart' });
    var area = el('input', { type: 'text', placeholder: 'e.g. Cart' });
    var steps = el('textarea', { placeholder: 'One step per line, e.g.\nOpen the home page\nClick “Add to cart” on the first product' });
    var expected = el('input', { type: 'text', placeholder: 'e.g. The cart shows 1 item' });
    var slot = el('div');
    return el('div', null, [field('Id', id), field('Title', title), field('Area', area), field('Steps', steps), field('Expected result', expected),
      el('div', { class: 'row' }, [button('Save the test case', function () {
        if (!id.value.trim() || !title.value.trim()) { toast('Give at least an id and a title.'); return; }
        var args = { id: id.value.trim(), title: title.value.trim(), steps: steps.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) { return { action: s }; }) };
        if (area.value.trim()) args.area = area.value.trim();
        if (expected.value.trim()) args.expected = expected.value.trim();
        call('save_test_case', args, 'Saving…').then(function (o) { out(slot, o, { noDetails: true }); });
      }, true)]), slot]);
  }

  function renderTests() {
    page('Plan, write & run', 'Three steps: approve a plan, let TestPilot write the tests, then run them.');
    main.appendChild(section('1. Automation plan', null, [planPanel()]));
    main.appendChild(section('2. Write the tests', null, [generatePanel()]));
    main.appendChild(section('3. Run the tests', null, [runPanel()]));
    var flakySlot = el('div');
    main.appendChild(section('Failing or flaky tests', 'Get a plain-words explanation of the last failures, or find tests that pass and fail at random.', [
      el('div', { class: 'row' }, [
        button('Explain the last failures', function () { call('heal_tests', { action: 'explain' }, 'Reading the last run…').then(function (o) { out(flakySlot, o); }); }),
        button('Find flaky tests', function () { call('heal_tests', { action: 'flaky' }, 'Looking at past runs…').then(function (o) { out(flakySlot, o); }); }),
        button('Suggest fixes for broken locators', function () { call('heal_tests', { action: 'propose' }, 'Looking for fixes…').then(function (o) { out(flakySlot, o); }); })
      ]),
      el('p', { class: 'muted', text: 'Fixes are only suggested here. Applying one always asks you first.' }),
      flakySlot
    ]));
  }

  function renderResults() {
    page('Reports & coverage', 'What is tested, what passes, and a report you can share.');
    main.appendChild(section('Report and CI', null, [reportPanel()]));
    var viewSlot = el('div');
    var reqFile = el('input', { type: 'text', placeholder: 'Optional: requirements file in the project, e.g. requirements.xlsx' });
    main.appendChild(section('Coverage map and dashboard', 'Which parts of your app have tests, and how the team is doing. Without a requirements file, the areas of your test cases are used.', [
      field('Requirements', reqFile),
      el('div', { class: 'row' }, [
        button('Show the coverage map', function () { var a = { action: 'coverage' }; if (reqFile.value.trim()) a.requirementsFile = reqFile.value.trim(); showInsights(viewSlot, a); }, true),
        button('Show the team dashboard', function () { showInsights(viewSlot, { action: 'dashboard' }); }),
        button('Show time saved', function () { showInsights(viewSlot, { action: 'metrics' }); })
      ]),
      viewSlot
    ]));
  }

  // Hosts TestPilot's own insights view (the one Claude and VS Code show in chat) in a sandboxed frame.
  var viewHtml = null;
  function showInsights(slot, args) {
    var get = viewHtml ? Promise.resolve(viewHtml) : api('GET', '/api/insights-view').then(function (r) { viewHtml = r.html; return viewHtml; });
    Promise.all([get, call('insights', args, 'Working it out…')]).then(function (both) {
      var html = both[0], res = both[1];
      clear(slot);
      if (!res.ok) { slot.appendChild(outcomeView(res)); return; }
      slot.appendChild(el('p', { class: 'muted result', text: forPeople(res.text).split('\n').slice(0, 3).join('\n') }));
      var frame = el('iframe', { class: 'view', sandbox: 'allow-scripts', title: 'TestPilot insights' });
      var payload = { content: [{ type: 'text', text: res.text }], structuredContent: res.data };
      function reply(id, result) { frame.contentWindow.postMessage({ jsonrpc: '2.0', id: id, result: result }, '*'); }
      function onMessage(ev) {
        if (!frame.isConnected) { window.removeEventListener('message', onMessage); return; }
        if (ev.source !== frame.contentWindow) return;
        var m = ev.data || {};
        if (m.jsonrpc !== '2.0') return;
        if (m.method === 'ui/initialize') reply(m.id, { protocolVersion: '2026-01-26', hostInfo: { name: 'testpilot-app', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: { theme: currentTheme(), displayMode: 'inline' } });
        else if (m.method === 'ui/notifications/initialized') {
          frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: args } }, '*');
          frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: payload }, '*');
        } else if (m.method === 'ui/notifications/size-changed') frame.style.height = Math.min(4000, Math.max(300, Number(m.params && m.params.height) || 300)) + 'px';
        else if (m.method === 'tools/call') {
          var p = m.params || {};
          if (p.name !== 'insights') { frame.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Only insights can be refreshed here.' } }, '*'); return; }
          api('POST', '/api/call', { name: 'insights', arguments: p.arguments || args }).then(function (r) { reply(m.id, { content: [{ type: 'text', text: r.text }], structuredContent: r.data, isError: !r.ok }); });
        } else if (m.id !== undefined) reply(m.id, {});
      }
      window.addEventListener('message', onMessage);
      frame.srcdoc = html;
      slot.appendChild(frame);
    });
  }

  function renderQuality() {
    page('Quality checks', 'Checks that need no test code: website health, accessibility, and a review of your test code.');
    var hSlot = el('div');
    var url = el('input', { type: 'url', placeholder: 'Leave empty to use the saved address' });
    main.appendChild(section('Website health check', 'Visits your site like a visitor (only follows links, never types or submits) and reports broken pages and links, errors, slow pages, pages too wide for a phone and images without descriptions. Needs a Playwright web project.', [
      field('Website address', url),
      el('div', { class: 'row' }, [button('Check the website', function () { var a = { action: 'check' }; if (url.value.trim()) a.url = url.value.trim(); call('test_my_app', a, 'Checking the website…').then(function (o) { out(hSlot, o); }); }, true)]),
      hSlot
    ]));
    var aSlot = el('div');
    var urls = el('input', { type: 'text', placeholder: 'Pages to check, separated by spaces (empty = the saved address)' });
    var level = el('select', null, ['AA', 'A', 'AAA'].map(function (l) { return el('option', { value: l, text: 'WCAG ' + l + (l === 'AA' ? ' (usual standard)' : '') }); }));
    main.appendChild(section('Accessibility', 'Can people who use a screen reader or keyboard use your site?', [
      field('Pages', urls), field('Standard', level),
      el('div', { class: 'row' }, [button('Check accessibility', function () {
        var a = { action: 'accessibility', level: level.value };
        var list = urls.value.split(/\s+/).filter(Boolean);
        if (list.length) a.urls = list;
        call('quality_scan', a, 'Checking accessibility…').then(function (o) {
          out(aSlot, o);
          if (/not installed/.test(o.text || '')) aSlot.appendChild(el('div', { class: 'row' }, [button('Install the scanner and check', function () {
            call('quality_scan', Object.assign({}, a, { install: true }), 'Installing the scanner and checking…').then(function (r) { out(aSlot, r); });
          }, true)]));
        });
      }, true)]),
      aSlot
    ]));
    var gSlot = el('div');
    main.appendChild(section('Test code review', 'Finds common mistakes in test code: fixed waits, weak checks, hard-coded passwords, fragile locators.', [
      el('div', { class: 'row' }, [button('Review my test code', function () { call('quality_scan', { action: 'gate' }, 'Reviewing the test code…').then(function (o) { out(gSlot, o); }); })]),
      gSlot
    ]));
    var pSlot = el('div');
    main.appendChild(section('Is this computer ready?', 'Checks that the programs your setup needs are installed (Node.js, Java, Android tools…) with how to fix anything missing.', [
      el('div', { class: 'row' }, [button('Check this computer', function () { call('check_prerequisites', {}, 'Checking…').then(function (o) {
        clear(pSlot).appendChild(outcomeView(o, { noDetails: true }));
        if (o.data && o.data.results) pSlot.appendChild(table(o.data.results.map(function (r) { return { tool: r.name, found: r.found ? 'yes' : 'no', needed: r.required ? 'yes' : 'optional', version: r.version, fix: r.fix || r.hint }; })));
      }); })]),
      pSlot
    ]));
  }

  function renderAi() {
    page('AI features', 'Some TestPilot features need an AI to look at your app. This page says which, and how to use them.');
    var rows = [
      ['The Chat page', 'Cursor or Claude on this computer', 'warn', 'Uses the Cursor or Claude plan you already have (no extra key): the Chat page shows how to add it. Everything below that says “AI in the chat” also works there.'],
      ['Everything on the other pages', 'No AI needed', 'ok', 'Setup, imports, reviews, plans, writing tests from clear test cases, running tests, reports, coverage and the quality checks all work here on their own.'],
      ['Finishing TODO steps in written tests', 'AI in the chat', 'warn', 'In Cursor or Claude Code, say: “finish the TODO steps in the TestPilot tests”.'],
      ['Plain-English AI tests (websites)', 'AI in the chat, no key', 'warn', 'In Cursor or Claude Code, type /qa-ai or say “run my AI tests”. The chat’s AI does each step and TestPilot saves a normal test you can run here.'],
      ['Plain-English AI tests (phones, desktop, unattended)', 'Model key in .env', 'bad', 'Needs a Gemini or OpenAI-style key in .env (Midscene). Then the AI tests run on their own, also in CI.'],
      ['Live testing, exploring the app with AI', 'AI in the chat', 'warn', 'In the chat, say “live test my app” or “explore my app”.'],
      ['Self-healing fixes', 'AI in the chat to apply', 'warn', 'Suggestions work here (Plan, write & run page). Applying a fix is done with the AI so it can check the change.']
    ];
    main.appendChild(el('div', { class: 'card' }, [table(rows.map(function (r) { return { feature: r[0], needs: r[1], howToUseIt: r[3] }; }), ['feature', 'needs', 'howToUseIt'])]));
    var slot = el('div');
    main.appendChild(section('AI tests in this project', null, [
      el('div', { class: 'row' }, [
        button('Show AI test status', function () { call('ai_tests', { action: 'status' }, 'Checking…').then(function (o) { out(slot, o); }); }),
        button('Which AI models work?', function () { call('ai_tests', { action: 'models' }).then(function (o) { out(slot, o); }); })
      ]),
      slot
    ]));
    var prompts = [['/qa-start', 'Start the guided setup in the chat'], ['/qa-ai', 'Plain-English AI tests'], ['/qa-demo', 'The full TestPilot demo'], ['finish the TODO steps in the TestPilot tests', 'Let the AI finish written tests']];
    main.appendChild(section('Copy a request for the chat', 'Paste it into Cursor or Claude Code.', [el('div', { class: 'row' }, prompts.map(function (p) {
      return button(p[1], function () { copy(p[0]); });
    }))]));
  }
  function copy(text) {
    var done = function () { toast('Copied: ' + text); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { prompt('Copy this:', text); });
    else prompt('Copy this:', text);
  }

  // ---------- All tools: a form for any tool, built from its input schema ----------
  function renderTools() {
    page('All tools', 'Every TestPilot tool, for people who know what they want. Steps that change files or run programs still ask you first.');
    var slot = el('div', null, [el('p', { class: 'muted', text: 'Loading…' })]);
    main.appendChild(slot);
    api('GET', '/api/tools').then(function (res) {
      clear(slot);
      var pick = el('select', null, res.tools.map(function (t) { return el('option', { value: t.name, text: (t.title || t.name) + '  (' + t.name + ')' }); }));
      var formSlot = el('div');
      var outSlot = el('div');
      pick.onchange = function () { draw(res.tools.filter(function (t) { return t.name === pick.value; })[0]); };
      slot.appendChild(el('div', { class: 'card' }, [field('Tool', pick), formSlot, outSlot]));
      function draw(tool) {
        clear(outSlot);
        clear(formSlot).appendChild(el('p', { class: 'muted', text: tool.description || '' }));
        var props = (tool.inputSchema && tool.inputSchema.properties) || {};
        var inputs = {};
        Object.keys(props).forEach(function (k) {
          if (k === 'projectRoot' || k === 'userApproved' || k === 'approver' || k === 'interactive') return;
          var s = props[k] || {};
          var input;
          if (s.enum) input = el('select', null, [el('option', { value: '', text: s.default !== undefined ? '(default: ' + s.default + ')' : '—' })].concat(s.enum.map(function (v) { return el('option', { value: v, text: v }); })));
          else if (s.type === 'boolean') input = el('select', null, [el('option', { value: '', text: s.default !== undefined ? '(default: ' + s.default + ')' : '—' }), el('option', { value: 'true', text: 'yes' }), el('option', { value: 'false', text: 'no' })]);
          else if (s.type === 'array' || s.type === 'object' || s.anyOf) input = el('input', { type: 'text', placeholder: s.type === 'object' ? 'JSON, e.g. {"a":1}' : 'Separate with commas (or JSON)' });
          else input = el('input', { type: s.type === 'integer' || s.type === 'number' ? 'number' : 'text' });
          inputs[k] = { el: input, schema: s };
          formSlot.appendChild(field(k, input, s.description));
        });
        formSlot.appendChild(el('div', { class: 'row' }, [button('Run', function () {
          var args = {};
          try {
            Object.keys(inputs).forEach(function (k) {
              var i = inputs[k], v = i.el.value.trim(), s = i.schema;
              if (v === '') return;
              if (s.type === 'boolean') args[k] = v === 'true';
              else if (s.type === 'integer' || s.type === 'number') args[k] = Number(v);
              else if (s.type === 'object') args[k] = JSON.parse(v);
              else if (s.type === 'array' || s.anyOf) args[k] = v.charAt(0) === '[' ? JSON.parse(v) : s.type === 'array' ? v.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : v;
              else args[k] = v;
            });
          } catch (e) { toast('Check the JSON: ' + e.message); return; }
          if (tool.name === 'wizard') args.interactive = false;
          call(tool.name, args).then(function (o) { out(outSlot, o); });
        }, true)]));
      }
      draw(res.tools[0]);
    }).catch(function (e) { out(slot, { ok: false, text: e.message }); });
  }

  function renderHelp() {
    page('Testing words', 'New to testing? Every word TestPilot uses, in plain language.');
    var q = el('input', { type: 'text', placeholder: 'e.g. flaky test, locator, CI' });
    var slot = el('div');
    function ask(term) { call('explain_testing', term ? { term: term } : {}).then(function (o) { clear(slot).appendChild(el('div', { class: 'card result', text: o.text })); }); }
    q.onkeydown = function (e) { if (e.key === 'Enter') ask(q.value.trim()); };
    main.appendChild(el('div', { class: 'card' }, [field('What does this mean?', q), el('div', { class: 'row' }, [button('Explain', function () { ask(q.value.trim()); }, true), button('Show all words', function () { ask(''); })])]));
    main.appendChild(slot);
    ask('');
  }

  var RENDER = { home: renderHome, chat: renderChat, setup: renderSetup, cases: renderCases, tests: renderTests, results: renderResults, quality: renderQuality, ai: renderAi, tools: renderTools, help: renderHelp };

  // ---------- start ----------
  if (!KEY) {
    main.appendChild(el('div', { class: 'card' }, [el('h1', { text: 'Open TestPilot from its address' }), el('p', { text: 'This page needs the address TestPilot printed when it started (it ends with ?key=…). Start the app again from Cursor (“open the TestPilot app”) or the terminal (testpilot-mcp ui).' })]));
    document.getElementById('project').textContent = 'Not connected';
    return;
  }
  api('GET', '/api/info').then(function (info) {
    INFO = info;
    var p = document.getElementById('project');
    clear(p).appendChild(document.createTextNode('Project '));
    p.appendChild(el('b', { text: info.root }));
    p.appendChild(document.createTextNode('  ·  TestPilot ' + info.version));
    p.title = info.root;
    go((location.hash || '#home').slice(1));
  }).catch(function (e) {
    main.appendChild(el('div', { class: 'card' }, [el('h1', { text: 'Cannot reach TestPilot' }), el('p', { text: e.message })]));
  });
})();
</script>
</body>
</html>
`;
