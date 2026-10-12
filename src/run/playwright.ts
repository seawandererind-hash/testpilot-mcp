import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { isSetting } from '../catalog/env-keys.js';
import { loadEnvValues } from '../core/env.js';
import type { ProjectStore } from '../core/store.js';
import { RUNS_DIR } from '../core/store.js';
import { type CommandOutcome, runCommand } from '../scaffold/engine.js';

export type FailureCategory = 'environment' | 'locator' | 'assertion' | 'timing' | 'data' | 'script' | 'unknown';

export interface TestOutcome {
    id: string;
    title: string;
    file: string;
    line?: number;
    project?: string;
    /** passed, failed, flaky (mixed results), skipped. */
    status: 'passed' | 'failed' | 'flaky' | 'skipped';
    runs: number;
    passes: number;
    durationMs: number;
    error?: string;
    category?: FailureCategory;
    advice?: string;
    attachments: Array<{ name: string; path: string }>;
}

export interface RunSummary {
    startedAt: string;
    finishedAt: string;
    command: string;
    exitCode: number | null;
    repeat: number;
    baseUrl?: string;
    stats: { total: number; passed: number; failed: number; flaky: number; skipped: number; durationMs: number };
    tests: TestOutcome[];
    byCategory: Partial<Record<FailureCategory, number>>;
    reportFile?: string;
    consoleTail?: string;
}

