import { parseAriaSnapshot } from '../explore/web.js';

/**
 * Locator helpers for healing: read the locator a failed test was waiting for,
 * find where it is written, compare it with what the page really showed, and
 * render a replacement in the same quote style.
 */

export type LocatorKind = 'role' | 'label' | 'text' | 'testid' | 'placeholder' | 'alt' | 'title' | 'css';

const KIND_BY_METHOD: Record<string, LocatorKind> = {
    getByRole: 'role',
    getByLabel: 'label',
    getByText: 'text',
    getByTestId: 'testid',
    getByPlaceholder: 'placeholder',
    getByAltText: 'alt',
    getByTitle: 'title',
    locator: 'css'
};
const METHOD_BY_KIND = Object.fromEntries(Object.entries(KIND_BY_METHOD).map(([m, k]) => [k, m])) as Record<LocatorKind, string>;

export interface ParsedLocator {
    kind: LocatorKind;
    method: string;
    /** For getByRole: the role. */
    role?: string;
    /** The accessible name (getByRole), or the first argument of the other methods. Empty when getByRole has no name. */
    value: string;
    regex?: boolean;
    exact?: boolean;
}

// ---- a tiny parser for locator calls -----------------------------------------

type Value =
    | { type: 'string'; value: string; quote: string; start: number; end: number }
    | { type: 'regex'; source: string; flags: string; start: number; end: number }
    | { type: 'object'; props: Record<string, Value>; start: number; end: number }
    | { type: 'other'; raw: string; start: number; end: number };

export interface ParsedCall {
    method: string;
    args: Value[];
    /** Absolute offsets of the whole call `getByRole(...)` in the parsed text. */
    start: number;
    end: number;
}

function skipSpace(s: string, i: number): number {
    while (i < s.length && /\s/.test(s[i])) i++;
    return i;
}

function parseValue(s: string, i: number): Value | undefined {
    i = skipSpace(s, i);
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
        let out = '';
        let j = i + 1;
        while (j < s.length && s[j] !== c) {
            if (s[j] === '\\' && j + 1 < s.length) {
                const n = s[j + 1];
                out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
                j += 2;
                continue;
            }
            if (c === '`' && s[j] === '$' && s[j + 1] === '{') return undefined;
            out += s[j++];
        }
        if (j >= s.length) return undefined;
        return { type: 'string', value: out, quote: c, start: i, end: j + 1 };
    }
    if (c === '/') {
        let j = i + 1;
        let inClass = false;
        while (j < s.length && (s[j] !== '/' || inClass)) {
            if (s[j] === '\\') j++;
            else if (s[j] === '[') inClass = true;
            else if (s[j] === ']') inClass = false;
            else if (s[j] === '\n') return undefined;
            j++;
        }
        if (j >= s.length) return undefined;
        const source = s.slice(i + 1, j);
        let k = j + 1;
        while (k < s.length && /[a-z]/.test(s[k])) k++;
        return { type: 'regex', source, flags: s.slice(j + 1, k), start: i, end: k };
    }
    if (c === '{') {
        const props: Record<string, Value> = {};
        let j = skipSpace(s, i + 1);
        while (j < s.length && s[j] !== '}') {
            const key = s.slice(j).match(/^(['"]?)([A-Za-z_$][\w$]*)\1\s*:/);
            if (!key) {
                // Shorthand or spread: skip to the next comma at this depth.
                const other = skipOther(s, j, '}');
                if (other === undefined) return undefined;
                j = other;
            } else {
                const v = parseValue(s, j + key[0].length);
                if (!v) return undefined;
                props[key[2]] = v;
                j = v.end;
            }
            j = skipSpace(s, j);
            if (s[j] === ',') j = skipSpace(s, j + 1);
        }
        if (s[j] !== '}') return undefined;
        return { type: 'object', props, start: i, end: j + 1 };
    }
    const end = skipOther(s, i, ')');
    if (end === undefined || end === i) return undefined;
    return { type: 'other', raw: s.slice(i, end).trim(), start: i, end };
}

/** Skips an expression we do not need to understand, up to a comma or the closing bracket at depth 0. */
function skipOther(s: string, i: number, closer: string): number | undefined {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        const c = s[j];
        if (c === "'" || c === '"' || c === '`') {
            const v = parseValue(s, j);
            if (!v) return undefined;
            j = v.end - 1;
        } else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) return c === closer || closer === ')' ? j : undefined;
            depth--;
        } else if (c === ',' && depth === 0) return j;
    }
    return undefined;
}

