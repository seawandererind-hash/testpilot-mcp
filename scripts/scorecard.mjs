#!/usr/bin/env node
// TestPilot's own scorecard: runs the whole demo story against the practice shop through the MCP
// protocol, exactly as an AI tool would, and measures the output (not just whether TestPilot runs).
// Usage: npm run build && node scripts/scorecard.mjs [--skip-browser-download] [--keep]
// Writes scorecard/latest.json and docs/scorecard.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createServer } = await import(path.join(repo, 'dist/server.js'));
const { VERSION } = await import(path.join(repo, 'dist/version.js'));
const skipBrowserDownload = process.argv.includes('--skip-browser-download');
const keep = process.argv.includes('--keep');

const root = mkdtempSync(path.join(tmpdir(), 'testpilot-scorecard-'));
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'testpilot-scorecard', version: '1.0.0', private: true }));
const handler = createMcpHandler(() => createServer({ root }));
const client = new Client({ name: 'testpilot-scorecard', version: VERSION });
await client.connect(new StreamableHTTPClientTransport(new URL('http://scorecard.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
const available = new Set((await client.listTools()).tools.map(t => t.name));

const steps = [];
async function call(step, name, args = {}) {
    if (!available.has(name)) {
        steps.push({ step, tool: name, ok: false, skipped: true, ms: 0, note: 'tool not available in this version' });
        return undefined;
    }
    const started = Date.now();
    const res = await client.callTool({ name, arguments: { projectRoot: root, ...args } });
    const ms = Date.now() - started;
    const text = res.content?.[0]?.text ?? '';
    steps.push({ step, tool: name, ok: !res.isError, ms, note: res.isError ? text.split('\n')[0].slice(0, 200) : undefined });
    if (process.env.SCORECARD_VERBOSE) console.error(`\n## ${step} (${name}, ${ms} ms)\n${text.slice(0, 1500)}`);
    return res;
}

const metrics = { version: VERSION, date: new Date().toISOString(), node: process.version, platform: process.platform };
const t0 = Date.now();
const demo = await call('Start the demo', 'demo_project', { action: 'start', userApproved: true, approver: 'scorecard' });
const preview = await call('Preview the framework', 'preview_scaffold');
const token = preview?.structuredContent?.confirmToken ?? preview?.structuredContent?.token;
await call('Create the framework', 'scaffold_project', { confirmToken: token, userApproved: true, approver: 'scorecard', install: !skipBrowserDownload });
if (skipBrowserDownload) spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
metrics.setupSeconds = Math.round((Date.now() - t0) / 1000);

await call('Watch it test (start)', 'live_test', { action: 'start', headed: false, caseId: 'SHOP-1' });
const auto = await call('Watch it test (auto)', 'live_test', { action: 'auto', caseId: 'SHOP-1' });
await call('Watch it test (finish)', 'live_test', { action: 'finish', userApproved: true, approver: 'scorecard' });
metrics.liveAutoSteps = auto?.structuredContent?.done?.length ?? auto?.structuredContent?.performed?.length;

await call('Explore', 'explore_app');
await call('Import test cases', 'import_test_cases', { source: 'csv', location: 'test-cases/shop.csv' });
const review = await call('Review', 'review_test_cases');
metrics.reviewVerdicts = review?.structuredContent?.summary ?? review?.structuredContent?.verdicts;
await call('Plan', 'automation_plan', { action: 'generate' });
await call('Approve the plan', 'automation_plan', { action: 'approve', approver: 'scorecard', userApproved: true });
const tests = await call('Preview tests', 'preview_tests', { wave: 1 });
const testToken = tests?.structuredContent?.confirmToken ?? tests?.structuredContent?.token;
const generated = await call('Generate tests', 'generate_tests', { confirmToken: testToken, wave: 1, userApproved: true, approver: 'scorecard' });
const cases = generated?.structuredContent?.cases ?? tests?.structuredContent?.cases ?? [];
metrics.generatedTests = cases.length;
metrics.todosLeft = cases.reduce((n, c) => n + (c.todos ?? 0), 0);

const first = await call('First run', 'run_tests', { stabilityRuns: 1 });
const s1 = first?.structuredContent?.run?.stats;
metrics.firstRun = s1 ? { total: s1.total, passed: s1.passed, failed: s1.failed, skipped: s1.skipped } : undefined;
metrics.firstRunPassRate = s1 && s1.total - s1.skipped > 0 ? Math.round((100 * s1.passed) / (s1.total - s1.skipped)) : undefined;
const stable = await call('Stability run (x2)', 'run_tests', { stabilityRuns: 2 });
metrics.flakyAfterTwoRuns = stable?.structuredContent?.run?.stats?.flaky;

await call('Accessibility scan', 'quality_scan', { action: 'accessibility' });
const gate = await call('Quality gate', 'quality_scan', { action: 'gate' });
metrics.qualityGate = gate?.structuredContent?.verdict ?? gate?.structuredContent?.overall;

await call('Break the app', 'demo_project', { action: 'break' });
const broken = await call('Run after the break', 'run_tests', {});
metrics.failuresAfterBreak = broken?.structuredContent?.run?.stats?.failed;
const proposals = await call('Propose heals', 'heal_tests', { action: 'propose' });
const ids = (proposals?.structuredContent?.proposals ?? []).map(p => p.id);
metrics.healProposals = ids.length;
const applied = ids.length ? await call('Apply heals', 'heal_tests', { action: 'apply', ids, userApproved: true, approver: 'scorecard' }) : undefined;
const healed = applied?.structuredContent?.results ?? applied?.structuredContent?.applied ?? [];
metrics.healedAndPassing = Array.isArray(healed) ? healed.filter(h => h.passed ?? h.ok ?? h.status === 'passed').length : undefined;
await call('Coverage map', 'insights', { action: 'coverage' });
await call('Report', 'publish_results', { action: 'report' });
await call('Put the app back', 'demo_project', { action: 'restore' });
await call('Stop the shop', 'demo_project', { action: 'stop' });
metrics.totalSeconds = Math.round((Date.now() - t0) / 1000);
metrics.steps = steps;

await client.close();
await handler.close();
if (!keep) rmSync(root, { recursive: true, force: true });

mkdirSync(path.join(repo, 'scorecard'), { recursive: true });
writeFileSync(path.join(repo, 'scorecard/latest.json'), JSON.stringify(metrics, null, 2) + '\n');
const ok = steps.filter(s => s.ok).length;
const md = [
    '# TestPilot scorecard',
    '',
    `Measured on ${metrics.date.slice(0, 10)} with TestPilot ${metrics.version} (${metrics.platform}, Node ${metrics.node}) by \`scripts/scorecard.mjs\`, which plays the whole demo against the practice shop through the MCP protocol, the way an AI tool does. No step is mocked.`,
    '',
    '| Measure | Result |',
    '|---|---|',
    `| Steps that worked | ${ok} of ${steps.length} |`,
    `| Setup (demo + framework + install) | ${metrics.setupSeconds}s |`,
    `| Tests generated from the 3 automatable cases | ${metrics.generatedTests ?? 'n/a'} (${metrics.todosLeft ?? 'n/a'} steps left for the AI to finish) |`,
    `| First-run pass rate | ${metrics.firstRunPassRate ?? 'n/a'}% |`,
    `| Flaky after two runs | ${metrics.flakyAfterTwoRuns ?? 'n/a'} |`,
    `| Failures after renaming the Sign in button | ${metrics.failuresAfterBreak ?? 'n/a'} |`,
    `| Heals proposed / passing after apply | ${metrics.healProposals ?? 'n/a'} / ${metrics.healedAndPassing ?? 'n/a'} |`,
    `| Whole story | ${metrics.totalSeconds}s |`,
    '',
    '## Steps',
    '',
    '| Step | Tool | Result | Time |',
    '|---|---|---|---|',
    ...steps.map(s => `| ${s.step} | \`${s.tool}\` | ${s.skipped ? 'not available' : s.ok ? 'ok' : `failed: ${String(s.note ?? '').replace(/\|/g, '\\|')}`} | ${(s.ms / 1000).toFixed(1)}s |`),
    ''
].join('\n');
writeFileSync(path.join(repo, 'docs/scorecard.md'), md);
console.log(md);
process.exit(steps.some(s => !s.ok && !s.skipped) ? 1 : 0);
