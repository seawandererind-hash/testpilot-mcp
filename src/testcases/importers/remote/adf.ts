import { headingLine, type PlainText, wikiToText } from './common.js';

/**
 * Atlassian Document Format (Jira Cloud REST v3 rich text) to plain text.
 * Lists stay numbered or bulleted so the step parser can split them; tables come
 * back separately as rows of cells. Unknown nodes fall back to their text content.
 */

interface AdfNode {
    type?: string;
    text?: string;
    attrs?: Record<string, unknown>;
    content?: AdfNode[];
}

const MAX_DEPTH = 40;

function inline(nodes: AdfNode[] | undefined, depth: number): string {
    if (!nodes || depth > MAX_DEPTH) return '';
    return nodes
        .map(node => {
            const attrs = node.attrs ?? {};
            switch (node.type) {
                case 'text':
                    return node.text ?? '';
                case 'hardBreak':
                    return '\n';
                case 'mention':
                    return String(attrs.text ?? '@someone');
                case 'emoji':
                    return String(attrs.text ?? attrs.shortName ?? '');
                case 'inlineCard':
                case 'blockCard':
                    return String(attrs.url ?? '');
                case 'status':
                    return String(attrs.text ?? '');
                case 'date': {
                    const ts = Number(attrs.timestamp);
                    return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
                }
                case 'media':
                case 'mediaInline':
                case 'placeholder':
                    return '';
                default:
                    return inline(node.content, depth + 1);
            }
        })
        .join('');
}

function blocks(nodes: AdfNode[] | undefined, out: string[], tables: string[][][], depth: number, indent = ''): void {
    if (!nodes || depth > MAX_DEPTH) return;
    for (const node of nodes) {
        switch (node.type) {
            case 'paragraph':
                out.push(indent + inline(node.content, depth + 1));
                break;
            case 'heading':
                out.push(headingLine(inline(node.content, depth + 1)));
                break;
            case 'orderedList':
            case 'bulletList':
            case 'taskList':
            case 'decisionList': {
                const start = Number(node.attrs?.order ?? 1);
                (node.content ?? []).forEach((item, i) => {
                    const marker = node.type === 'orderedList' ? `${(Number.isFinite(start) ? start : 1) + i}. ` : '- ';
                    const lines: string[] = [];
                    // taskItem / decisionItem hold inline content directly; listItem holds paragraphs and nested lists.
                    if (item.type === 'taskItem' || item.type === 'decisionItem') lines.push(inline(item.content, depth + 2));
                    else blocks(item.content, lines, tables, depth + 2, `${indent}  `);
                    const [first = '', ...rest] = lines;
                    out.push(`${indent}${marker}${first.trim()}`, ...rest);
                });
                break;
            }
            case 'table': {
                const rows = (node.content ?? []).map(row =>
                    (row.content ?? []).map(cell => {
                        const lines: string[] = [];
                        blocks(cell.content, lines, tables, depth + 2);
                        return lines.join('\n').trim();
                    })
                );
                if (rows.length) tables.push(rows);
                break;
            }
            case 'codeBlock':
                out.push(inline(node.content, depth + 1));
                break;
            case 'expand':
            case 'nestedExpand':
                if (node.attrs?.title) out.push(headingLine(String(node.attrs.title)));
                blocks(node.content, out, tables, depth + 1, indent);
                break;
            case 'rule':
            case 'mediaSingle':
            case 'mediaGroup':
                break;
            case 'text':
            case 'hardBreak':
            case 'mention':
            case 'emoji':
            case 'inlineCard':
            case 'status':
            case 'date':
                out.push(indent + inline([node], depth + 1));
                break;
            default:
                // blockquote, panel, layoutSection, layoutColumn, bodiedExtension, …
                blocks(node.content, out, tables, depth + 1, indent);
        }
    }
}

/** ADF document (or a plain/wiki string from older APIs) to text plus tables. */
export function adfToText(value: unknown): PlainText {
    if (value === null || value === undefined) return { text: '', tables: [] };
    if (typeof value === 'string') return wikiToText(value);
    const doc = value as AdfNode;
    if (typeof doc !== 'object' || !Array.isArray(doc.content)) return { text: '', tables: [] };
    const out: string[] = [];
    const tables: string[][][] = [];
    blocks(doc.content, out, tables, 0);
    const text = out
        .join('\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text, tables };
}
