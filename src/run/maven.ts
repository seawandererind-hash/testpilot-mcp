import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { type CommandOutcome, runCommand } from '../scaffold/engine.js';
import { javaClassPath } from '../generate/selenium.js';
import { type FailureCategory, type RunSummary, secretScrubber, type TestOutcome } from './playwright.js';
import { testIdOf } from './wdio.js';

/**
 * Runs the Selenium + Java suite created by the selenium-java template (Maven + TestNG, or Cucumber
 * with the BDD pattern) and reads target/testpilot/results.json, written by TestPilotListener,
 * into the same outcome shape the Playwright and Appium runners produce.
 */

export interface MavenResultEntry {
    title: string;
    className?: string;
    method?: string;
    groups?: string[];
    status: 'passed' | 'failed' | 'skipped';
    durationMs?: number;
    error?: string;
    screenshot?: string;
}

const RULES: Array<{ category: FailureCategory; test: RegExp; advice: string }> = [
    {
        category: 'environment',
        test: /SessionNotCreatedException|NoSuchDriverException|Unable to obtain|selenium-manager|Could not start a new session|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|UnknownHostException|ConnectException|Missing [A-Z][A-Z0-9_]+\. Copy \.env\.example|cannot find Chrome binary|not recognized as an internal|command not found|No plugin found|Could not resolve dependencies|BUILD FAILURE.*compil/is,
        advice: 'The browser, driver, build or app could not be reached. Check that the test environment is up, APP_BASE_URL is right, .env has every key, Java and Maven are installed, and the browser is installed (BROWSER_BINARY / CHROMEDRIVER_PATH when downloads are blocked).'
    },
    {
        category: 'script',
        test: /NullPointerException|ClassCastException|NoSuchMethodError|ClassNotFoundException|IllegalArgumentException: (?!No user)|compilation (error|failure)|cannot find symbol|UnsupportedOperationException|NumberFormatException/i,
        advice: 'The test code itself is broken (a null page object, a wrong type or a compile error). Fix the code; the app is not at fault.'
    },
    {
        category: 'data',
        test: /No user with role|Could not read test-data|\b401\b|\b403\b|Unauthori[sz]ed|Forbidden|already exists|invalid credentials|Invalid (email|user ?name) or password|account (is )?locked/i,
        advice: 'Test data or accounts are wrong: check the test user in .env and test-data/, or create the data the test needs in the test itself.'
    },
    {
        category: 'locator',
        test: /NoSuchElementException|visibilityOfElementLocated|elementToBeClickable|Expected condition failed|StaleElementReferenceException|ElementNotInteractableException|ElementClickInterceptedException|no such element|invalid selector|InvalidSelectorException|should be visible: By\./i,
        advice: 'An element could not be found or used. Compare the locator with the page (TestPilot\'s exploration in .testpilot/exploration/ lists what is there); prefer byRole and byLabel, and ask developers for a data-testid when nothing stable exists.'
    },
    {
        category: 'timing',
        test: /TimeoutException|timed out|Timed out|ScriptTimeoutException|page load/i,
        advice: 'Something took longer than allowed. Wait for a specific condition in the page object (the BasePage helpers already do) instead of a fixed time, and check the app\'s speed in the test environment.'
    },
    {
        category: 'assertion',
        test: /AssertionError|expected \[|but found \[|Assert\.|should (contain|be|not)/i,
        advice: 'The app did something different from the expected result. Check the screenshot: either the expectation is outdated or this is a real bug to report.'
    }
];

export function categoriseJava(message: string): { category: FailureCategory; advice: string } {
    for (const rule of RULES) if (rule.test.test(message)) return { category: rule.category, advice: rule.advice };
    return { category: 'unknown', advice: 'Open the screenshot and the stack trace in target/surefire-reports to see what happened.' };
}

export function parseMavenResults(runs: MavenResultEntry[][], config: Config, scrub: (s: string) => string, repoRoot: string, cwd: string): TestOutcome[] {
    const byKey = new Map<string, TestOutcome>();
    for (const entries of runs) {
        for (const t of entries) {
            const key = `${t.className ?? ''}|${t.title}`;
            let outcome = byKey.get(key);
            if (!outcome) {
                const file = t.className ? javaClassPath(config, t.className) : '';
                outcome = { id: testIdOf(t.title), title: t.title, file, status: 'skipped', runs: 0, passes: 0, durationMs: 0, attachments: [] };
                byKey.set(key, outcome);
            }
            // A pending Cucumber scenario or a SkipException is a skip, whatever TestNG called it.
            const status = t.error && /PendingException|SkipException/.test(t.error) ? 'skipped' : t.status;
            if (status === 'skipped') continue;
            outcome.runs += 1;
            if (status === 'passed') outcome.passes += 1;
            outcome.durationMs += t.durationMs ?? 0;
            if (status === 'failed' && !outcome.error) {
                outcome.error = scrub(t.error ?? 'Test failed').split('\n').slice(0, 12).join('\n').slice(0, 1500);
                const triage = categoriseJava(outcome.error);
                outcome.category = triage.category;
                outcome.advice = triage.advice;
            }
            if (t.screenshot) {
                const file = path.relative(repoRoot, path.resolve(cwd, t.screenshot)).split(path.sep).join('/');
                if (!outcome.attachments.some(a => a.path === file)) outcome.attachments.push({ name: 'screenshot', path: file });
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

export interface MavenRunOptions {
    cwd: string;
    /** Test-case ids (TestNG groups or Cucumber tags). */
    ids: string[];
    /** A tag such as @smoke. */
    tag?: string;
    bdd: boolean;
    repeat: number;
    timeoutMs: number;
}

/** The Maven command line for a selection: `-Dgroups=` for TestNG, `-Dcucumber.filter.tags=` for Cucumber. */
export function mavenArgs(options: Pick<MavenRunOptions, 'ids' | 'tag' | 'bdd'>): string[] {
    const argv = ['mvn', '-B', 'test'];
    const tag = options.tag?.replace(/^@/, '');
    if (options.bdd) {
        const parts: string[] = [];
        if (options.ids.length) parts.push(`(${options.ids.map(id => `@${id}`).join(' or ')})`);
        if (tag) parts.push(`@${tag}`);
        if (parts.length) argv.push(`-Dcucumber.filter.tags=${parts.join(' and ')}`);
    } else {
        const groups = [...options.ids, ...(tag ? [tag] : [])];
        if (groups.length) argv.push(`-Dgroups=${groups.join(',')}`);
    }
    return argv;
}

function readResults(cwd: string): MavenResultEntry[] {
    const file = path.join(cwd, 'target', 'testpilot', 'results.json');
    if (!existsSync(file)) return [];
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as MavenResultEntry[];
    } catch {
        return [];
    }
}

export async function runMaven(store: ProjectStore, config: Config, options: MavenRunOptions, run: (cwd: string, argv: string[], timeout: number) => Promise<CommandOutcome> = runCommand): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const scrub = secretScrubber(store);
    const argv = mavenArgs(options);
    const runs: MavenResultEntry[][] = [];
    let last: CommandOutcome | undefined;
    for (let i = 0; i < options.repeat; i++) {
        rmSync(path.join(options.cwd, 'target', 'testpilot', 'results.json'), { force: true });
        last = await run(options.cwd, argv, options.timeoutMs);
        runs.push(readResults(options.cwd));
    }
    const tests = parseMavenResults(runs, config, scrub, store.root, options.cwd);
    const stats = { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: tests.reduce((a, t) => a + t.durationMs, 0) };
    for (const t of tests) stats[t.status] += 1;
    return {
        startedAt,
        finishedAt: new Date().toISOString(),
        command: argv.join(' '),
        exitCode: last?.exitCode ?? null,
        repeat: options.repeat,
        stats,
        tests,
        byCategory: tests.reduce<Partial<Record<FailureCategory, number>>>((acc, t) => (t.category ? { ...acc, [t.category]: (acc[t.category] ?? 0) + 1 } : acc), {}),
        reportFile: existsSync(path.join(options.cwd, 'target', 'surefire-reports')) ? store.relative(path.join(options.cwd, 'target', 'surefire-reports')) : undefined,
        consoleTail: last && !tests.length ? scrub(last.tail) : undefined
    };
}
