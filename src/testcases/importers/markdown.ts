import path from 'node:path';

import { parseLabelledText, pipeTables, tablesToDrafts } from './text.js';
import { ImportError, type Importer } from './types.js';

/** Markdown: pipe tables with test-case columns, or one heading per case with Steps / Expected sections. */
export const importMarkdown: Importer = async ({ store, location }) => {
    if (!store.exists(location)) throw new ImportError(`No file at ${location}.`);
    const text = store.read(location)!;
    const ref = path.basename(location);
    const tables = tablesToDrafts(pipeTables(text), ref);
    if (tables.drafts.length) return { drafts: tables.drafts, warnings: tables.warnings, ref, raw: { name: ref, content: text } };
    const parsed = parseLabelledText(text, ref);
    return { ...parsed, ref, raw: { name: ref, content: text } };
};
