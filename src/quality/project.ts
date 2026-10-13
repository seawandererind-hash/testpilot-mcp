import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { inTestRoot } from '../scaffold/engine.js';

/** Where quality reports are written. Same folder as the run reports. */
export const QUALITY_REPORTS_DIR = '.testpilot/reports';

export type SpecLanguage = 'ts' | 'js';

/** The test folder of a project, as a repository path ('' for the root) and an absolute path. */
export function testRootOf(store: ProjectStore, config: Config): { rel: string; cwd: string } {
    const rel = inTestRoot(config, '.').replace(/^\.$/, '').replace(/\/$/, '');
    return { rel, cwd: store.resolve(rel || '.') };
}

/** True when a package can be loaded from the folder (its own node_modules or a parent's). */
export function canResolve(cwd: string, pkg: string): boolean {
    try {
        createRequire(path.join(cwd, 'package.json')).resolve(pkg);
        return true;
    } catch {
        return existsSync(path.join(cwd, 'node_modules', ...pkg.split('/')));
    }
}

/** The language of a project's Playwright tests, or why there is none (Java, Appium, nothing installed). */
export function playwrightProject(store: ProjectStore, config: Config): { ok: true; lang: SpecLanguage; rel: string; cwd: string; esm: boolean } | { ok: false; message: string } {
    const { rel, cwd } = testRootOf(store, config);
    const framework = config.stack.framework;
    const language = config.stack.language;
    if (language && !['typescript', 'javascript'].includes(language)) {
        return {
            ok: false,
            message: `This project uses ${language}${framework ? ` with ${framework}` : ''}. Accessibility and visual checks here run through Playwright for JavaScript or TypeScript. For Java, add axe-core's Selenium integration (com.deque.html.axe-core:selenium) for accessibility and a screenshot-comparison library for visual checks, or keep a small Playwright project next to it just for these checks.`
        };
    }
    if (framework && !framework.startsWith('playwright')) {
        return { ok: false, message: `This project uses ${framework}. Accessibility and visual checks need Playwright for JavaScript or TypeScript (web apps). For mobile apps, use Appium Inspector and the platform's own accessibility scanner (Android Accessibility Scanner, Xcode Accessibility Inspector).` };
    }
    if (!canResolve(cwd, '@playwright/test') && !canResolve(cwd, 'playwright')) {
        return { ok: false, message: 'Playwright is not installed in this project yet. Run npm install in the test folder (and npx playwright install chromium), then try again.' };
    }
    const lang: SpecLanguage = language === 'javascript' ? 'js' : language === 'typescript' ? 'ts' : existsSync(path.join(cwd, 'tsconfig.json')) || existsSync(path.join(cwd, 'playwright.config.ts')) ? 'ts' : 'js';
    let esm = lang === 'ts';
    if (lang === 'js') {
        try {
            esm = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).type === 'module';
        } catch {
            esm = false;
        }
    }
    return { ok: true, lang, rel, cwd, esm };
}

export interface ScriptRunner {
    (store: ProjectStore, cwd: string, name: string, script: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>>;
}

/**
 * Runs a helper script with the project's own Node modules (the same way the explorer does):
 * writes it to .testpilot/tmp, runs it in the test folder and reads the `__TESTPILOT__` JSON line.
 */
export const runProjectScript: ScriptRunner = async (store, cwd, name, script, payload, timeoutMs) => {
    const scriptRel = `.testpilot/tmp/${name}.mjs`;
    store.write(scriptRel, script);
    const env = { ...process.env, TESTPILOT_PAYLOAD: JSON.stringify(payload) };
    try {
        const stdout = await new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [store.resolve(scriptRel)], { cwd, env, windowsHide: true });
            let out = '';
            let err = '';
            child.stdout.on('data', d => (out += d.toString()));
            child.stderr.on('data', d => (err = (err + d.toString()).slice(-4000)));
            const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
            child.on('error', reject);
            child.on('close', () => {
                clearTimeout(timer);
                if (!out.includes('__TESTPILOT__')) reject(new Error(`The helper stopped without a result. ${err.split('\n').slice(-5).join(' ')}`));
                else resolve(out);
            });
        });
        return JSON.parse(stdout.slice(stdout.lastIndexOf('__TESTPILOT__') + '__TESTPILOT__'.length).trim().split('\n')[0]) as Record<string, unknown>;
    } finally {
        store.remove(scriptRel);
    }
};

