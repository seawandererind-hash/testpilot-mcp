import { redact, redactString, REDACTED } from '../../../core/redact.js';
import type { TestStep } from '../../../core/schema.js';
import { type Fetch, type HttpResult, IntegrationError, requestWithHeaders } from '../../../integrations/http.js';
import { clean, findHeaderRow, type ImportWarning, rowsToDrafts } from '../../normalize.js';
import { labelOf, parseLabelledText, pipeTables } from '../text.js';
import { ImportError, type ImportRequest } from '../types.js';
import { decode, htmlTables } from '../word.js';

/**
 * Shared plumbing for importers that read test cases from a remote tool.
 * Credentials come only from request.env (the project's .env); they are sent in
 * headers and scrubbed from every error, warning and raw copy. Everything read
 * from the remote tool is untrusted text that goes through finalise() like any file.
 */

/** An import failure from a remote tool, with the HTTP status when there was one. */
export class RemoteImportError extends ImportError {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = 'RemoteImportError';
    }
}

/** Returns the env after checking the keys are filled in, without ever echoing a value. */
export function needEnv(request: ImportRequest, service: string, keys: string[]): Record<string, string> {
    const missing = keys.filter(k => !request.env[k]?.trim());
    if (missing.length) throw new RemoteImportError(`Importing from ${service} needs ${missing.join(', ')} in .env. Fill them in (see .env.example for where to get each), then try again.`);
    return request.env;
}

export interface RemoteOptions {
    service: string;
    /** Auth and accept headers sent with every call. */
    headers: Record<string, string>;
    /** .env keys whose values must never appear in output (tokens, keys, passwords). */
    secretKeys: string[];
    /** .env keys to name when the service rejects the credentials. */
    credentialKeys: string[];
    /** Extra advice for a 401, e.g. that tokens expire. */
    authHint?: string;
}

/** A remote service the importer talks to: sends authenticated requests and turns failures into friendly, secret-free errors. */
export class Remote {
    readonly doFetch: Fetch;
    private readonly secrets = new Set<string>();

    constructor(
        request: ImportRequest,
        private readonly options: RemoteOptions
    ) {
        this.doFetch = request.fetch ?? fetch;
        for (const key of options.secretKeys) this.addSecret(request.env[key]);
        for (const value of Object.values(options.headers)) {
            const credential = value.match(/^(?:Basic|Bearer)\s+(.+)$/i)?.[1];
            this.addSecret(credential);
        }
    }

    get service(): string {
        return this.options.service;
    }

    /** Remembers a value obtained at run time (such as a session token) so it is scrubbed too. */
    addSecret(value: string | undefined): void {
        if (value && value.length >= 4) this.secrets.add(value);
    }

    setHeader(name: string, value: string): void {
        this.options.headers[name] = value;
    }

    /** Removes credential values (and anything that looks like a secret) from text. */
    scrub(text: string): string {
        let out = text;
        for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
        return redactString(out);
    }

    error(message: string, status?: number): RemoteImportError {
        const hint =
            status === 401
                ? ` Check ${this.options.credentialKeys.join(' and ')} in .env.${this.options.authHint ? ` ${this.options.authHint}` : ''}`
                : status === 403
                  ? ` The account in .env (${this.options.credentialKeys[0]}) needs read access to these test cases.`
                  : '';
        // The details quote the service's response, which is untrusted too.
        const safe = clean(message).suspicious ? message.replace(/ Details: [\s\S]*$/, ' (Details left out: the response contained text that reads like instructions.)') : message;
        return new RemoteImportError(this.scrub(`${safe}${hint}`), status);
    }

    async call<T>(url: string, init: RequestInit = {}): Promise<HttpResult<T>> {
        try {
            return await requestWithHeaders<T>(this.service, this.doFetch, url, { ...init, headers: { ...this.options.headers, ...((init.headers as Record<string, string>) ?? {}) } });
        } catch (error) {
            if (error instanceof IntegrationError) throw this.error(error.message, error.status);
            throw error;
        }
    }

    async json<T>(url: string, init: RequestInit = {}): Promise<T> {
        return (await this.call<T>(url, init)).data;
    }

