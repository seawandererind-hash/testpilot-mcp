import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { isSetting } from '../catalog/env-keys.js';
import { loadEnvValues } from '../core/env.js';
import { toPosix } from '../core/paths.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { runPlaywright } from '../run/playwright.js';
import type { CommandOutcome } from '../scaffold/engine.js';
import { canResolve, QUALITY_REPORTS_DIR, testRootOf } from './project.js';
import { blankComments, findJavaTests, findJsTests, type FoundTest, languageOf, lineAt, type SourceLanguage } from './source.js';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';
export type CheckId = 'compiles' | 'no-fixed-waits' | 'no-hardcoded-values' | 'real-assertions' | 'no-leftovers' | 'stable-locators' | 'runs-once';

export interface CheckItem {
    id: CheckId;
    label: string;
    status: CheckStatus;
    reason: string;
    lines?: number[];
}

export interface FileReport {
    file: string;
    language: SourceLanguage;
    tests: number;
    /** Tests TestPilot marked fixme (steps it could not translate): work to finish, not failures. */
    needsFinishing: number;
    verdict: 'pass' | 'warn' | 'fail';
    checks: CheckItem[];
}

export const CHECK_LABELS: Record<CheckId, string> = {
    compiles: 'Compiles',
    'no-fixed-waits': 'No fixed waits',
    'no-hardcoded-values': 'No hard-coded passwords or keys',
    'real-assertions': 'Real assertions',
    'no-leftovers': 'No focus or skip leftovers',
    'stable-locators': 'Stable locators',
    'runs-once': 'Runs once'
};

const item = (id: CheckId, status: CheckStatus, reason: string, lines?: number[]): CheckItem => ({ id, label: CHECK_LABELS[id], status, reason, ...(lines?.length ? { lines: [...new Set(lines)].sort((a, b) => a - b) } : {}) });

function worst(statuses: CheckStatus[]): 'pass' | 'warn' | 'fail' {
    return statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'pass';
}

