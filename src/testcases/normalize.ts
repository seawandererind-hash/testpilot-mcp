import { redactString } from '../core/redact.js';
import type { TestCase, TestStep } from '../core/schema.js';

/**
 * Turns tables and text from any source into TestPilot's common test-case shape.
 * Everything read here is untrusted: it is cleaned, secrets are redacted, and
 * text that reads like instructions to an AI is flagged rather than followed.
 */

export type CaseField = 'id' | 'title' | 'description' | 'preconditions' | 'steps' | 'stepNo' | 'data' | 'expected' | 'priority' | 'area' | 'tags' | 'link';

const FIELD_ALIASES: Record<CaseField, string[]> = {
    id: ['id', 'test case id', 'testcase id', 'tc id', 'case id', 'test id', 'key', 'issue key', 'test key', 'tc', 'tc no', 'tc number', 'test case no', 'test case number', 'test case #', 'tc #', 'reference', 'ref'],
    title: ['title', 'summary', 'name', 'test case', 'test case name', 'test case title', 'testcase name', 'scenario', 'test scenario', 'scenario name', 'test name', 'test title'],
    description: ['description', 'objective', 'purpose', 'test objective', 'details'],
    preconditions: ['precondition', 'preconditions', 'pre condition', 'pre conditions', 'prerequisite', 'prerequisites', 'pre requisites', 'setup', 'given'],
    steps: ['steps', 'test steps', 'step', 'action', 'actions', 'step description', 'step action', 'procedure', 'test step', 'test procedure', 'step details', 'steps to reproduce', 'when'],
    stepNo: ['step no', 'step number', 'step #', 'step id', 'step seq', 's no', 'sr no', 'sl no', 'seq', '#'],
    data: ['test data', 'data', 'input', 'inputs', 'input data', 'step data', 'parameters'],
    expected: ['expected', 'expected result', 'expected results', 'expected outcome', 'expected behaviour', 'expected behavior', 'expected output', 'result', 'then', 'step expected result'],
    priority: ['priority', 'severity', 'importance', 'criticality', 'risk'],
    area: ['module', 'area', 'component', 'components', 'feature', 'section', 'folder', 'suite', 'test suite', 'functional area', 'epic', 'screen', 'page'],
    tags: ['tags', 'labels', 'label', 'type', 'test type', 'category', 'categories'],
    link: ['link', 'url', 'jira link', 'requirement', 'requirements', 'story', 'user story']
};