const RULES: Array<{ category: FailureCategory; test: RegExp; advice: string }> = [
    {
        category: 'environment',
        test: /net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED|Executable doesn't exist|browserType\.launch|Cannot navigate to invalid URL|ERR_CERT|Missing [A-Z][A-Z0-9_]+\. Copy \.env\.example|Host system is missing dependencies|503 Service Unavailable|502 Bad Gateway/,
        advice: 'The app or the browser could not be reached. Check that the test environment is up, APP_BASE_URL is right, .env has every key, and browsers are installed (npx playwright install chromium).'
    },
    {
        category: 'script',
        test: /SyntaxError|TypeError|ReferenceError|is not a function|Cannot find module|has no exported member|is not defined|Unexpected token/,
        advice: 'The test code itself is broken (a typo, a missing import or a renamed member). Fix the code; the app is not at fault.'
    },
    {
        category: 'data',
        test: /No user with role|\b401\b|\b403\b|Unauthori[sz]ed|Forbidden|already exists|invalid credentials|Invalid (email|user ?name) or password|account (is )?locked/i,
        advice: 'Test data or accounts are wrong: check the test user in .env and test-data/, or create the data the test needs in the test itself.'
    },
    {
        category: 'locator',
        test: /strict mode violation|resolved to \d+ elements|waiting for (getBy|locator\()[^\n]*\n[^\n]*(Timeout|exceeded)|locator\.\w+: Timeout|Element is not (visible|attached|enabled|editable)|intercepts pointer events|element is outside of the viewport|not an <input>|Element is not a <select>/,
        advice: 'A locator did not match exactly one usable element. Compare it with .testpilot/exploration/README.md or the trace, prefer getByRole with the accessible name, and scope list items with filter({ hasText }).'
    },
    {
        category: 'assertion',
        test: /expect\(.*\)\.(not\.)?to\w+|Expected( string| pattern| substring| value)?:|Received( string| value)?:|toHave\w+ failed|toBe\w+ failed/,
        advice: 'The app did not show what the test case expects. Open the trace or screenshot: if the app is wrong, it is a bug to report (tag the test @known-issue); if the expectation is outdated, update the test case and the test together. Never weaken the assertion without the team agreeing.'
    },
    {
        category: 'timing',
        test: /Test timeout of \d+ms exceeded|page\.goto: Timeout|Navigation timeout|waitForURL|Target page, context or browser has been closed|Timeout \d+ms exceeded/,
        advice: 'Something took longer than allowed. Wait for a specific condition (an element, a response, a URL) instead of a fixed time; raise the timeout only if the app is genuinely slow.'
    }
];

const ANSI = /\u001b\[[0-9;]*m/g;

export function categorise(message: string): { category: FailureCategory; advice: string } {
    const text = message.replace(ANSI, '');
    for (const rule of RULES) if (rule.test.test(text)) return { category: rule.category, advice: rule.advice };
    return { category: 'unknown', advice: 'Open the trace (npx playwright show-trace <file>) to see what happened at the failing step.' };
}

/** Replaces every secret value from .env that appears in text, so error messages never leak credentials. */
export function secretScrubber(store: ProjectStore): (text: string) => string {
    const env = loadEnvValues(store, {});
    const values = Object.entries(env)
        .filter(([key, value]) => value && value.length >= 4 && !isSetting(key) && /(PASS|TOKEN|SECRET|KEY|PAT|PWD|CREDENTIAL|AUTH)/i.test(key))
        .map(([, value]) => value)
        .sort((a, b) => b.length - a.length);
    return text => values.reduce((out, v) => out.split(v).join('[REDACTED]'), text);
}

interface PwResult {
    status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
    duration: number;
    error?: { message?: string; stack?: string };
    errors?: Array<{ message?: string }>;
    attachments?: Array<{ name: string; path?: string; contentType: string }>;
}
interface PwTest {
    projectName: string;
    status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
    results: PwResult[];
    annotations?: Array<{ type: string; description?: string }>;
}
interface PwSpec {
    title: string;
    file: string;
    line: number;
    tags?: string[];
    tests: PwTest[];
}
interface PwSuite {
    title: string;
    file: string;
    specs?: PwSpec[];
    suites?: PwSuite[];
}

function* specsOf(suites: PwSuite[] = []): Generator<PwSpec> {
    for (const s of suites) {
        for (const spec of s.specs ?? []) yield spec;
        yield* specsOf(s.suites);
    }
}

/**
 * Reads Playwright's JSON report into one outcome per test and project. With
 * --repeat-each every repetition is reported as its own test; they are merged
 * here, so a test that passed in some repetitions and failed in others is flaky.
 */
export function parseReport(json: { config?: { rootDir?: string }; suites?: PwSuite[] }, cwd: string, scrub: (s: string) => string, repoRoot: string): TestOutcome[] {
    return mergeRepeats(readOutcomes(json, cwd, scrub, repoRoot));
}

function mergeRepeats(outcomes: TestOutcome[]): TestOutcome[] {
    const merged = new Map<string, TestOutcome>();
    for (const o of outcomes) {
        const key = `${o.file}:${o.line}:${o.title}:${o.project ?? ''}`;
        const seen = merged.get(key);
        if (!seen) {
            merged.set(key, { ...o, attachments: [...o.attachments] });
            continue;
        }
        seen.runs += o.runs;
        seen.passes += o.passes;
        seen.durationMs += o.durationMs;
        if (!seen.error && o.error) Object.assign(seen, { error: o.error, category: o.category, advice: o.advice });
        seen.attachments.push(...o.attachments.filter(a => !seen.attachments.some(b => b.path === a.path)));
        seen.status = seen.runs === 0 ? 'skipped' : seen.passes === seen.runs ? 'passed' : seen.passes === 0 ? 'failed' : 'flaky';
    }
    return [...merged.values()];
}

function readOutcomes(json: { config?: { rootDir?: string }; suites?: PwSuite[] }, cwd: string, scrub: (s: string) => string, repoRoot: string): TestOutcome[] {
    const out: TestOutcome[] = [];
    // Spec paths in the report are relative to the config's rootDir (its testDir).
    const rootDir = json.config?.rootDir ?? cwd;
    for (const spec of specsOf(json.suites)) {
        for (const t of spec.tests) {
            const key = t.annotations?.find(a => a.type === 'test_key')?.description ?? spec.title.match(/^([A-Za-z][\w.-]*-\d+|TC[-_]?\d+)\b/)?.[1] ?? spec.title;
            const ran = t.results.filter(r => r.status !== 'skipped');
            const passes = ran.filter(r => r.status === 'passed').length;
            const failed = ran.find(r => r.status !== 'passed');
            const status: TestOutcome['status'] = t.status === 'skipped' || !ran.length ? 'skipped' : passes === ran.length ? 'passed' : passes === 0 ? 'failed' : 'flaky';
            const rawError = failed ? (failed.error?.message ?? failed.errors?.map(e => e.message).join('\n') ?? `Test ${failed.status}`) : undefined;
            const error = rawError ? scrub(rawError.replace(ANSI, '')).split('\n').slice(0, 12).join('\n').slice(0, 1500) : undefined;
            const triage = error ? categorise(error) : undefined;
            const attachments = (failed?.attachments ?? [])
                .filter(a => a.path && ['trace', 'screenshot', 'video', 'error-context'].includes(a.name))
                .map(a => ({ name: a.name, path: path.relative(repoRoot, a.path!).split(path.sep).join('/') }));
            out.push({
                id: key,
                title: spec.title,
                file: path.relative(repoRoot, path.resolve(rootDir, spec.file)).split(path.sep).join('/'),
                line: spec.line,
                project: t.projectName,
                status,
                runs: ran.length,
                passes,
                durationMs: ran.reduce((n, r) => n + r.duration, 0),
                error,
                category: triage?.category,
                advice: triage?.advice,
                attachments
            });
        }
    }
    return out;
}

export interface RunOptions {
    cwd: string;
    files: string[];
    grep?: string;
    repeat: number;
    project?: string;
    workers?: number;
    timeoutMs: number;
    reportFile: string;
}

/** Runs Playwright and summarises the JSON report the TestPilot config writes. */
export async function runPlaywright(store: ProjectStore, options: RunOptions, run: (cwd: string, argv: string[], timeout: number) => Promise<CommandOutcome> = runCommand): Promise<RunSummary> {
    const argv = ['npx', 'playwright', 'test', ...options.files];
    if (options.grep) argv.push('--grep', options.grep);
    if (options.repeat > 1) argv.push('--repeat-each', String(options.repeat), '--retries', '0');
    if (options.project) argv.push('--project', options.project);
    if (options.workers) argv.push('--workers', String(options.workers));
    const startedAt = new Date();
    const outcome = await run(options.cwd, argv, options.timeoutMs);
    const finishedAt = new Date();
    const scrub = secretScrubber(store);
    const reportPath = path.resolve(options.cwd, options.reportFile);
    const fresh = existsSync(reportPath) && statSync(reportPath).mtimeMs >= startedAt.getTime() - 1000;
    const tests = fresh ? parseReport(JSON.parse(readFileSync(reportPath, 'utf8')), options.cwd, scrub, store.root) : [];
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
    return {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        command: argv.join(' '),
        exitCode: outcome.exitCode,
        repeat: options.repeat,
        stats,
        tests,
        byCategory,
        reportFile: fresh ? store.relative(reportPath) : undefined,
        consoleTail: fresh && tests.length ? undefined : scrub(outcome.tail.replace(ANSI, ''))
    };
}

/** Saves a run under .testpilot/runs/ and returns its path. */
export function saveRun(store: ProjectStore, summary: RunSummary): string {
    const file = `${RUNS_DIR}/${summary.startedAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}.json`;
    store.write(file, JSON.stringify(summary, null, 2) + '\n');
    store.write(`${RUNS_DIR}/latest.json`, JSON.stringify(summary, null, 2) + '\n');
    return file;
}

export function readLatestRun(store: ProjectStore): RunSummary | undefined {
    const raw = store.read(`${RUNS_DIR}/latest.json`);
    return raw ? (JSON.parse(raw) as RunSummary) : undefined;
}