/** Shared start of the helper scripts: loads the project's Playwright and starts Chromium (honouring BROWSER_CHANNEL / BROWSER_EXECUTABLE_PATH). */
export const BROWSER_PRELUDE = String.raw`
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const done = out => { console.log('__TESTPILOT__' + JSON.stringify(out)); process.exit(0); };
let pw;
try { pw = require('@playwright/test'); } catch { try { pw = require('playwright'); } catch { done({ fatal: 'Playwright is not installed in this project. Run npm install, then npx playwright install chromium.' }); } }
const args = JSON.parse(process.env.TESTPILOT_PAYLOAD);
const launch = {};
if (process.env.BROWSER_CHANNEL) launch.channel = process.env.BROWSER_CHANNEL;
if (process.env.BROWSER_EXECUTABLE_PATH) launch.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
let browser;
try { browser = await pw.chromium.launch(launch); } catch (e) { done({ fatal: 'Could not start the browser: ' + String(e.message).split('\n')[0] + '. Run npx playwright install chromium, or set BROWSER_CHANNEL=chrome to use the installed Chrome.' }); }
const context = await browser.newContext({ ignoreHTTPSErrors: !!args.ignoreHttpsErrors, ...(args.storageState ? { storageState: args.storageState } : {}) });
const page = await context.newPage();
`;

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A self-contained page shell with light and dark colours that reads well on a phone. */
export function htmlPage(title: string, body: string, extraCss = ''): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #5f5e5a; --border: #dcdad3; --accent: #2457c5; --critical: #b3261e; --serious: #c2410c; --moderate: #9a6700; --minor: #4b5563; --ok: #1f7a3a; --code: #f0efea; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #161615; --panel: #1f1f1d; --text: #ecebe6; --muted: #a8a69f; --border: #3a3935; --accent: #8fb0ff; --critical: #ff8a80; --serious: #ffab70; --moderate: #f2c94c; --minor: #b8bec8; --ok: #7bd88f; --code: #2a2a27; } }
:root[data-theme="dark"] { --bg: #161615; --panel: #1f1f1d; --text: #ecebe6; --muted: #a8a69f; --border: #3a3935; --accent: #8fb0ff; --critical: #ff8a80; --serious: #ffab70; --moderate: #f2c94c; --minor: #b8bec8; --ok: #7bd88f; --code: #2a2a27; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 8px; }
h2 { font-size: 1.25rem; margin: 32px 0 12px; overflow-wrap: anywhere; }
h3 { font-size: 1.05rem; margin: 0 0 6px; overflow-wrap: anywhere; }
p { margin: 0 0 12px; }
a { color: var(--accent); }
.muted { color: var(--muted); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.86rem; background: var(--code); border-radius: 4px; }
code { padding: 1px 4px; overflow-wrap: anywhere; }
pre { padding: 8px 10px; margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 0 0 12px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 16px 0; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.stat b { display: block; font-size: 1.5rem; line-height: 1.2; }
.stat span { color: var(--muted); font-size: 0.9rem; }
.badge { display: inline-block; font-size: 0.78rem; font-weight: 600; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; margin-right: 6px; white-space: nowrap; }
.critical { color: var(--critical); } .serious { color: var(--serious); } .moderate { color: var(--moderate); } .minor { color: var(--minor); } .ok { color: var(--ok); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0 0; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; }
@media (max-width: 560px) { dl { grid-template-columns: 1fr; } dt { margin-top: 6px; } h1 { font-size: 1.35rem; } }
${extraCss}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/** Repository-relative POSIX path from one repository file to another, for links inside reports. */
export function relativeLink(fromFile: string, toFile: string): string {
    return path.posix.relative(path.posix.dirname(fromFile), toFile);
}
