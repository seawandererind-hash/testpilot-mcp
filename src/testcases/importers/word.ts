import path from 'node:path';

import mammoth from 'mammoth';

import { parseLabelledText, tablesToDrafts } from './text.js';
import { ImportError, type Importer } from './types.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decode(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
        if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Extracts top-level tables from mammoth's HTML as rows of plain-text cells. Nested tables are flattened into their cell. */
export function htmlTables(html: string): string[][][] {
    const tables: string[][][] = [];
    const token = /<(\/?)(table|tr|td|th|p|br|li|ol|ul)\b[^>]*>|([^<]+)|<[^>]+>/gi;
    let depth = 0;
    let rows: string[][] = [];
    let row: string[] | undefined;
    let cell: string | undefined;
    let listIndex: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = token.exec(html))) {
        const [, closing, tagRaw, text] = m;
        const tag = tagRaw?.toLowerCase();
        if (text !== undefined) {
            if (cell !== undefined) cell += decode(text);
            continue;
        }
        if (!tag) continue;
        if (tag === 'table') {
            if (!closing) {
                depth++;
                if (depth === 1) rows = [];
                else if (cell !== undefined) cell += '\n';
            } else {
                if (depth === 1) tables.push(rows);
                depth--;
            }
            continue;
        }
        if (depth !== 1 && cell === undefined) continue;
        if (depth > 1) {
            // Nested table content goes into the outer cell, one line per row.
            if (tag === 'tr' && closing) cell += '\n';
            else if ((tag === 'td' || tag === 'th') && closing) cell += ' | ';
            else if ((tag === 'p' || tag === 'br') && cell) cell += ' ';
            continue;
        }
        if (tag === 'tr') {
            if (!closing) row = [];
            else if (row) {
                rows.push(row);
                row = undefined;
            }
        } else if (tag === 'td' || tag === 'th') {
            if (!closing) cell = '';
            else if (row && cell !== undefined) {
                row.push(cell.replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').trim());
                cell = undefined;
            }
        } else if (cell !== undefined) {
            if (tag === 'ol' || tag === 'ul') {
                if (!closing) listIndex.push(0);
                else listIndex.pop();
            } else if (tag === 'li' && !closing) {
                const level = listIndex.length - 1;
                if (level >= 0) listIndex[level]++;
                cell += `\n${level >= 0 ? `${listIndex[level]}. ` : '- '}`;
            } else if ((tag === 'p' && closing) || tag === 'br') cell += '\n';
        }
    }
    listIndex = [];
    return tables;
}

/** Word (.docx): tables with test-case columns, label/value tables (one per case), or headings with Steps / Expected text. */
export const importWord: Importer = async ({ store, location }) => {
    if (!/\.docx$/i.test(location)) throw new ImportError(/\.doc$/i.test(location) ? 'Old .doc files are not supported. Open it in Word and save as .docx.' : 'Give the path of a .docx file inside the repository.');
    if (!store.exists(location)) throw new ImportError(`No file at ${location}. Copy the document into the repository (for example test-cases/) and try again.`);
    const buffer = store.readBuffer(location);
    const ref = path.basename(location);
    let html: string;
    try {
        html = (await mammoth.convertToHtml({ buffer })).value;
    } catch (error) {
        throw new ImportError(`Could not read ${location} as a Word document (${(error as Error).message}).`);
    }
    const tables = tablesToDrafts(htmlTables(html), ref);
    if (tables.drafts.length) return { drafts: tables.drafts, warnings: tables.warnings, ref, raw: { name: ref, content: buffer } };
    // No usable tables: read headings and paragraphs as labelled text.
    const markdownish = html
        .replace(/<h(\d)[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Math.min(Number(n) + 1, 4))} `)
        .replace(/<\/h\d>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<\/(p|li|ol|ul)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    const parsed = parseLabelledText(decode(markdownish), ref);
    return { ...parsed, ref, raw: { name: ref, content: buffer } };
};
