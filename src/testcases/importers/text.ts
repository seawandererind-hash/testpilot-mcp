import { type CaseField, type Draft, emptyDraft, findHeaderRow, mapHeaders, normaliseHeader, rowsToDrafts, splitNumbered, type ImportWarning } from '../normalize.js';

/**
 * Parsers for test cases written as text: Markdown files, Word documents without
 * tables, and pipe tables. Shared by the Markdown and Word importers.
 */

const LABELS: Array<[RegExp, CaseField | 'ignore']> = [
    [/^(test ?case ?id|tc ?id|case ?id|id|key|test ?id)$/, 'id'],
    [/^(title|summary|name|test ?case ?name|test ?case ?title|scenario|test ?scenario)$/, 'title'],
    [/^(description|objective|purpose)$/, 'description'],
    [/^(pre ?conditions?|prerequisites?|pre ?requisites?|setup|given)$/, 'preconditions'],
    [/^(steps?|test ?steps?|actions?|procedure|steps ?to ?reproduce)$/, 'steps'],
    [/^(expected|expected ?results?|expected ?outcome|expected ?behaviou?r|then)$/, 'expected'],
    [/^(test ?data|data|inputs?)$/, 'data'],
    [/^(priority|severity|importance)$/, 'priority'],
    [/^(module|area|component|feature|section|suite)$/, 'area'],
    [/^(tags?|labels?|type|category)$/, 'tags'],
    [/^(link|url|requirement|story|user ?story)$/, 'link']
];

function labelOf(raw: string): CaseField | 'ignore' | undefined {
    const norm = normaliseHeader(raw);
    return LABELS.find(([re]) => re.test(norm))?.[1];
}

const ID_TITLE = /^([A-Z][A-Z0-9_]*-\d+|TC[-_ ]?\d+)\s*[:\-–—|.]\s*(.+)$/i;
const HEADING = /^#{1,4}\s+(.+?)\s*#*$/;
const LABEL_LINE = /^\s*(?:\*\*|__)?([A-Za-z][A-Za-z ()/_-]{1,30}?)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/;

/** Parses "## TC-1: Title" / "Steps:" / "1. …" / "Expected: …" style text into drafts. */
export function parseLabelledText(text: string, ref: string): { drafts: Draft[]; warnings: ImportWarning[] } {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const drafts: Draft[] = [];
    const warnings: ImportWarning[] = [];
    let current: Draft | undefined;
    let section: CaseField | undefined;
    let buffer: string[] = [];

    const flushSection = () => {
        if (!current || !section) {
            buffer = [];
            return;
        }
        const body = buffer.join('\n').trim();
        buffer = [];
        if (!body) return;
        apply(current, section, body);
    };
    const start = (id: string | undefined, title: string | undefined, lineNo: number) => {
        flushSection();
        current = emptyDraft();
        current.id = id;
        current.title = title;
        current.sourceRef = `${ref} line ${lineNo}`;
        drafts.push(current);
        section = undefined;
    };

    lines.forEach((rawLine, i) => {
        const line = rawLine.trimEnd();
        const heading = line.match(HEADING);
        if (heading) {
            const inner = heading[1].replace(/\*\*/g, '').trim();
            const label = labelOf(inner);
            if (label && label !== 'ignore' && current) {
                flushSection();
                section = label;
                return;
            }
            const idTitle = inner.match(ID_TITLE);
            start(idTitle?.[1], idTitle ? idTitle[2] : inner, i + 1);
            return;
        }
        const idTitle = line.trim().match(ID_TITLE);
        if (idTitle && !/^\s*\d+[.)]/.test(line)) {
            start(idTitle[1], idTitle[2], i + 1);
            return;
        }
        const labelled = line.match(LABEL_LINE);
        const label = labelled ? labelOf(labelled[1]) : undefined;
        if (labelled && label && label !== 'ignore') {
            if (label === 'id') {
                if (!current || current.id) start(labelled[2].trim(), undefined, i + 1);
                else current.id = labelled[2].trim();
                return;
            }
            if (label === 'title' && current && !current.title) {
                current.title = labelled[2].trim();
                return;
            }
            if (!current) start(undefined, undefined, i + 1);
            flushSection();
            section = label;
            if (labelled[2].trim()) buffer.push(labelled[2].trim());
            return;
        }
        if (current && section === 'steps' && /^\s*(?:expected|→|=>)\s*[:\-]?\s*/i.test(line) && current.steps.length + buffer.length > 0) {
            // "Expected: …" right under a step belongs to that step.
            flushSection();
            const last = current.steps[current.steps.length - 1];
            const value = line.replace(/^\s*(?:expected(?: result)?|→|=>)\s*[:\-]?\s*/i, '').trim();
            if (last) last.expected = [last.expected, value].filter(Boolean).join(' ');
            section = 'steps';
            return;
        }
        if (current && !section && /^\s*(\d+[.)]|[-*•])\s+/.test(line)) section = 'steps';
        if (current && section) buffer.push(line);
        else if (current && line.trim() && !current.description) current.description = line.trim();
    });
    flushSection();
    // Headings with nothing under them (document titles, chapter names) are not test cases.
    const kept = drafts.filter(d => d.steps.length || d.expected);
    if (!kept.length) warnings.push({ ref, message: 'No test cases found. Use one heading per case ("## TC-1: Title"), then "Steps:" with a numbered list and "Expected:" lines.' });
    return { drafts: kept, warnings };
}

