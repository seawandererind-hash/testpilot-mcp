#!/usr/bin/env node
// Proves the mobile path on a real Android emulator or a BrowserStack device: answers the wizard for an
// Android app, creates the Appium + WebdriverIO framework, installs it, opens the app and reads its
// first screen through explore_app. Used by .github/workflows/device-check.yml.
// Usage: npm run build && node scripts/device-check.mjs --app <path to .apk | bs://id> [--target local|browserstack]
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createServer } = await import(path.join(repo, 'dist/server.js'));
const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
};
const app = arg('app');
const target = arg('target') ?? (app?.startsWith('bs://') ? 'browserstack' : 'local');
if (!app) {
    console.error('Give the app with --app <path to .apk> or --app bs://<BrowserStack app id>.');
    process.exit(2);
}

const root = mkdtempSync(path.join(tmpdir(), 'testpilot-device-'));
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'device-check', version: '1.0.0', private: true }));
const handler = createMcpHandler(() => createServer({ root }));
const client = new Client({ name: 'device-check', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://device-check.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));

async function call(name, args = {}) {
    const res = await client.callTool({ name, arguments: { projectRoot: root, ...args } });
    const text = res.content?.[0]?.text ?? '';
    console.log(`\n## ${name} ${res.isError ? '(error)' : ''}\n${text.slice(0, 2500)}`);
    return res;
}
function fail(message) {
    console.error(`\nDEVICE CHECK FAILED: ${message}`);
    process.exit(1);
}

// Wizard: Android app, everything else as TestPilot recommends.
const presets = { APP_TYPE: 'android', EXISTING: 'create', EXECUTION_TARGET: target, TEST_CASE_SOURCE: 'csv', CI: 'none', REPORTING: ['html', 'junit'] };
for (let i = 0; i < 20; i++) {
    const next = await call('wizard', { action: 'next' });
    const view = next.structuredContent?.step;
    if (!view || view.kind === 'action' || !view.step) break;
    const answer = presets[view.step] ?? view.recommended ?? view.options?.[0]?.value;
    const res = await call('wizard', { action: 'answer', step: view.step, answer });
    if (res.isError) fail(`wizard step ${view.step}`);
}
await call('write_env_template');
const env = [`APP_PATH=${app.startsWith('bs://') ? '' : app}`, 'APPIUM_SERVER_URL=http://127.0.0.1:4723'];
if (target === 'browserstack') env.push(`BROWSERSTACK_USERNAME=${process.env.BROWSERSTACK_USERNAME ?? ''}`, `BROWSERSTACK_ACCESS_KEY=${process.env.BROWSERSTACK_ACCESS_KEY ?? ''}`, `BROWSERSTACK_APP_ID=${app}`);
writeFileSync(path.join(root, '.env'), env.join('\n') + '\n');
await call('check_env');

const preview = await call('preview_scaffold');
const scaffold = await call('scaffold_project', { confirmToken: preview.structuredContent?.confirmToken, userApproved: true, approver: 'device-check', install: true });
if (scaffold.isError || /Install failed/.test(scaffold.content?.[0]?.text ?? '')) fail('scaffold or install');
const answered = await call('wizard', { action: 'answer', step: 'APP_UNDER_TEST', answer: app });
if (answered.isError) fail('app under test');

let appium;
if (target === 'local') {
    const testRoot = path.join(root, (await call('testpilot_status')).structuredContent?.config?.project?.testRoot ?? 'automation');
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const driver = spawnSync(npx, ['appium', 'driver', 'install', 'uiautomator2'], { cwd: testRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    if (driver.status !== 0) console.log('(uiautomator2 may already be installed)');
    appium = spawn(npx, ['appium', '--port', '4723', '--log-level', 'warn'], { cwd: testRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
        await new Promise(r => setTimeout(r, 1000));
        up = await fetch('http://127.0.0.1:4723/status').then(r => r.ok).catch(() => false);
    }
    if (!up) fail('Appium did not start');
}

const explored = await call('explore_app', { useBrowserStack: target === 'browserstack', screenshots: true });
appium?.kill();
await client.close();
await handler.close();
const screen = explored.structuredContent?.screen;
if (explored.isError || !explored.structuredContent?.opened || !screen) fail('the app did not open');
console.log(`\nDEVICE CHECK PASSED: opened ${screen.name} on ${screen.platform} with ${screen.elements?.length ?? 0} element(s) through ${target === 'local' ? 'a local Appium server' : 'BrowserStack'}.`);
process.exit(0);