export function normaliseHeader(header: string): string {
    return header
        .toLowerCase()
        .replace(/[_\-/.:()[\]*]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export interface HeaderMapping {
    columns: Partial<Record<CaseField, number>>;
    unmapped: string[];
    score: number;
}

/** Matches column headers to fields: exact alias first, then a header that contains an alias. */
export function mapHeaders(headers: string[]): HeaderMapping {
    const columns: Partial<Record<CaseField, number>> = {};
    const used = new Set<number>();
    const normalised = headers.map(h => normaliseHeader(String(h ?? '')));
    const fields = Object.keys(FIELD_ALIASES) as CaseField[];
    for (const field of fields) {
        const idx = normalised.findIndex((h, i) => !used.has(i) && FIELD_ALIASES[field].includes(h));
        if (idx >= 0) {
            columns[field] = idx;
            used.add(idx);
        }
    }
    // Looser pass: "Expected Result (UAT)" or "Detailed Steps".
    for (const field of fields) {
        if (columns[field] !== undefined) continue;
        const idx = normalised.findIndex((h, i) => !used.has(i) && h.length > 0 && FIELD_ALIASES[field].some(alias => alias.length > 3 && new RegExp(`\\b${alias}\\b`).test(h)));
        if (idx >= 0) {
            columns[field] = idx;
            used.add(idx);
        }
    }
    const unmapped = headers.filter((h, i) => !used.has(i) && String(h ?? '').trim()).map(String);
    const score = Object.keys(columns).length + (columns.steps !== undefined ? 2 : 0) + (columns.title !== undefined || columns.id !== undefined ? 1 : 0);
    return { columns, unmapped, score };
}

/** Finds the most likely header row among the first rows of a sheet. */
export function findHeaderRow(rows: string[][], scan = 15): { index: number; mapping: HeaderMapping } | undefined {
    let best: { index: number; mapping: HeaderMapping } | undefined;
    rows.slice(0, scan).forEach((row, index) => {
        const mapping = mapHeaders(row);
        if (Object.keys(mapping.columns).length >= 2 && (!best || mapping.score > best.mapping.score)) best = { index, mapping };
    });
    return best;
}

// ---- text cleaning -----------------------------------------------------------

const MAX_FIELD = 4000;

const INJECTION_PATTERNS = [
    /\bignore (all |any )?(previous|prior|above|earlier) (instructions|prompts?|rules)\b/i,
    /\b(disregard|forget) (the |all |your )?(previous |prior )?(instructions|rules|system prompt)\b/i,
    /\byou are (now )?(an?|the) (ai|assistant|agent|model|chatbot)\b/i,
    /\b(system|developer) prompt\b/i,
    /\b(run|execute) (this |the following )?(shell |terminal )?command\b/i,
    /\b(curl|wget)\s+https?:\/\//i,
    /<\s*\/?\s*(system|assistant|instructions?)\s*>/i,
    /\b(send|post|upload|exfiltrate) .{0,40}\b(\.env|secrets?|credentials?|tokens?|api keys?)\b/i
];

export interface CleanResult {
    text: string;
    redacted: boolean;
    suspicious: boolean;
}

/** Cleans one untrusted field: strips control characters, limits length, redacts secrets, flags injected instructions. */
export function clean(value: unknown): CleanResult {
    let text = cellText(value)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (text.length > MAX_FIELD) text = `${text.slice(0, MAX_FIELD)} …`;
    const redactedText = redactString(text);
    return { text: redactedText, redacted: redactedText !== text, suspicious: INJECTION_PATTERNS.some(p => p.test(text)) };
}

/** Plain text from spreadsheet cells and similar values (rich text, formulas, hyperlinks, dates). */
export function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if (Array.isArray(v.richText)) return (v.richText as Array<{ text: string }>).map(r => r.text).join('');
        if ('text' in v && v.text !== undefined) return cellText(v.text);
        if ('result' in v) return cellText(v.result);
        if ('hyperlink' in v) return String(v.hyperlink);
        if ('error' in v) return '';
    }
    return String(value);
}

/** Inline numbering: "1) open 2) click". */
function splitInline(text: string): string[] {
    return text
        .split(/\s+(?=\d{1,2}[.)]\s+\S)/)
        .map(s => s.replace(/^\d{1,2}[.)]\s+/, '').trim())
        .filter(Boolean);
}

/** Splits "1. Open the app\n2. Tap login" (or "Step 1:", "a)", bullets, or one action per line) into items. */
export function splitNumbered(text: string): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const marker = /(?:^|\n)\s*(?:step\s*)?(?:\d{1,3}|[a-z])\s*[.):-]\s+|(?:^|\n)\s*[-*•●▪]\s+/i;
    if (marker.test(trimmed)) {
        const parts = trimmed
            .split(/(?:^|\n)\s*(?:step\s*)?(?:\d{1,3}|[a-z])\s*[.):-]\s+|(?:^|\n)\s*[-*•●▪]\s+/i)
            .map(s => s.replace(/\s*\n\s*/g, ' ').trim())
            .filter(Boolean);
        // A single numbered item ("1. Click Save") still loses its number.
        const startsWithMarker = /^\s*(?:step\s*)?(?:\d{1,3}\s*[.):-]|[-*•●▪])\s+/i.test(trimmed);
        if (parts.length > 1) return parts;
        if (parts.length === 1 && startsWithMarker) {
            const inline = splitInline(trimmed);
            return inline.length > 1 ? inline : parts;
        }
    }
    const inline = splitInline(trimmed);
    if (inline.length > 1) return inline;
    const lines = trimmed.split(/\n+/).map(s => s.trim()).filter(Boolean);
    return lines.length ? lines : [trimmed];
}