function apply(draft: Draft, field: CaseField, body: string): void {
    switch (field) {
        case 'steps': {
            const items = splitNumbered(body);
            draft.steps.push(...items.map(action => ({ action })));
            return;
        }
        case 'expected': {
            const items = splitNumbered(body);
            if (draft.steps.length && items.length === draft.steps.length && items.length > 1) items.forEach((e, i) => (draft.steps[i].expected = e));
            else draft.expected = [draft.expected, body].filter(Boolean).join('\n');
            return;
        }
        case 'preconditions':
            draft.preconditions.push(...splitNumbered(body));
            return;
        case 'tags':
            draft.tags.push(...body.split(/[,;\s]+/).map(t => t.replace(/^@/, '').trim()).filter(Boolean));
            return;
        case 'data':
            draft.testData = [draft.testData, body].filter(Boolean).join('\n');
            return;
        case 'description':
        case 'priority':
        case 'area':
        case 'link':
        case 'title':
        case 'id':
            (draft as unknown as Record<string, string>)[field] = body.split('\n')[0].trim();
            return;
        default:
            return;
    }
}

/** Finds Markdown pipe tables and returns their rows (header first). */
export function pipeTables(text: string): string[][][] {
    const tables: string[][][] = [];
    let current: string[][] = [];
    const flush = () => {
        if (current.length >= 2) tables.push(current);
        current = [];
    };
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const t = line.trim();
        if (t.startsWith('|') && t.endsWith('|') && t.length > 2) {
            const cells = t
                .slice(1, -1)
                .split(/(?<!\\)\|/)
                .map(c => c.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n').trim());
            if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue;
            current.push(cells);
        } else flush();
    }
    flush();
    return tables;
}

/** Converts tables (rows of cells) into drafts: horizontal tables with a header row, or vertical label/value tables. */
export function tablesToDrafts(tables: string[][][], ref: string): { drafts: Draft[]; warnings: ImportWarning[]; used: number } {
    const drafts: Draft[] = [];
    const warnings: ImportWarning[] = [];
    let used = 0;
    tables.forEach((rows, t) => {
        const tableRef = `${ref} table ${t + 1}`;
        const vertical = verticalTable(rows, tableRef);
        if (vertical) {
            drafts.push(vertical);
            used++;
            return;
        }
        const header = findHeaderRow(rows, 3);
        if (header && (header.mapping.columns.steps !== undefined || header.mapping.columns.expected !== undefined || header.mapping.columns.title !== undefined)) {
            const out = rowsToDrafts(rows.slice(header.index + 1), header.mapping, tableRef, header.index + 2);
            drafts.push(...out.drafts);
            warnings.push(...out.warnings);
            used++;
        }
    });
    return { drafts, warnings, used };
}

/** A table whose first column holds labels (ID, Title, Steps, …), optionally followed by a step table inside it. */
function verticalTable(rows: string[][], ref: string): Draft | undefined {
    const labelled = rows.filter(r => r.length >= 2 && labelOf(r[0] ?? '') && labelOf(r[0] ?? '') !== 'ignore');
    if (labelled.length < 2 || labelled.length < rows.length * 0.3) return undefined;
    const draft = emptyDraft();
    draft.sourceRef = ref;
    let stepHeader: ReturnType<typeof mapHeaders> | undefined;
    const stepRows: string[][] = [];
    for (const row of rows) {
        if (stepHeader) {
            stepRows.push(row);
            continue;
        }
        const asHeader = mapHeaders(row);
        if (row.length >= 3 && asHeader.columns.steps !== undefined && asHeader.columns.expected !== undefined) {
            stepHeader = asHeader;
            continue;
        }
        const label = labelOf(row[0] ?? '');
        const value = row.slice(1).filter(Boolean).join('\n').trim();
        if (!label || label === 'ignore' || !value) continue;
        if (label === 'id') draft.id = value.split('\n')[0];
        else apply(draft, label, value);
    }
    if (stepHeader) {
        const out = rowsToDrafts(stepRows, { ...stepHeader, columns: { ...stepHeader.columns, id: undefined, title: undefined } }, ref, 1);
        // Without id/title columns every step row continues one case.
        for (const d of out.drafts) draft.steps.push(...d.steps);
    }
    return draft.title || draft.id || draft.steps.length ? draft : undefined;
}