/** Parses `method(args)` starting at `start` (the first letter of the method name). */
export function parseCallAt(s: string, start: number): ParsedCall | undefined {
    const m = s.slice(start).match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) return undefined;
    const args: Value[] = [];
    let i = skipSpace(s, start + m[0].length);
    while (i < s.length && s[i] !== ')') {
        const v = parseValue(s, i);
        if (!v) return undefined;
        args.push(v);
        i = skipSpace(s, v.end);
        if (s[i] === ',') i = skipSpace(s, i + 1);
        else if (s[i] !== ')') return undefined;
    }
    if (s[i] !== ')') return undefined;
    return { method: m[1], args, start, end: i + 1 };
}

/** Turns a parsed call into a locator description, or undefined when it is not a literal locator. */
export function toLocator(call: ParsedCall): ParsedLocator | undefined {
    const kind = KIND_BY_METHOD[call.method];
    if (!kind) return undefined;
    const [first, second] = call.args;
    const literal = (v?: Value) => (v?.type === 'string' ? { value: v.value } : v?.type === 'regex' ? { value: v.source, regex: true } : undefined);
    if (kind === 'role') {
        if (first?.type !== 'string') return undefined;
        const opts = second?.type === 'object' ? second.props : {};
        const name = opts.name ? literal(opts.name) : { value: '' };
        if (!name) return undefined;
        const exact = opts.exact?.type === 'other' ? opts.exact.raw === 'true' : undefined;
        return { kind, method: call.method, role: first.value, value: name.value, regex: 'regex' in name ? name.regex : undefined, exact };
    }
    const v = literal(first);
    if (!v) return undefined;
    const opts = second?.type === 'object' ? second.props : {};
    const exact = opts.exact?.type === 'other' ? opts.exact.raw === 'true' : undefined;
    return { kind, method: call.method, value: v.value, regex: 'regex' in v ? v.regex : undefined, exact };
}

/** All locator calls (getBy... or locator(...)) in a piece of text, in order. */
export function findLocatorCalls(text: string): Array<{ call: ParsedCall; locator: ParsedLocator }> {
    const out: Array<{ call: ParsedCall; locator: ParsedLocator }> = [];
    const re = /(?<![\w$])(getBy(?:Role|Label|Text|TestId|Placeholder|AltText|Title)|locator)\s*\(/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const call = parseCallAt(text, m.index);
        const locator = call && toLocator(call);
        if (call && locator) out.push({ call, locator });
    }
    return out;
}

export interface FailedLocator {
    locator: ParsedLocator;
    /** The locator chain as Playwright printed it. */
    printed: string;
    /** strict-mode violations match too many elements; renaming does not fix them. */
    strict: boolean;
}

/** Reads the locator a failed action was waiting for from Playwright's error text. */
export function extractFailedLocator(error: string): FailedLocator | undefined {
    const text = error.replace(/\u001b\[[0-9;]*m/g, '');
    const strict = text.match(/strict mode violation:\s*(.+?)\s+resolved to \d+ elements/);
    const waiting = [...text.matchAll(/waiting for (.+)$/gm)].map(m => m[1].trim());
    const candidates = strict ? [strict[1]] : waiting.reverse();
    for (const printed of candidates) {
        const calls = findLocatorCalls(printed);
        const last = calls.at(-1);
        if (last) return { locator: last.locator, printed, strict: Boolean(strict) };
    }
    // An expect() that timed out prints "Locator: getByRole(...)".
    const loc = text.match(/^\s*Locator:\s*(.+)$/m);
    if (loc) {
        const last = findLocatorCalls(loc[1]).at(-1);
        if (last) return { locator: last.locator, printed: loc[1].trim(), strict: false };
    }
    return undefined;
}

export function sameLocator(a: ParsedLocator, b: ParsedLocator): boolean {
    return a.kind === b.kind && (a.role ?? '') === (b.role ?? '') && a.value === b.value && Boolean(a.regex) === Boolean(b.regex);
}

// ---- rendering -----------------------------------------------------------------

export function quoteWith(s: string, q: string): string {
    const esc = s.replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ');
    return q === '"' ? `"${esc.replace(/"/g, '\\"')}"` : q === '`' ? `\`${esc.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`` : `'${esc.replace(/'/g, "\\'")}'`;
}