    /** Raw copy for .testpilot/test-cases/raw: auth-like fields dropped, secret-looking values redacted. */
    raw(name: string, payload: unknown): { name: string; content: string } {
        return { name, content: this.scrub(JSON.stringify(redact(stripAuth(payload)), null, 2)) };
    }
}

const AUTH_FIELD = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|access[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|client[-_]?secret|client[-_]?id|private[-_]?key)$/i;

/** Deep copy without fields that hold credentials. */
export function stripAuth(value: unknown, depth = 0): unknown {
    if (depth > 40 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => stripAuth(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (!AUTH_FIELD.test(key)) out[key] = stripAuth(item, depth + 1);
    return out;
}

/** Runs fn over items with at most `limit` calls in flight, keeping the order of results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export function moreAtSource(ref: string, limit: number): ImportWarning {
    return { ref, message: `Stopped after ${limit} case(s) because of limit; ${ref} has more. Raise limit to import them.` };
}

// ---- rich text to plain text -------------------------------------------------------

export interface PlainText {
    text: string;
    tables: string[][][];
}

/** A heading becomes "Steps:" when it names a test-case section, so the labelled-text parser picks it up; otherwise a plain line. */
export function headingLine(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    const label = labelOf(t.replace(/[:：]\s*$/, ''));
    return label && label !== 'ignore' && !/[:：]$/.test(t) ? `${t}:` : t;
}

/** HTML (Zephyr, BrowserStack, Azure DevOps fields) to text: numbered lists stay numbered, tables are returned separately. */
export function htmlToText(html: string | null | undefined): PlainText {
    const source = String(html ?? '');
    if (!source.trim()) return { text: '', tables: [] };
    const tables = /<table\b/i.test(source) ? htmlTables(source) : [];
    const body = source
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<table\b[\s\S]*?<\/table\s*>/gi, '\n');
    const out: string[] = [];
    const lists: Array<{ ordered: boolean; n: number }> = [];
    let headingStart = -1;
    const token = /<(\/?)([a-z][a-z0-9]*)\b[^>]*?>|([^<]+)|(<)/gi;
    let m: RegExpExecArray | null;
    while ((m = token.exec(body))) {
        const [, closing, tagRaw, text, lt] = m;
        if (text !== undefined) {
            out.push(decode(text).replace(/[ \t\r\n]+/g, ' '));
            continue;
        }
        if (lt) {
            out.push('<');
            continue;
        }
        const tag = tagRaw.toLowerCase();
        if (tag === 'br') out.push('\n');
        else if (tag === 'ol' || tag === 'ul') {
            if (!closing) lists.push({ ordered: tag === 'ol', n: 0 });
            else lists.pop();
            out.push('\n');
        } else if (tag === 'li' && !closing) {
            const list = lists[lists.length - 1];
            const indent = '  '.repeat(Math.max(0, lists.length - 1));
            out.push(`\n${indent}${list?.ordered ? `${++list.n}. ` : '- '}`);
        } else if (/^h[1-6]$/.test(tag)) {
            if (!closing) {
                out.push('\n');
                headingStart = out.length;
            } else if (headingStart >= 0) {
                const heading = out.splice(headingStart).join('');
                out.push(headingLine(heading), '\n');
                headingStart = -1;
            }
        } else if (['p', 'div', 'tr', 'pre', 'blockquote', 'li', 'section', 'article', 'header', 'footer', 'dd', 'dt'].includes(tag)) {
            // A paragraph that opens a list item stays on the item's line.
            const startsItem = !closing && /(?:^|\n)\s*(?:\d+\. |- )$/.test(out.slice(-3).join(''));
            if (!startsItem) out.push('\n');
        }
    }
    const text = out
        .join('')
        .replace(/ /g, ' ')
        .split('\n')
        .map(l => l.replace(/[ \t]+/g, ' ').replace(/^ (?=\S)/, '').trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text, tables };
}

/** Jira wiki markup (Jira Server, the Xray `jira` field) to text: h3. headings, # numbered lists, ||header|| tables. */
export function wikiToText(markup: string | null | undefined): PlainText {
    const out: string[] = [];
    let n = 0;
    for (const raw of String(markup ?? '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.replace(/\{(noformat|code|quote|panel)(:[^}]*)?\}/g, '');
        const heading = line.match(/^\s*h[1-6]\.\s+(.*)$/);
        if (heading) {
            out.push(headingLine(heading[1]));
            n = 0;
            continue;
        }
        const numbered = line.match(/^\s*#+\s+(.*)$/);
        if (numbered) {
            out.push(`${++n}. ${numbered[1]}`);
            continue;
        }
        n = 0;
        out.push(/^\s*\|\|/.test(line) ? line.replace(/\|\|/g, '|') : line);
    }
    return splitTables(out.join('\n'));
}

/** Markdown-ish text (TestRail, Xray steps): pipe tables are returned separately. */
export function splitTables(text: string): PlainText {
    const tables = pipeTables(text);
    const rest = tables.length ? text.split('\n').filter(l => !/^\s*\|.*\|\s*$/.test(l)).join('\n') : text;
    return { text: rest.trim(), tables };
}

// ---- text to steps -----------------------------------------------------------------

export interface Structured {
    description?: string;
    preconditions: string[];
    steps: TestStep[];
    expected?: string;
    testData?: string;
}

const LIST_ITEM = /^\s*(\d{1,3}[.)]|[-*•])\s+/;
const LABEL_START = /^\s*(?:\*\*|__)?([A-Za-z][A-Za-z ()/_-]{1,30}?)(?:\*\*|__)?\s*[:：]/;

/** The prose before the first steps / expected / preconditions section or list. */
function proseBefore(text: string): string | undefined {
    const out: string[] = [];
    for (const line of text.split('\n')) {
        const label = line.match(LABEL_START)?.[1];
        const field = label ? labelOf(label) : undefined;
        if (LIST_ITEM.test(line) || (field && !['ignore', 'description', 'title', 'id', 'link'].includes(field))) break;
        out.push(line);
    }
    return out.join('\n').trim() || undefined;
}

function tableText(rows: string[][]): string {
    return rows.map(r => `| ${r.map(c => c.replace(/\n/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`).join('\n');
}

/** Text with its tables written back as pipe rows, for a description that is kept as it is. */
export function asText(value: PlainText): string | undefined {
    return [value.text, ...value.tables.map(tableText)].filter(Boolean).join('\n\n') || undefined;
}

/**
 * Finds steps in a description: a table with a Steps/Action column first, then labelled
 * sections ("Steps:", "Expected result:") or a numbered list. Text that is not a step stays the description.
 */
export function structureText(text: string, tables: string[][][], ref: string): Structured {
    const tableSteps: TestStep[] = [];
    let tableExpected: string | undefined;
    const otherTables: string[][][] = [];
    for (const rows of tables) {
        const header = tableSteps.length ? undefined : findHeaderRow(rows, 3);
        if (header && header.mapping.columns.steps !== undefined) {
            const out = rowsToDrafts(rows.slice(header.index + 1), { ...header.mapping, columns: { ...header.mapping.columns, id: undefined, title: undefined } }, ref, header.index + 2);
            for (const d of out.drafts) {
                tableSteps.push(...d.steps);
                if (d.expected) tableExpected = [tableExpected, d.expected].filter(Boolean).join('\n');
            }
            if (tableSteps.length) continue;
        }
        otherTables.push(rows);
    }

    const parsed = text.trim() ? parseLabelledText(`## Imported case\n${text}`, ref).drafts : [];
    const steps: TestStep[] = [];
    const preconditions: string[] = [];
    const expected: string[] = [];
    const data: string[] = [];
    for (const d of parsed) {
        steps.push(...d.steps);
        preconditions.push(...d.preconditions);
        if (d.expected) expected.push(d.expected);
        if (d.testData) data.push(d.testData);
    }
    const found = tableSteps.length || parsed.length;
    const extraTables = otherTables.map(tableText).join('\n\n');
    const prose = found ? proseBefore(text) : text.trim() || undefined;
    return {
        description: [prose, extraTables].filter(Boolean).join('\n\n') || undefined,
        preconditions,
        steps: tableSteps.length ? tableSteps : steps,
        expected: [tableExpected, ...expected].filter(Boolean).join('\n') || undefined,
        testData: data.join('\n') || undefined
    };
}