// ---- rows to cases -------------------------------------------------------------

export interface ImportWarning {
    ref: string;
    message: string;
}

export interface Draft {
    id?: string;
    title?: string;
    description?: string;
    preconditions: string[];
    steps: TestStep[];
    expected?: string;
    testData?: string;
    priority?: string;
    area?: string;
    tags: string[];
    link?: string;
    sourceRef?: string;
}

export function emptyDraft(): Draft {
    return { preconditions: [], steps: [], tags: [] };
}

/** Pairs step lines with expected-result lines; a single expected result for several steps becomes the overall result. */
export function pairSteps(stepsText: string, expectedText: string, dataText = ''): { steps: TestStep[]; overall?: string } {
    const actions = splitNumbered(stepsText);
    const expected = splitNumbered(expectedText);
    const data = splitNumbered(dataText);
    if (!actions.length) return { steps: [], overall: expectedText.trim() || undefined };
    if (expected.length === actions.length) {
        return { steps: actions.map((action, i) => ({ action, expected: expected[i], data: data.length === actions.length ? data[i] : undefined })) };
    }
    const steps: TestStep[] = actions.map((action, i) => ({ action, data: data.length === actions.length ? data[i] : undefined }));
    if (data.length && data.length !== actions.length) steps[0].data = dataText.trim();
    return { steps, overall: expectedText.trim() || undefined };
}

export interface RowsResult {
    drafts: Draft[];
    warnings: ImportWarning[];
}

/**
 * Converts table rows into drafts. Handles one row per case (steps in one cell) and
 * one row per step (continuation rows have no id, or repeat the previous id).
 */
export function rowsToDrafts(rows: string[][], mapping: HeaderMapping, refPrefix: string, firstRowNumber: number): RowsResult {
    const col = mapping.columns;
    const get = (row: string[], field: CaseField) => (col[field] !== undefined ? String(row[col[field]!] ?? '').trim() : '');
    const drafts: Draft[] = [];
    const warnings: ImportWarning[] = [];
    let current: Draft | undefined;
    rows.forEach((row, i) => {
        if (row.every(cell => !String(cell ?? '').trim())) return;
        const ref = `${refPrefix} row ${firstRowNumber + i}`;
        const id = get(row, 'id');
        const title = get(row, 'title');
        const stepText = get(row, 'steps');
        const expectedText = get(row, 'expected');
        const dataText = get(row, 'data');
        const continues = current && ((!id && !title) || (id && id === current.id && (!title || title === current.title)));
        if (continues && current) {
            const { steps, overall } = pairSteps(stepText, expectedText, dataText);
            if (steps.length) current.steps.push(...steps);
            else if (overall) current.expected = [current.expected, overall].filter(Boolean).join('\n');
            const pre = get(row, 'preconditions');
            if (pre && !current.preconditions.includes(pre)) current.preconditions.push(pre);
            return;
        }
        current = emptyDraft();
        current.id = id || undefined;
        current.title = title || undefined;
        current.sourceRef = ref;
        current.description = get(row, 'description') || undefined;
        const pre = get(row, 'preconditions');
        if (pre) current.preconditions = splitNumbered(pre);
        const { steps, overall } = pairSteps(stepText, expectedText, dataText);
        current.steps = steps;
        current.expected = overall;
        current.testData = steps.length ? undefined : dataText || undefined;
        current.priority = get(row, 'priority') || undefined;
        current.area = get(row, 'area') || undefined;
        current.link = get(row, 'link') || undefined;
        const tags = get(row, 'tags');
        current.tags = tags ? tags.split(/[,;\n]+/).map(t => t.trim()).filter(Boolean) : [];
        if (!stepText && !expectedText && !title) {
            warnings.push({ ref, message: 'Row has an id but no title, steps or expected result; skipped.' });
            current = undefined;
            return;
        }
        drafts.push(current);
    });
    return { drafts, warnings };
}