export interface NewLocator {
    kind: LocatorKind;
    role?: string;
    value: string;
}

export function renderLocator(l: NewLocator, q = "'"): string {
    if (l.kind === 'role') return l.value ? `getByRole(${quoteWith(l.role ?? 'button', q)}, { name: ${quoteWith(l.value, q)} })` : `getByRole(${quoteWith(l.role ?? 'button', q)})`;
    return `${METHOD_BY_KIND[l.kind]}(${quoteWith(l.value, q)})`;
}

export function printLocator(l: ParsedLocator | NewLocator): string {
    const p = l as ParsedLocator;
    if (p.regex) return l.kind === 'role' ? `getByRole('${l.role}', { name: /${l.value}/ })` : `${METHOD_BY_KIND[l.kind]}(/${l.value}/)`;
    return renderLocator(l);
}

const ROLE_WORDS: Record<string, string> = { textbox: 'field', searchbox: 'search field', combobox: 'drop-down', checkbox: 'checkbox', radio: 'radio button', menuitem: 'menu item', spinbutton: 'number field', img: 'image' };
export function roleWord(role: string): string {
    return ROLE_WORDS[role] ?? role;
}

/** "the button 'Sign in'" and similar, for plain-language stories. */
export function describeLocator(l: ParsedLocator | NewLocator): string {
    switch (l.kind) {
        case 'role':
            return l.value ? `the ${roleWord(l.role ?? '')} '${l.value}'` : `the ${roleWord(l.role ?? '')}`;
        case 'label':
            return `the field labelled '${l.value}'`;
        case 'text':
            return `the text '${l.value}'`;
        case 'testid':
            return `the element with test id '${l.value}'`;
        case 'placeholder':
            return `the field with placeholder '${l.value}'`;
        case 'alt':
            return `the image '${l.value}'`;
        case 'title':
            return `the element titled '${l.value}'`;
        default:
            return `the element matching '${l.value}'`;
    }
}

// ---- similarity -------------------------------------------------------------------

const SYNONYMS: Array<[RegExp, string]> = [
    [/\b(log ?in|sign ?in|log ?on|sign ?on)\b/g, 'signin'],
    [/\b(log ?out|sign ?out|log ?off|sign ?off)\b/g, 'signout'],
    [/\b(sign ?up|register|create (an )?account|join)\b/g, 'signup'],
    [/\b(basket|cart|bag)\b/g, 'cart'],
    [/\b(e ?mail( address)?)\b/g, 'email'],
    [/\b(submit|send|save|confirm|ok)\b/g, 'submit'],
    [/\b(search|find)\b/g, 'search'],
    [/\b(delete|remove)\b/g, 'delete'],
    [/\b(close|dismiss)\b/g, 'close']
];

