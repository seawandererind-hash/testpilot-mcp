/**
 * Small, dependency-free source helpers for the quality gate: blanking comments while
 * keeping offsets, matching brackets and finding the tests in a file.
 * They work on TypeScript, JavaScript and Java well enough for checklists; they are
 * not full parsers.
 */

export type SourceLanguage = 'ts' | 'js' | 'java';

export function languageOf(file: string): SourceLanguage | undefined {
    if (/\.(ts|tsx|mts|cts)$/i.test(file)) return 'ts';
    if (/\.(js|jsx|mjs|cjs)$/i.test(file)) return 'js';
    if (/\.java$/i.test(file)) return 'java';
    return undefined;
}

/** Replaces comments with spaces (newlines kept), so offsets and line numbers stay the same. Strings are kept. */
export function blankComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (c === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? src.length : end + 2;
            for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const end = stringEnd(src, i);
            out += src.slice(i, end);
            i = end;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** Index just after the string literal starting at `start`. */
function stringEnd(src: string, start: number): number {
    const quote = src[start];
    let i = start + 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === quote) return i + 1;
        if (c === '\n' && quote !== '`') return i;
        i++;
    }
    return src.length;
}

/** Index of the bracket closing the one at `open` (skipping strings), or -1. Expects comments already blanked. */
export function matchClose(code: string, open: number): number {
    const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
    const stack: string[] = [];
    for (let i = open; i < code.length; i++) {
        const c = code[i];
        if (c === '"' || c === "'" || c === '`') {
            i = stringEnd(code, i) - 1;
            continue;
        }
        if (pairs[c]) stack.push(pairs[c]);
        else if (c === ')' || c === '}' || c === ']') {
            if (stack.pop() !== c) return -1;
            if (!stack.length) return i;
        }
    }
    return -1;
}

export function lineAt(src: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
    return line;
}

export interface FoundTest {
    title: string;
    line: number;
    /** Offsets of the whole declaration in the source. */
    start: number;
    end: number;
    /** The test function's body (comments blanked); undefined when it could not be read. */
    body?: string;
    /** Offset of the body in the source. */
    bodyStart?: number;
    modifier?: 'only' | 'skip' | 'fixme' | 'fail' | 'slow';
    /** Java: @Disabled / @Ignore / enabled = false, with or without a reason. */
    disabled?: { reason: boolean };
}

/** Finds Playwright / Mocha / Jest style tests: test('title', async () => { ... }). */
export function findJsTests(src: string): FoundTest[] {
    const code = blankComments(src);
    const tests: FoundTest[] = [];
    const re = /(^|[^.\w$])(test|it)(?:\.(only|skip|fixme|fail|slow))?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(code, open);
        if (close === -1) continue;
        const args = code.slice(open + 1, close);
        // A declaration has a function argument; test.skip(cond, 'why') inside a test is an annotation.
        const fn = args.match(/(=>\s*\{|function\s*\w*\s*\([^)]*\)\s*\{)/);
        const arrowExpr = !fn && /=>/.test(args);
        if (!fn && !arrowExpr) continue;
        const title = args.match(/^\s*(['"`])((?:\\.|(?!\1).)*)\1/)?.[2] ?? '(untitled)';
        let body: string | undefined;
        let bodyStart: number | undefined;
        if (fn) {
            const braceAt = open + 1 + (fn.index ?? 0) + fn[0].length - 1;
            const braceClose = matchClose(code, braceAt);
            if (braceClose !== -1) {
                body = code.slice(braceAt + 1, braceClose);
                bodyStart = braceAt + 1;
            }
        } else {
            bodyStart = open + 1 + args.indexOf('=>') + 2;
            body = args.slice(args.indexOf('=>') + 2);
        }
        const start = m.index + m[1].length;
        tests.push({ title, line: lineAt(src, start), start, end: close + 1, body, bodyStart, modifier: m[3] as FoundTest['modifier'] });
        re.lastIndex = close;
    }
    return tests;
}

/** Finds JUnit / TestNG test methods (@Test, @ParameterizedTest, @RepeatedTest). */
export function findJavaTests(src: string): FoundTest[] {
    const code = blankComments(src);
    const tests: FoundTest[] = [];
    const re = /((?:@\w+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)+)(?:(?:public|protected|private|static|final|synchronized)\s+)*void\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
        const annotations = m[1];
        if (!/@(Test|ParameterizedTest|RepeatedTest|TestFactory)\b/.test(annotations)) continue;
        const braceAt = m.index + m[0].length - 1;
        const close = matchClose(code, braceAt);
        if (close === -1) continue;
        let disabled: FoundTest['disabled'];
        const dis = annotations.match(/@(Disabled|Ignore)\b(\s*\(\s*("[^"]*")?\s*\))?/);
        if (dis) disabled = { reason: Boolean(dis[3] && dis[3].length > 2) };
        else if (/enabled\s*=\s*false/.test(annotations)) disabled = { reason: /description\s*=\s*"[^"]+"/.test(annotations) };
        const start = m.index;
        tests.push({ title: m[2], line: lineAt(src, start + (m[0].length - m[0].trimStart().length)), start, end: close + 1, body: code.slice(braceAt + 1, close), bodyStart: braceAt + 1, disabled });
        re.lastIndex = close;
    }
    return tests;
}
