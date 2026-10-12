import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ProjectStore } from '../core/store.js';
import { type CommandOutcome, runCommand } from '../scaffold/engine.js';
import { categorise, type FailureCategory, type RunSummary, secretScrubber, type TestOutcome } from './playwright.js';

/**
 * Runs the WebdriverIO + Appium suite created by the appium-ts template and reads the JSON
 * files its TestPilot reporter writes (test-results/testpilot/results-<cid>.json) into the same
 * RunSummary shape as Playwright runs, so reports, plan status and result sync work unchanged.
 */

const ANSI = /\u001b\[[0-9;]*m/g;

/** Appium and WebdriverIO failures the generic rules do not know, checked first. */
const APPIUM_RULES: Array<{ category: FailureCategory; test: RegExp }> = [
    {
        category: 'environment',
        test: /session not created|SessionNotCreated|Could not start a new session|Failed to create session|Unable to connect to "?https?:\/\/|ECONNREFUSED|ECONNRESET|socket hang up|:4723\b[^\n]*(refused|unreachable|timed? ?out)|Could not find a connected Android device|No (connected )?devices? (were )?(found|connected)|device (not found|offline|unauthorized)|Could not find a driver for automationName|Missing APP_PATH|Missing BROWSERSTACK_|app (file )?(at .* )?(does not exist|was not found)|does not exist or is not accessible|Neither ANDROID_HOME nor ANDROID_SDK_ROOT|JAVA_HOME is not set|xcodebuild failed|WebDriverAgent|Invalid username or (password|access key)|Authorization required|BROWSERSTACK_APP_ID/i
    },
    {
        category: 'locator',
        test: /no such element|NoSuchElement|element could not be located|An element could not be located|still not (displayed|existing|clickable|enabled) after \d+\s*ms|element wasn't found|Can't call \w+ on element with selector|invalid selector|InvalidSelector|did not appear within \d+ ms/i
    },
    {
        category: 'timing',
        test: /stale element reference|StaleElementReference|element is not attached to the page document|waitUntil condition timed out|Timeout of \d+ms exceeded/i
    },
    {
        // expect-webdriverio: "Expect $(`~cart-badge`) to have text ... Expected: ... Received: ..."
        category: 'assertion',
        test: /^\s*(Error: )?Expect(ed)? [\s\S]*\bExpected\b[\s\S]*\bReceived\b/
    }
];

const ADVICE: Record<FailureCategory, string> = {
    environment:
        'Appium, the device or the app could not be reached. Check that Appium is running (npm run appium) at APPIUM_SERVER_URL, the driver is installed (npx appium driver list --installed), an emulator or device is connected (adb devices / xcrun simctl list devices), APP_PATH points to the build, and .env has every key. On BrowserStack, check the credentials and that BROWSERSTACK_APP_ID has not expired (uploads last 30 days).',
    locator:
        'The element was not found. Compare the selector with .testpilot/exploration/README.md or Appium Inspector, prefer the accessibility id (~id), then resource-id or name, then visible text, and make sure the test is on the right screen (waitForScreen) before using it.',
    timing: 'The screen changed while the test used an element, or something took longer than allowed. Look elements up right before using them (screen getters do this) and wait for a specific condition (waitForDisplayed, waitUntil) instead of a fixed pause.',
    assertion:
        'The app did not show what the test case expects. Check the failure screenshot: if the app is wrong, it is a bug to report (tag the test @known-issue); if the expectation is outdated, update the test case and the test together. Never weaken the assertion without the team agreeing.',
    data: 'Test data or accounts are wrong: check the test user in .env and test-data/, or create the data the test needs in the test itself.',
    script: 'The test code itself is broken (a typo, a missing import or a renamed member). Fix the code; the app is not at fault.',
    unknown: 'Look at the failure screenshot in test-results/screenshots and the Appium server log to see what happened at the failing step.'
};

/** Sorts an Appium/WebdriverIO failure into a category with advice that fits mobile and desktop apps. */
export function categoriseAppium(message: string): { category: FailureCategory; advice: string } {
    const text = message.replace(ANSI, '');
    const rule = APPIUM_RULES.find(r => r.test.test(text));
    const category = rule?.category ?? categorise(text).category;
    return { category, advice: ADVICE[category] };
}

export interface WdioResultEntry {
    title: string;
    fullTitle?: string;
    suite?: string;
    file?: string;
    state: 'passed' | 'failed' | 'skipped' | 'pending';
    durationMs?: number;
    retries?: number;
    error?: { message?: string; stack?: string };
    attachments?: Array<{ name: string; path: string }>;
}

export interface WdioResultFile {
    format?: string;
    cid?: string;
    specs?: Array<string | null>;
    platform?: string | null;
    device?: string | null;
    tests?: WdioResultEntry[];
}

/** The test-case id TestPilot put at the start of the title (or as an @tag). */
export function testIdOf(title: string): string {
    return title.match(/^([A-Za-z][\w.]*-\d+|C\d+|TC[-_]?\d+)(?=\s|$)/)?.[1] ?? title.match(/(?:^|\s)@([A-Za-z][\w.]*-\d+)(?=\s|$)/)?.[1] ?? title;
}

function toRepoPath(repoRoot: string, cwd: string, file: string): string {
    return path.relative(repoRoot, path.resolve(cwd, file)).split(path.sep).join('/');
}

/**
 * Reads the reporter's JSON files from one or more runs into one outcome per test and platform.
 * A test that passed in some runs and failed in others (or passed only after a retry) is flaky.
 */
export function parseWdioResults(runs: WdioResultFile[][], scrub: (s: string) => string, repoRoot: string, cwd: string): TestOutcome[] {
    const byKey = new Map<string, TestOutcome>();
    for (const files of runs) {
        for (const file of files) {
            const project = [file.platform, file.device].filter(Boolean).join(' · ') || undefined;
            const spec = file.specs?.find(Boolean) ?? undefined;
            for (const t of file.tests ?? []) {
                const specFile = t.file ?? spec;
                const key = `${specFile ?? ''}|${project ?? ''}|${t.fullTitle ?? t.title}`;
                let outcome = byKey.get(key);
                if (!outcome) {
                    outcome = { id: testIdOf(t.title), title: t.title, file: specFile ? toRepoPath(repoRoot, cwd, specFile) : '', project, status: 'skipped', runs: 0, passes: 0, durationMs: 0, attachments: [] };
                    byKey.set(key, outcome);
                }
                if (t.state === 'skipped' || t.state === 'pending') continue;
                const retries = Math.max(0, t.retries ?? 0);
                outcome.runs += 1 + retries;
                if (t.state === 'passed') outcome.passes += 1;
                outcome.durationMs += t.durationMs ?? 0;
                if ((t.state === 'failed' || retries > 0) && !outcome.error) {
                    const raw = t.error?.message ?? (t.state === 'failed' ? 'Test failed' : `Passed after ${retries} retr${retries === 1 ? 'y' : 'ies'}`);
                    outcome.error = scrub(raw.replace(ANSI, '')).split('\n').slice(0, 12).join('\n').slice(0, 1500);
                    const triage = categoriseAppium(outcome.error);
                    outcome.category = triage.category;
                    outcome.advice = triage.advice;
                }
                for (const a of t.attachments ?? []) {
                    const file = toRepoPath(repoRoot, cwd, a.path);
                    // Every stability run overwrites the same screenshot file: list it once.
                    if (!outcome.attachments.some(x => x.path === file)) outcome.attachments.push({ name: a.name, path: file });
                }
            }
        }
    }
    const out = [...byKey.values()];
    for (const o of out) {
        o.status = !o.runs ? 'skipped' : o.passes === o.runs ? 'passed' : o.passes === 0 ? 'failed' : 'flaky';
        if (o.status === 'passed' || o.status === 'skipped') {
            delete o.error;
            delete o.category;
            delete o.advice;
        }
    }
    return out;
}

export interface WdioRunOptions {
    cwd: string;
    configFile: string;
    specs: string[];
    grep?: string;
    repeat: number;
    timeoutMs: number;
    /** Folder the TestPilot reporter writes to, relative to cwd. */
    resultsDir: string;
}

/** Reads the result files the reporter wrote since `since` (older files belong to earlier runs). */
export function readWdioResults(dir: string, since: number): WdioResultFile[] {
    if (!existsSync(dir)) return [];
    const out: WdioResultFile[] = [];
    for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
        const file = path.join(dir, name);
        if (statSync(file).mtimeMs < since - 1000) continue;
        try {
            out.push(JSON.parse(readFileSync(file, 'utf8')) as WdioResultFile);
        } catch {
            // A worker that crashed mid-write leaves a partial file; its console output still explains the failure.
        }
    }
    return out;
}