export function normalise(s: string): string {
    return s
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function canonical(s: string): string {
    return SYNONYMS.reduce((out, [re, word]) => out.replace(re, word), normalise(s)).replace(/\s+/g, ' ').trim();
}

function bigrams(s: string): string[] {
    const t = s.replace(/\s+/g, '');
    const out: string[] = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
}

function dice(a: string, b: string): number {
    const x = bigrams(a);
    const y = bigrams(b);
    if (!x.length || !y.length) return a === b ? 1 : 0;
    const pool = [...y];
    let hits = 0;
    for (const g of x) {
        const i = pool.indexOf(g);
        if (i >= 0) {
            hits++;
            pool.splice(i, 1);
        }
    }
    return (2 * hits) / (x.length + y.length);
}

function levenshteinRatio(a: string, b: string): number {
    if (!a.length && !b.length) return 1;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** How alike two visible names are, from 0 to 1, ignoring case, punctuation and common synonyms (sign in / log in). */
export function similarity(a: string, b: string): number {
    const na = normalise(a);
    const nb = normalise(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ca = canonical(a);
    const cb = canonical(b);
    if (ca === cb) return 0.9;
    const ta = new Set(ca.split(' '));
    const tb = new Set(cb.split(' '));
    const common = [...ta].filter(t => tb.has(t)).length;
    const jaccard = common / new Set([...ta, ...tb]).size;
    const contained = common === Math.min(ta.size, tb.size) ? 0.6 + (0.3 * Math.min(ta.size, tb.size)) / Math.max(ta.size, tb.size) : 0;
    return Math.min(0.89, Math.max(dice(ca, cb), levenshteinRatio(ca, cb), jaccard, contained));
}

// ---- the page at failure time -------------------------------------------------------

export interface PageElement {
    role: string;
    name: string;
    count: number;
}

/** Reads the "Page snapshot" YAML block of Playwright's error-context file. */
export function snapshotFromErrorContext(markdown: string): string | undefined {
    const m = markdown.match(/#\s*Page snapshot\s*```(?:yaml)?\s*\n([\s\S]*?)```/i);
    return m ? m[1] : undefined;
}

/** Elements on the page: interactive ones from parseAriaSnapshot, plus plain text nodes for getByText. */
export function pageElements(snapshot: string): PageElement[] {
    const elements: PageElement[] = parseAriaSnapshot(snapshot).elements.map(e => ({ role: e.role, name: e.name, count: e.count }));
    const texts = new Map<string, number>();
    for (const line of snapshot.split('\n')) {
        const m = line.match(/^\s*-\s+(?:text|paragraph|cell|listitem|strong|emphasis|generic|label):\s+(.+?)\s*$/) ?? line.match(/^\s*-\s+(?:paragraph|cell|listitem|columnheader|img|label)\s+"((?:[^"\\]|\\.)*)"/);
        if (!m) continue;
        const name = m[1].replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
        if (name.trim() && !name.startsWith('/')) texts.set(name, (texts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of texts) if (!elements.some(e => e.name === name)) elements.push({ role: 'text', name, count });
    return elements;
}

export interface Candidate {
    locator: NewLocator;
    confidence: number;
    reason: string;
}

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'slider', 'switch', 'listbox']);

function matches(l: ParsedLocator, name: string): boolean {
    if (l.regex) {
        try {
            return new RegExp(l.value, 'i').test(name);
        } catch {
            return false;
        }
    }
    // Like Playwright: without exact, names match case-insensitively as a substring.
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
    return l.exact ? squash(name) === squash(l.value) : squash(name).toLowerCase().includes(squash(l.value).toLowerCase());
}

const round = (n: number) => Math.round(Math.min(0.97, n) * 100) / 100;

/**
 * Ranks elements of the page as replacements for a locator that matched nothing.
 * Returns { present: true } when the element is on the page after all, because then
 * the locator is not what broke (the element was hidden, disabled or late).
 */
export function rankCandidates(failed: ParsedLocator, elements: PageElement[], testIds: string[] = []): { present: boolean; candidates: Candidate[] } {
    const out: Candidate[] = [];
    const add = (c: Candidate) => {
        if (!out.some(o => renderLocator(o.locator) === renderLocator(c.locator))) out.push(c);
    };
    const old = failed.value;
    if (failed.kind === 'role') {
        if (elements.some(e => e.role === failed.role && matches(failed, e.name))) return { present: true, candidates: [] };
        const sameRole = elements.filter(e => e.role === failed.role);
        for (const e of elements) {
            const sim = similarity(old, e.name);
            if (e.role === failed.role) {
                const only = sameRole.length === 1;
                if (sim < 0.3 && !only) continue;
                add({
                    locator: { kind: 'role', role: e.role, value: e.name },
                    confidence: round(0.4 + 0.55 * sim + (only ? 0.05 : 0)),
                    reason: sim >= 0.3 ? `The ${roleWord(e.role)} is now called '${e.name}' instead of '${old}'.` : `There is no ${roleWord(e.role)} '${old}' any more; '${e.name}' is the only ${roleWord(e.role)} on the page.`
                });
            } else if (sim >= 0.85 && e.role !== 'heading' && e.role !== 'text') {
                add({ locator: { kind: 'role', role: e.role, value: e.name }, confidence: round(0.3 + 0.5 * sim), reason: `There is no ${roleWord(failed.role ?? '')} '${old}' any more, but there is a ${roleWord(e.role)} called '${e.name}'.` });
            }
        }
    } else if (failed.kind === 'label' || failed.kind === 'placeholder') {
        const fields = elements.filter(e => FIELD_ROLES.has(e.role));
        if (fields.some(e => matches(failed, e.name))) return { present: true, candidates: [] };
        for (const e of fields) {
            const sim = similarity(old, e.name);
            if (sim < 0.3 && fields.length > 1) continue;
            add({
                locator: { kind: failed.kind, value: e.name },
                confidence: round((0.4 + 0.55 * sim) * (failed.kind === 'placeholder' ? 0.9 : 1)),
                reason: failed.kind === 'label' ? `The field labelled '${old}' is now labelled '${e.name}'.` : `The field with placeholder '${old}' now shows '${e.name}'.`
            });
        }
    } else if (failed.kind === 'text' || failed.kind === 'alt' || failed.kind === 'title') {
        const pool = failed.kind === 'alt' ? elements.filter(e => e.role === 'img') : elements;
        if (pool.some(e => matches(failed, e.name))) return { present: true, candidates: [] };
        for (const e of pool) {
            const sim = similarity(old, e.name);
            if (sim < 0.45) continue;
            add({ locator: { kind: failed.kind, value: e.name }, confidence: round(0.35 + 0.55 * sim), reason: `The text '${old}' now reads '${e.name}'.` });
        }
    } else if (failed.kind === 'testid') {
        if (testIds.includes(old)) return { present: true, candidates: [] };
        for (const id of testIds) {
            const sim = similarity(old, id);
            if (sim < 0.5) continue;
            add({ locator: { kind: 'testid', value: id }, confidence: round(0.3 + 0.55 * sim), reason: `The test id '${old}' is not on the page; '${id}' looks like the same element.` });
        }
        for (const e of elements) {
            const sim = similarity(old.replace(/[-_]?(btn|button|link|input|field)$/i, ''), e.name);
            if (sim < 0.6 || e.role === 'text' || e.role === 'heading') continue;
            add({ locator: { kind: 'role', role: e.role, value: e.name }, confidence: round(0.25 + 0.45 * sim), reason: `The test id '${old}' is gone; the ${roleWord(e.role)} '${e.name}' looks like the same element, and a role locator does not depend on test ids.` });
        }
    } else {
        const hint = cssHint(old);
        if (hint) {
            for (const e of elements) {
                if (hint.role && e.role !== hint.role) continue;
                const sim = similarity(hint.name, e.name);
                if (sim < 0.45) continue;
                if (sim === 1 && hint.role === e.role) return { present: true, candidates: [] };
                add({
                    locator: { kind: 'role', role: e.role, value: e.name },
                    confidence: round((0.35 + 0.5 * sim) * 0.9),
                    reason: `The CSS locator looked for '${hint.name}'; the page now has the ${roleWord(e.role)} '${e.name}'. A role locator is also sturdier than CSS.`
                });
            }
        }
    }
    out.sort((a, b) => b.confidence - a.confidence);
    return { present: false, candidates: out.slice(0, 3) };
}

/** Guesses the visible text and role a CSS selector refers to, e.g. button:has-text("Sign in"). */
export function cssHint(css: string): { role?: string; name: string } | undefined {
    const text = css.match(/(?:has-text|text|aria-label|title|placeholder|value|alt)\s*[=(]\s*['"]?([^'")\]]+)['"]?/i)?.[1] ?? css.match(/^text=(.+)$/)?.[1];
    const tag = css.match(/^\s*([a-z]+)\b/i)?.[1]?.toLowerCase();
    const role = tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'input' || tag === 'textarea' ? 'textbox' : tag === 'select' ? 'combobox' : undefined;
    if (text) return { role, name: text.trim() };
    const id = css.match(/[#.]([\w-]+)/)?.[1];
    return id ? { role, name: id.replace(/[-_]+/g, ' ').replace(/\b(btn|button|link|input)\b/gi, '').trim() || id } : undefined;
}
