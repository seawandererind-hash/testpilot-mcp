import { spawn } from 'node:child_process';

import type { ProjectStore } from '../core/store.js';
import { type CommandOutcome, runCommand } from '../scaffold/engine.js';

export const HEAL_DIR = '.testpilot/heal';
export const PROPOSALS_FILE = `${HEAL_DIR}/proposals.json`;
export const HISTORY_FILE = `${HEAL_DIR}/history.jsonl`;
export const TICKETS_DIR = `${HEAL_DIR}/tickets`;
export const QUARANTINE_FILE = '.testpilot/quarantine.json';

export interface LiveSnapshot {
    fatal?: string;
    url?: string;
    snapshot?: string;
    testIds?: string[];
}

/**
 * Programs heal_tests starts. Tests replace these so no browser or command runs.
 * run: runs a command (Playwright, init-agents). snapshot: opens one page with the
 * project's Playwright and returns its ARIA snapshot.
 */
export const healRuntime: {
    run: (cwd: string, argv: string[], timeout: number) => Promise<CommandOutcome>;
    snapshot: (store: ProjectStore, cwd: string, url: string) => Promise<LiveSnapshot>;
} = {
    run: (cwd, argv, timeout) => runCommand(cwd, argv, timeout),
    snapshot: snapshotLive
};

const SNAPSHOT_SCRIPT = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const out = v => console.log('__TESTPILOT__' + JSON.stringify(v));
let pw;
try { pw = require('@playwright/test'); } catch { try { pw = require('playwright'); } catch { out({ fatal: 'Playwright is not installed in this project.' }); process.exit(0); } }
const launch = {};
if (process.env.BROWSER_CHANNEL) launch.channel = process.env.BROWSER_CHANNEL;
if (process.env.BROWSER_EXECUTABLE_PATH) launch.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
let browser;
try { browser = await pw.chromium.launch(launch); } catch (e) { out({ fatal: 'Could not start the browser: ' + String(e.message).split('\n')[0] }); process.exit(0); }
try {
  const page = await browser.newPage();
  await page.goto(process.env.TESTPILOT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10000 }).catch(() => '');
  const testIds = await page.$$eval('[data-testid],[data-test],[data-qa],[data-cy]', els => els.slice(0, 200).map(e => e.getAttribute('data-testid') || e.getAttribute('data-test') || e.getAttribute('data-qa') || e.getAttribute('data-cy'))).catch(() => []);
  out({ url: page.url(), snapshot: snapshot.slice(0, 40000), testIds });
} catch (e) { out({ fatal: String(e.message).split('\n')[0] }); }
await browser.close();
`;

/** Opens one page with the project's own Playwright (a child process, like the explorer) and reads its ARIA snapshot. */
export async function snapshotLive(store: ProjectStore, cwd: string, url: string): Promise<LiveSnapshot> {
    const scriptRel = '.testpilot/tmp/heal-snapshot.mjs';
    store.write(scriptRel, SNAPSHOT_SCRIPT);
    try {
        const stdout = await new Promise<string>(resolve => {
            const child = spawn(process.execPath, [store.resolve(scriptRel)], { cwd, env: { ...process.env, TESTPILOT_URL: url }, windowsHide: true });
            let out = '';
            child.stdout.on('data', d => (out += d.toString()));
            const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
            child.on('error', () => resolve(''));
            child.on('close', () => {
                clearTimeout(timer);
                resolve(out);
            });
        });
        const at = stdout.lastIndexOf('__TESTPILOT__');
        if (at < 0) return { fatal: 'The page could not be opened.' };
        return JSON.parse(stdout.slice(at + '__TESTPILOT__'.length).trim().split('\n')[0]) as LiveSnapshot;
    } finally {
        store.remove(scriptRel);
    }
}