/** Runs WebdriverIO (once per stability run) and summarises the reporter's JSON files. */
export async function runWdio(store: ProjectStore, options: WdioRunOptions, run: (cwd: string, argv: string[], timeout: number) => Promise<CommandOutcome> = runCommand): Promise<RunSummary> {
    const argv = ['npx', 'wdio', 'run', options.configFile];
    for (const spec of options.specs) argv.push('--spec', spec);
    if (options.grep) argv.push('--mochaOpts.grep', options.grep);
    const startedAt = new Date();
    const scrub = secretScrubber(store);
    const runs: WdioResultFile[][] = [];
    let exitCode: number | null = 0;
    let tail = '';
    for (let i = 0; i < Math.max(1, options.repeat); i++) {
        const began = Date.now();
        const outcome = await run(options.cwd, argv, options.timeoutMs);
        if (outcome.exitCode !== 0) exitCode = outcome.exitCode;
        tail = outcome.tail;
        runs.push(readWdioResults(path.resolve(options.cwd, options.resultsDir), began));
    }
    const finishedAt = new Date();
    const tests = parseWdioResults(runs, scrub, store.root, options.cwd);
    const stats = {
        total: tests.length,
        passed: tests.filter(t => t.status === 'passed').length,
        failed: tests.filter(t => t.status === 'failed').length,
        flaky: tests.filter(t => t.status === 'flaky').length,
        skipped: tests.filter(t => t.status === 'skipped').length,
        durationMs: finishedAt.getTime() - startedAt.getTime()
    };
    const byCategory: RunSummary['byCategory'] = {};
    for (const t of tests) if (t.category && t.status !== 'passed') byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
    const anyResults = runs.some(r => r.length);
    return {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        command: argv.join(' '),
        exitCode,
        repeat: options.repeat,
        stats,
        tests,
        byCategory,
        reportFile: anyResults ? store.relative(path.resolve(options.cwd, options.resultsDir)) : undefined,
        // Keep the console output when it holds the only explanation (no session, a crashed worker, a config error).
        consoleTail: anyResults && tests.length && (exitCode === 0 || tests.some(t => t.status === 'failed' || t.status === 'flaky')) ? undefined : scrub(tail.replace(ANSI, ''))
    };
}