const lineList = (lines: number[]) => (lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.slice(0, 8).join(', ')}${lines.length > 8 ? ', …' : ''}`);

function findAll(code: string, re: RegExp): number[] {
    const lines: number[] = [];
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = g.exec(code))) {
        lines.push(lineAt(code, m.index));
        if (m[0].length === 0) g.lastIndex++;
    }
    return [...new Set(lines)];
}

// ---- 2. fixed waits ----------------------------------------------------------

const WAIT_PATTERNS: Array<{ re: RegExp; what: string }> = [
    { re: /\.waitForTimeout\s*\(/, what: 'waitForTimeout' },
    { re: /new\s+Promise\s*\(\s*\(?\s*[\w$]*\s*(?:,\s*[\w$]*\s*)?\)?\s*=>\s*\{?\s*setTimeout\s*\(/, what: 'a setTimeout sleep' },
    { re: /\bawait\s+setTimeout\s*\(\s*\d/, what: 'a setTimeout sleep' },
    { re: /\bawait\s+(?:[\w$]+\.)*(?:sleep|delay|pause|wait)\s*\(\s*\d/, what: 'a sleep helper with a fixed time' },
    { re: /\bThread\.sleep\s*\(/, what: 'Thread.sleep' },
    { re: /\bTimeUnit\.\w+\.sleep\s*\(/, what: 'TimeUnit sleep' },
    { re: /\b(?:browser|driver)\.pause\s*\(/, what: 'browser.pause' },
    { re: /\bcy\.wait\s*\(\s*\d/, what: 'cy.wait with a number' }
];

export function checkFixedWaits(code: string): CheckItem {
    const hits: Array<{ line: number; what: string }> = [];
    for (const p of WAIT_PATTERNS) for (const line of findAll(code, p.re)) if (!hits.some(h => h.line === line)) hits.push({ line, what: p.what });
    if (!hits.length) return item('no-fixed-waits', 'pass', 'No fixed sleeps; the test waits for real conditions.');
    hits.sort((a, b) => a.line - b.line);
    const kinds = [...new Set(hits.map(h => h.what))].join(', ');
    return item(
        'no-fixed-waits',
        'fail',
        `Fixed wait (${kinds}) on ${lineList(hits.map(h => h.line))}. Fixed waits make tests slow and still flaky. Wait for something specific instead, e.g. await expect(locator).toBeVisible() or page.waitForResponse(...).`,
        hits.map(h => h.line)
    );
}

// ---- 3. hard-coded secrets -----------------------------------------------------

/** Values that are clearly not real secrets: placeholders and deliberately wrong values in negative tests. */
const HARMLESS_VALUE = /^(\$\{|process\.env|<|\*+$|x{3,}$)|wrong|invalid|incorrect|\bbad|fake|dummy|example|placeholder|sample|changeme|not-?a-?real|your[-_ ]?|redacted|\[.*\]/i;
const SECRETISH_NAME = /(password|passwd|pwd|secret|token|api_?key|access_?key|client_?secret)/i;
const TOKEN_PATTERNS: Array<{ re: RegExp; what: string }> = [
    { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/, what: 'a bearer token' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: 'a GitHub token' },
    { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, what: 'a GitHub token' },
    { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key' },
    { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: 'a JWT' },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' }
];

/** Secret values from .env, read inside the server only. The keys may be shown; the values never are. */
export function envSecrets(store: ProjectStore): Array<{ key: string; value: string }> {
    return Object.entries(loadEnvValues(store, {}))
        .filter(([key, value]) => value.length >= 6 && !isSetting(key) && /(PASS|TOKEN|SECRET|KEY|PAT|PWD|CREDENTIAL|AUTH)/i.test(key))
        .map(([key, value]) => ({ key, value }));
}

export function checkHardcoded(src: string, code: string, secrets: Array<{ key: string; value: string }>): CheckItem {
    const hits: Array<{ line: number; what: string }> = [];
    const add = (line: number, what: string) => {
        if (!hits.some(h => h.line === line && h.what === what)) hits.push({ line, what });
    };
    for (const { key, value } of secrets) {
        let at = src.indexOf(value);
        while (at !== -1) {
            add(lineAt(src, at), `the value of ${key} from .env`);
            at = src.indexOf(value, at + value.length);
        }
    }
    const assign = /\b([\w$]*?(?:password|passwd|pwd|secret|token|api_?key|access_?key)[\w$]*)["']?\s*[:=]\s*(['"`])([^'"`\n]{4,})\2/gi;
    let m: RegExpExecArray | null;
    while ((m = assign.exec(code))) if (!HARMLESS_VALUE.test(m[3]) && !/^[A-Z_]+$/.test(m[3])) add(lineAt(code, m.index), `a literal value for "${m[1]}"`);
    const lines = code.split('\n');
    lines.forEach((text, i) => {
        if (!SECRETISH_NAME.test(text) && !/\bpass\b/i.test(text)) return;
        const fill = text.match(/\.(?:fill|type|pressSequentially|sendKeys|setValue|addValue)\(\s*(?:[^,()]*,\s*)?(['"`])([^'"`\n]{4,})\1/);
        if (fill && !HARMLESS_VALUE.test(fill[2])) add(i + 1, 'a password typed as plain text');
    });
    for (const t of TOKEN_PATTERNS) for (const line of findAll(code, t.re)) add(line, t.what);
    if (!hits.length) return item('no-hardcoded-values', 'pass', secrets.length ? `No .env secret values and no password-looking strings in the code (checked ${secrets.length} secret(s) from .env without showing them).` : 'No password-looking strings in the code.');
    hits.sort((a, b) => a.line - b.line);
    return item(
        'no-hardcoded-values',
        'fail',
        `${hits.map(h => `Line ${h.line}: ${h.what}`).join('; ')}. Secrets in code end up in git history. Read them from .env instead (process.env.NAME or the requireEnv helper; System.getenv in Java) and rotate any real password that was committed.`,
        hits.map(h => h.line)
    );
}

// ---- 4. real assertions -------------------------------------------------------

const JS_ASSERT = /(^|[^\w$])(?:expect|assert)[\w$]*\s*[.(]|\.should\s*\(|\.expect[\w$]*\s*\(|\.(?:verify|check)[A-Z][\w$]*\s*\(|toHaveScreenshot|checkA11y|\.analyze\s*\(/;
const JAVA_ASSERT = /\b(?:assert\w*|Assert\.\w+|Assertions\.\w+|assertThat|verify\w*|softly\.\w+|expect\w*)\s*\(/;
const CONSTANT_JS = /\bexpect(?:\.soft)?\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`)\s*\)/;
const CONSTANT_JAVA = /\b(?:Assert\.|Assertions\.)?(?:assertTrue|assertFalse|assertNotNull|assertThat)\s*\(\s*(?:true|false|"[^"]*"|\d+)\s*\)/;
const COMMENTED_ASSERT = /^\s*(?:\/\/+|\/?\*+)\s*(?:await\s+)?(?:expect|assert|Assert\.|Assertions\.|softly\.)\w*\s*[.(]/;

export function checkAssertions(src: string, tests: FoundTest[], lang: SourceLanguage): CheckItem {
    if (!tests.length) return item('real-assertions', 'warn', 'No tests found in this file. If it is a helper, leave it out of the gate.');
    const problems: string[] = [];
    const warnings: string[] = [];
    const lines: number[] = [];
    const live = lang === 'java' ? JAVA_ASSERT : JS_ASSERT;
    const constant = lang === 'java' ? CONSTANT_JAVA : CONSTANT_JS;
    let checked = 0;
    for (const t of tests) {
        if (t.modifier === 'fixme' || t.disabled) continue;
        checked++;
        const body = t.body ?? '';
        const commented = src
            .slice(t.start, t.end)
            .split('\n')
            .map((text, i) => (COMMENTED_ASSERT.test(text) ? lineAt(src, t.start) + i : 0))
            .filter(Boolean);
        if (!body.replace(/[\s;]/g, '')) {
            problems.push(`"${t.title}" (line ${t.line}) is empty`);
            lines.push(t.line);
            continue;
        }
        const constantAt = body.search(constant);
        if (constantAt !== -1) {
            const at = lineAt(src, (t.bodyStart ?? t.start) + constantAt);
            problems.push(`"${t.title}" checks a fixed value on line ${at} (it can never fail)`);
            lines.push(at);
        }
        const real = body.replace(new RegExp(constant.source, 'g'), '');
        if (!live.test(real)) {
            if (constantAt !== -1 && !commented.length) continue;
            problems.push(`"${t.title}" (line ${t.line}) has no assertion${commented.length ? `; the assertion on ${lineList(commented)} is commented out` : ''}`);
            lines.push(t.line, ...commented);
        } else if (commented.length) {
            warnings.push(`"${t.title}" has a commented-out assertion on ${lineList(commented)}`);
            lines.push(...commented);
        }
    }
    const advice = 'A test without a real check passes even when the app is broken. Add an expect on what the user should see (text, URL, a visible element).';
    if (problems.length) return item('real-assertions', 'fail', `${problems.join('; ')}${warnings.length ? `; ${warnings.join('; ')}` : ''}. ${advice}`, [...new Set(lines)].sort((a, b) => a - b));
    if (warnings.length) return item('real-assertions', 'warn', `${warnings.join('; ')}. Remove it or turn it back on, so nobody thinks it is still checked.`, [...new Set(lines)].sort((a, b) => a - b));
    if (!checked) return item('real-assertions', 'pass', 'Every test here is marked fixme or disabled; assertions are checked once they are finished.');
    return item('real-assertions', 'pass', `All ${checked} test(s) check something real.`);
}

// ---- 5. focus / skip leftovers ----------------------------------------------

export function checkLeftovers(src: string, code: string, tests: FoundTest[], lang: SourceLanguage): { check: CheckItem; needsFinishing: number } {
    const fails: string[] = [];
    const warns: string[] = [];
    const lines: number[] = [];
    let needsFinishing = 0;
    if (lang === 'java') {
        for (const t of tests) {
            if (t.disabled && !t.disabled.reason) {
                warns.push(`"${t.title}" (line ${t.line}) is disabled without a reason`);
                lines.push(t.line);
            }
        }
        needsFinishing = findAll(src, /TODO\(testpilot\)/).length;
    } else {
        for (const line of findAll(code, /(?<![.\w$])(?:test|it|describe|context|test\.describe)(?:\.(?:serial|parallel))?\.only\s*\(|(?<![.\w$])f(?:it|describe)\s*\(/)) {
            fails.push(`.only on line ${line} (only this test would run in CI)`);
            lines.push(line);
        }
        for (const t of tests) {
            if (t.modifier === 'fixme') needsFinishing++;
            if (t.modifier === 'skip') {
                const before = src.slice(0, t.start).split('\n').slice(-2, -1)[0] ?? '';
                if (!/\/\/\s*\S|\*\s*\S/.test(before)) {
                    warns.push(`"${t.title}" (line ${t.line}) is skipped without a reason`);
                    lines.push(t.line);
                }
            }
        }
        // Inside a test: test.skip() or test.skip(condition) with no explanation string.
        const re = /(^|[^.\w$])test\.skip\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code))) {
            const inner = m[2];
            if (/=>|function/.test(inner)) continue;
            if (!/(['"`])[^'"`]+\1/.test(inner)) {
                const line = lineAt(code, m.index + m[1].length);
                warns.push(`test.skip on line ${line} gives no reason`);
                lines.push(line);
            }
        }
    }
    const finishing = needsFinishing ? ` ${needsFinishing} test(s) marked fixme need finishing (steps TestPilot could not translate; see the TODO(testpilot) comments).` : '';
    const status: CheckStatus = fails.length ? 'fail' : warns.length ? 'warn' : 'pass';
    const reason = fails.length || warns.length ? `${[...fails, ...warns].join('; ')}. Remove .only before committing, and give every skip a short reason so it is not forgotten.${finishing}` : `No .only or unexplained skips.${finishing}`;
    return { check: item('no-leftovers', status, reason.trim(), [...new Set(lines)].sort((a, b) => a - b)), needsFinishing };
}

// ---- 6. stable locators ------------------------------------------------------

const AUTOGEN_CLASS = /\.(?:css|sc|jss|emotion|styled|makeStyles|tw|svelte)-[a-z0-9]{4,}\b|\.[A-Za-z][\w-]*_[\w-]*__[A-Za-z0-9_-]{5}\b|\.[a-z]+-[a-f0-9]{6,}\b|\[class\*?=["']?(?:css|sc)-/i;

export function classifySelector(selector: string, viaXpathApi = false): { level: 'fail' | 'warn'; why: string } | undefined {
    const s = selector.trim();
    const xpath = viaXpathApi || /^(xpath=|\/\/|\/|\(\/\/|\.\/\/)/.test(s);
    if (xpath) {
        if (/^(xpath=)?\/(html|body)\b/i.test(s) || /\[\d+\]/.test(s)) return { level: 'fail', why: 'an absolute or position-based XPath' };
        return { level: 'warn', why: 'an XPath' };
    }
    if (AUTOGEN_CLASS.test(s)) return { level: 'fail', why: 'an auto-generated class name (changes with every build)' };
    if (/:nth-(child|of-type)\(/.test(s)) return { level: 'warn', why: 'a position-based selector (nth-child)' };
    // Count steps per selector in a list, ignoring spaces inside [attribute] and :pseudo(...) parts.
    const bare = s.replace(/\[[^\]]*\]/g, '[]').replace(/\([^)]*\)/g, '()');
    const longest = Math.max(...bare.split(',').map(one => one.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).length));
    if (longest >= 4) return { level: 'warn', why: `a long CSS chain (${longest} steps)` };
    return undefined;
}

export function checkLocators(code: string, lang: SourceLanguage): CheckItem {
    const found: Array<{ line: number; level: 'fail' | 'warn'; why: string }> = [];
    const scan = (re: RegExp, xpathGroup?: number) => {
        let m: RegExpExecArray | null;
        while ((m = re.exec(code))) {
            const selector = m[m.length - 1];
            const c = classifySelector(selector, xpathGroup !== undefined && /xpath/i.test(m[xpathGroup]));
            if (c) found.push({ line: lineAt(code, m.index), ...c });
        }
    };
    if (lang === 'java') {
        scan(/By\.(xpath|cssSelector|className)\s*\(\s*"((?:\\.|[^"])*)"/g, 1);
        scan(/(?:\$\$?|\$x)\s*\(\s*"((?:\\.|[^"])*)"/g);
    } else {
        scan(/\b(?:locator|\$\$?|\$x|querySelector(?:All)?|waitForSelector|frameLocator)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g);
        scan(/\bpage\.(?:click|dblclick|fill|type|check|uncheck|hover|press|selectOption|textContent|innerText|isVisible|tap)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g);
    }
    const preferred = findAll(code, /getBy(?:Role|Label|TestId|Text|Placeholder|AltText|Title)\s*\(|AppiumBy\.accessibilityId|By\.id\s*\(/).length;
    if (!found.length) return item('stable-locators', 'pass', preferred ? `Uses user-facing locators (getByRole, getByLabel, getByTestId) and no fragile selectors.` : 'No fragile selectors found.');
    found.sort((a, b) => a.line - b.line);
    const status: CheckStatus = found.some(f => f.level === 'fail') ? 'fail' : 'warn';
    return item(
        'stable-locators',
        status,
        `${found.map(f => `Line ${f.line}: ${f.why}`).join('; ')}. These break when the page layout or styling changes. Prefer getByRole with the accessible name, getByLabel for form fields, or getByTestId with a data-testid the developers add.`,
        [...new Set(found.map(f => f.line))]
    );
}

/** Checks 2 to 6 for one file. Pure: no files, no programs. */
export function scanSource(content: string, lang: SourceLanguage, secrets: Array<{ key: string; value: string }> = []): { checks: CheckItem[]; tests: number; needsFinishing: number } {
    const code = blankComments(content);
    const tests = lang === 'java' ? findJavaTests(content) : findJsTests(content);
    const leftovers = checkLeftovers(content, code, tests, lang);
    return {
        checks: [checkFixedWaits(code), checkHardcoded(content, code, secrets), checkAssertions(content, tests, lang), leftovers.check, checkLocators(code, lang)],
        tests: tests.length,
        needsFinishing: leftovers.needsFinishing
    };
}

// ---- files -------------------------------------------------------------------

const SPEC_FILE = /\.(spec|test)\.(ts|js|mjs|cjs|tsx|jsx)$/;

function walk(dir: string, accept: (name: string) => boolean, out: string[] = [], depth = 0): string[] {
    if (depth > 12 || !existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, accept, out, depth + 1);
        else if (accept(name)) out.push(full);
    }
    return out;
}

/** Default gate files: every spec the test cases point to, plus the specs under tests/ (or src/test/java for Java). */
export function defaultGateFiles(store: ProjectStore, config: Config): string[] {
    const { rel } = testRootOf(store, config);
    const files = new Set<string>();
    for (const tc of store.readCases()) if (tc.automation?.specFile && store.exists(tc.automation.specFile)) files.add(toPosix(tc.automation.specFile));
    for (const f of walk(store.resolve(path.posix.join(rel || '.', 'tests')), name => SPEC_FILE.test(name))) files.add(store.relative(f));
    if (config.stack.language === 'java') for (const f of walk(store.resolve(path.posix.join(rel || '.', 'src/test/java')), name => name.endsWith('.java'))) files.add(store.relative(f));
    return [...files].sort();
}

/** Resolves user-given files: relative to the test folder first, then to the repository. */
export function resolveGateFiles(store: ProjectStore, config: Config, given: string[]): { files: string[]; missing: string[] } {
    const { rel } = testRootOf(store, config);
    const files: string[] = [];
    const missing: string[] = [];
    for (const g of given) {
        const inRoot = rel ? path.posix.join(rel, g) : g;
        const pick = store.exists(inRoot) ? inRoot : store.exists(g) ? g : undefined;
        if (pick) files.push(store.relative(store.resolve(pick)));
        else missing.push(g);
    }
    return { files: [...new Set(files)], missing };
}

// ---- programs ----------------------------------------------------------------

export interface ExecOutcome {
    exitCode: number | null;
    output: string;
}
export type Exec = (cwd: string, argv: string[], timeoutMs: number) => Promise<ExecOutcome>;

/** Runs a command and keeps up to 400 KB of output (enough for a full tsc error list). */
export const defaultExec: Exec = (cwd, argv, timeoutMs) =>
    new Promise(resolve => {
        const [cmd, ...args] = argv;
        const child = spawn(cmd, args, { cwd, env: process.env, shell: process.platform === 'win32', windowsHide: true });
        let out = '';
        const keep = (chunk: Buffer) => {
            if (out.length < 400_000) out += chunk.toString();
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        child.on('error', error => {
            clearTimeout(timer);
            resolve({ exitCode: null, output: String(error.message) });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ exitCode: code, output: out });
        });
    });

export interface CompileResult {
    perFile: Map<string, Array<{ line: number; message: string }>>;
    /** Files that could not be compiled at all, with the reason (skipped). */
    skipped: Map<string, string>;
    otherErrors: number;
    notes: string[];
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Parses `file(line,col): error TS1234: message` lines into repository paths. */
export function parseTscOutput(output: string, cwd: string, toRepo: (abs: string) => string): Map<string, Array<{ line: number; message: string }>> {
    const map = new Map<string, Array<{ line: number; message: string }>>();
    for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
        const m = raw.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
        if (!m) continue;
        const file = toRepo(path.resolve(cwd, m[1]));
        const list = map.get(file) ?? [];
        list.push({ line: Number(m[2]), message: `${m[4]}: ${m[5]}` });
        map.set(file, list);
    }
    return map;
}

/** Parses `[ERROR] /path/File.java:[12,5] message` lines from Maven. */
export function parseMavenOutput(output: string, toRepo: (abs: string) => string): Map<string, Array<{ line: number; message: string }>> {
    const map = new Map<string, Array<{ line: number; message: string }>>();
    for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
        const m = raw.match(/^\[ERROR\]\s+(.+?\.java):\[(\d+),(\d+)\]\s*(.*)$/);
        if (!m) continue;
        const file = toRepo(path.resolve(m[1]));
        const list = map.get(file) ?? [];
        list.push({ line: Number(m[2]), message: m[4] });
        map.set(file, list);
    }
    return map;
}

export async function compileFiles(store: ProjectStore, config: Config, files: string[], exec: Exec): Promise<CompileResult> {
    const { cwd } = testRootOf(store, config);
    const result: CompileResult = { perFile: new Map(), skipped: new Map(), otherErrors: 0, notes: [] };
    const toRepo = (abs: string) => {
        try {
            return store.relative(abs);
        } catch {
            return abs;
        }
    };
    const ts = files.filter(f => languageOf(f) === 'ts');
    const js = files.filter(f => languageOf(f) === 'js');
    const java = files.filter(f => languageOf(f) === 'java');
    if (ts.length) {
        const why = !existsSync(path.join(cwd, 'tsconfig.json'))
            ? 'No tsconfig.json in the test folder, so TypeScript was not checked. Add one (scaffold_project creates it).'
            : !canResolve(cwd, 'typescript')
              ? 'TypeScript is not installed in the test folder (npm i -D typescript), so the code was not type-checked.'
              : undefined;
        if (why) for (const f of ts) result.skipped.set(f, why);
        else {
            const out = await exec(cwd, ['npx', 'tsc', '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], 5 * 60_000);
            if (out.exitCode === null) for (const f of ts) result.skipped.set(f, `Could not run the TypeScript compiler: ${out.output.split('\n')[0]}`);
            else {
                const parsed = parseTscOutput(out.output, cwd, toRepo);
                for (const [file, errors] of parsed) {
                    if (ts.includes(file)) result.perFile.set(file, errors);
                    else result.otherErrors += errors.length;
                }
                if (result.otherErrors) result.notes.push(`The TypeScript compiler also found ${result.otherErrors} error(s) in files outside this check (page objects, helpers or config). Run npx tsc --noEmit in the test folder to see them.`);
                if (out.exitCode !== 0 && !parsed.size) result.notes.push(`The TypeScript compiler failed without file errors: ${out.output.replace(ANSI, '').trim().split('\n').slice(-3).join(' ')}`);
            }
        }
    }
    for (const f of js) {
        const out = await exec(cwd, [process.execPath, '--check', store.resolve(f)], 60_000);
        if (out.exitCode === null) result.skipped.set(f, `Could not run node --check: ${out.output.split('\n')[0]}`);
        else if (out.exitCode !== 0) {
            const text = out.output.replace(ANSI, '');
            const line = Number(text.match(/:(\d+)\r?\n/)?.[1] ?? 0);
            const message = text.match(/^(SyntaxError|ReferenceError|TypeError|Error)[^\n]*/m)?.[0] ?? text.trim().split('\n').slice(-1)[0];
            result.perFile.set(f, [{ line, message }]);
        }
    }
    if (java.length) {
        const pom = existsSync(path.join(cwd, 'pom.xml'));
        if (!pom) for (const f of java) result.skipped.set(f, 'Java compile check needs a Maven project (pom.xml). With Gradle, run ./gradlew compileTestJava yourself.');
        else {
            const out = await exec(cwd, ['mvn', '-q', '-DskipTests', 'test-compile'], 10 * 60_000);
            if (out.exitCode === null) for (const f of java) result.skipped.set(f, 'Maven (mvn) is not installed or not on PATH, so the Java code was not compiled. Install Maven or run the build in your IDE.');
            else {
                const parsed = parseMavenOutput(out.output, abs => toRepo(path.isAbsolute(abs) ? abs : path.resolve(cwd, abs)));
                for (const [file, errors] of parsed) if (java.includes(file)) result.perFile.set(file, errors);
                if (out.exitCode !== 0 && !parsed.size) result.notes.push(`Maven failed without compile errors in these files: ${out.output.replace(ANSI, '').trim().split('\n').slice(-3).join(' ')}`);
            }
        }
    }
    return result;
}

function compileItem(file: string, compiled: CompileResult): CheckItem {
    const skipped = compiled.skipped.get(file);
    if (skipped) return item('compiles', 'skipped', skipped);
    const errors = compiled.perFile.get(file);
    if (!errors?.length) return item('compiles', 'pass', 'No compile errors.');
    return item(
        'compiles',
        'fail',
        `${errors.length} compile error(s): ${errors
            .slice(0, 3)
            .map(e => `line ${e.line}: ${e.message.replace(/\.$/, '')}`)
            .join('; ')}${errors.length > 3 ? '; …' : ''}. The test cannot run until this is fixed.`,
        errors.map(e => e.line)
    );
}

export interface GateOptions {
    files: string[];
    run: boolean;
    timeoutMs: number;
}

export interface GateOutcome {
    verdict: 'ready' | 'ready-with-warnings' | 'needs-work';
    files: FileReport[];
    notes: string[];
    reportFile: string;
    totals: { files: number; passed: number; warned: number; failed: number; tests: number; needsFinishing: number };
    runCommand?: string;
}

/** Runs the whole checklist over the files and writes .testpilot/reports/quality-gate.md. */
export async function runGate(store: ProjectStore, config: Config, options: GateOptions, exec: Exec = defaultExec): Promise<GateOutcome> {
    const secrets = envSecrets(store);
    const compiled = await compileFiles(store, config, options.files, exec);
    const notes = [...compiled.notes];
    const reports: FileReport[] = [];
    for (const file of options.files) {
        const language = languageOf(file)!;
        const scanned = scanSource(store.read(file) ?? '', language, secrets);
        reports.push({ file, language, tests: scanned.tests, needsFinishing: scanned.needsFinishing, verdict: 'pass', checks: [compileItem(file, compiled), ...scanned.checks] });
    }
    let runCommandLine: string | undefined;
    if (options.run) {
        const runnable = reports.filter(r => r.language !== 'java');
        const { rel, cwd } = testRootOf(store, config);
        if (runnable.length) {
            const toRoot = (f: string) => (rel ? path.posix.relative(rel, f) : f);
            const run = await runPlaywright(
                store,
                { cwd, files: runnable.map(r => toRoot(r.file)), repeat: 1, timeoutMs: options.timeoutMs, reportFile: 'test-results/results.json' },
                async (c, argv, t): Promise<CommandOutcome> => {
                    const out = await exec(c, argv, t);
                    return { command: argv.join(' '), ok: out.exitCode === 0, exitCode: out.exitCode, tail: out.output.split(/\r?\n/).slice(-25).join('\n') };
                }
            );
            runCommandLine = run.command;
            for (const r of runnable) {
                const outcomes = run.tests.filter(t => t.file === r.file);
                const failed = outcomes.filter(t => t.status === 'failed' || t.status === 'flaky');
                const passed = outcomes.filter(t => t.status === 'passed');
                const focused = reports.some(x => x.checks.some(c => c.id === 'no-leftovers' && c.reason.includes('.only')));
                if (!outcomes.length) r.checks.push(item('runs-once', 'warn', run.stats.total ? `No results for this file${focused ? ' (a .only in another file limited the run to that test)' : ' (no tests matched)'}.` : `No results were produced (exit code ${run.exitCode}). ${run.consoleTail ? run.consoleTail.split('\n').slice(-3).join(' ') : ''}`.trim()));
                else if (failed.length) r.checks.push(item('runs-once', 'fail', `${failed.length} of ${outcomes.length} test(s) failed: ${failed.slice(0, 3).map(t => `"${t.title}"${t.category ? ` (likely ${t.category})` : ''}`).join(', ')}. run_tests shows the cause and the trace.`, failed.map(t => t.line ?? 0).filter(Boolean)));
                else if (passed.length) r.checks.push(item('runs-once', 'pass', `${passed.length} test(s) passed${outcomes.length > passed.length ? `, ${outcomes.length - passed.length} skipped` : ''}.`));
                else r.checks.push(item('runs-once', 'warn', 'Every test in this file was skipped.'));
            }
        }
        for (const r of reports.filter(x => x.language === 'java')) r.checks.push(item('runs-once', 'skipped', 'TestPilot runs Playwright tests only. Run the Java tests with mvn test.'));
    }
    for (const r of reports) r.verdict = worst(r.checks.map(c => c.status));
    const totals = {
        files: reports.length,
        passed: reports.filter(r => r.verdict === 'pass').length,
        warned: reports.filter(r => r.verdict === 'warn').length,
        failed: reports.filter(r => r.verdict === 'fail').length,
        tests: reports.reduce((n, r) => n + r.tests, 0),
        needsFinishing: reports.reduce((n, r) => n + r.needsFinishing, 0)
    };
    const verdict: GateOutcome['verdict'] = totals.failed ? 'needs-work' : totals.warned ? 'ready-with-warnings' : 'ready';
    const reportFile = `${QUALITY_REPORTS_DIR}/quality-gate.md`;
    store.write(reportFile, renderGateMarkdown(reports, verdict, totals, notes, options.run));
    return { verdict, files: reports, notes, reportFile, totals, runCommand: runCommandLine };
}

const ICON: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skipped: 'SKIPPED' };

export const VERDICT_TEXT: Record<GateOutcome['verdict'], string> = {
    ready: 'Ready: every file passed every check.',
    'ready-with-warnings': 'Ready with warnings: nothing blocks these tests, but some things are worth tidying.',
    'needs-work': 'Needs work: at least one file failed a check. Fix the FAIL items before trusting these tests.'
};

export function renderGateMarkdown(reports: FileReport[], verdict: GateOutcome['verdict'], totals: GateOutcome['totals'], notes: string[], ran: boolean): string {
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const lines = [
        '# Test quality gate',
        '',
        `Checked ${totals.files} file(s) with ${totals.tests} test(s) on ${new Date().toISOString().slice(0, 10)}.${ran ? ' The tests were also run once.' : ' The tests were not run (pass run: true to run them once).'}`,
        '',
        `**${VERDICT_TEXT[verdict]}**`,
        '',
        `${totals.passed} passed, ${totals.warned} with warnings, ${totals.failed} failed.${totals.needsFinishing ? ` ${totals.needsFinishing} test(s) marked fixme need finishing (not counted as failures).` : ''}`,
        ''
    ];
    if (notes.length) lines.push(...notes.map(n => `> ${n}`), '');
    for (const r of reports) {
        lines.push(`## ${r.file} (${ICON[r.verdict]})`, '', `${r.tests} test(s)${r.needsFinishing ? `, ${r.needsFinishing} need finishing` : ''}.`, '', '| Check | Result | Details |', '|---|---|---|');
        for (const c of r.checks) lines.push(`| ${c.label} | ${ICON[c.status]} | ${cell(c.reason)} |`);
        lines.push('');
    }
    lines.push('Generated by TestPilot quality_scan (action "gate"). The check reads the code only; secret values from .env are compared inside TestPilot and never written here.', '');
    return lines.join('\n');
}