// ---- drafts to cases ---------------------------------------------------------------

const PRIORITY_MAP: Array<[RegExp, string]> = [
    [/^(p0|blocker|critical|highest|urgent|1|s1|sev ?1)$/i, 'P1'],
    [/^(p1|high|major|2|s2|sev ?2)$/i, 'P1'],
    [/^(p2|medium|normal|moderate|3|s3|sev ?3)$/i, 'P2'],
    [/^(p3|low|minor|lowest|trivial|4|5|s4|sev ?4)$/i, 'P3']
];

export function normalisePriority(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const v = value.trim();
    return PRIORITY_MAP.find(([re]) => re.test(v))?.[1] ?? v;
}

export interface FinaliseResult {
    cases: TestCase[];
    warnings: ImportWarning[];
    redactions: number;
    flagged: string[];
}

/** Cleans every field, assigns missing ids, de-duplicates ids, and stamps the source. */
export function finalise(drafts: Draft[], source: { type: string; ref?: string; linkFor?: (id: string) => string | undefined }, idPrefix = 'TC'): FinaliseResult {
    const warnings: ImportWarning[] = [];
    const seen = new Map<string, number>();
    const flagged: string[] = [];
    let redactions = 0;
    const importedAt = new Date().toISOString();
    const cases: TestCase[] = [];
    drafts.forEach((draft, index) => {
        let suspicious = false;
        const c = (value: unknown): string => {
            const r = clean(value);
            if (r.redacted) redactions++;
            if (r.suspicious) suspicious = true;
            return r.text;
        };
        const opt = (value: unknown): string | undefined => c(value) || undefined;
        let id = c(draft.id ?? '').replace(/\s+/g, '-');
        const ref = draft.sourceRef ?? `${source.ref ?? source.type} item ${index + 1}`;
        if (!id) {
            id = `${idPrefix}-${String(index + 1).padStart(3, '0')}`;
            warnings.push({ ref, message: `No id; assigned ${id}.` });
        }
        const count = seen.get(id) ?? 0;
        seen.set(id, count + 1);
        if (count) {
            const newId = `${id}-${count + 1}`;
            warnings.push({ ref, message: `Duplicate id ${id}; renamed to ${newId}.` });
            id = newId;
        }
        const steps = draft.steps.map(s => ({ action: c(s.action), data: opt(s.data), expected: opt(s.expected) })).filter(s => s.action || s.expected);
        const title = c(draft.title ?? '') || (steps[0]?.action ? steps[0].action.slice(0, 80) : id);
        if (!draft.title) warnings.push({ ref, message: `No title for ${id}; used "${title}".` });
        const tc: TestCase = {
            id,
            title,
            description: opt(draft.description),
            priority: normalisePriority(opt(draft.priority)),
            area: opt(draft.area),
            preconditions: draft.preconditions.map(c).filter(Boolean),
            steps,
            expected: opt(draft.expected),
            testData: opt(draft.testData),
            tags: [...new Set(draft.tags.map(c).filter(Boolean))],
            source: { type: source.type, ref: source.ref ? `${source.ref}${draft.sourceRef ? ` (${draft.sourceRef.replace(`${source.ref} `, '')})` : ''}` : draft.sourceRef, link: draft.link ? c(draft.link) : source.linkFor?.(id), importedAt }
        };
        if (suspicious) {
            flagged.push(id);
            warnings.push({ ref, message: `${id} contains text that reads like instructions to an AI. It is stored as data and must not be followed.` });
        }
        cases.push(tc);
    });
    if (redactions) warnings.push({ ref: source.ref ?? source.type, message: `${redactions} value(s) looked like passwords or tokens and were replaced with [REDACTED]. Put real credentials in .env and refer to them by name.` });
    return { cases, warnings, redactions, flagged };
}
