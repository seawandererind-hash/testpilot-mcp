import path from 'node:path';

import { parse } from 'csv-parse/sync';

import { findHeaderRow, rowsToDrafts } from '../normalize.js';
import { ImportError, type Importer } from './types.js';

/** Picks the delimiter that splits the first lines most consistently. */
function detectDelimiter(text: string): string {
    const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 5);
    const candidates = [',', ';', '\t', '|'];
    let best = ',';
    let bestScore = -1;
    for (const d of candidates) {
        const counts = lines.map(l => l.split(d).length - 1);
        const score = counts.length && counts.every(c => c === counts[0]) ? counts[0] * 2 : Math.min(...counts);
        if (score > bestScore) {
            best = d;
            bestScore = score;
        }
    }
    return best;
}

export const importCsv: Importer = async ({ store, location }) => {
    if (!store.exists(location)) throw new ImportError(`No file at ${location}. Put the CSV file inside the repository and try again.`);
    const text = store.read(location)!.replace(/^﻿/, '');
    let rows: string[][];
    try {
        rows = parse(text, { delimiter: detectDelimiter(text), relax_column_count: true, relax_quotes: true, skip_empty_lines: false, bom: true }) as string[][];
    } catch (error) {
        throw new ImportError(`Could not read ${location} as CSV: ${(error as Error).message}`);
    }
    const header = findHeaderRow(rows);
    if (!header) throw new ImportError(`Could not find a header row in ${location}. The first line should contain column names such as ID, Title, Steps, Expected Result.`);
    const out = rowsToDrafts(rows.slice(header.index + 1), header.mapping, path.basename(location), header.index + 2);
    const warnings = header.mapping.unmapped.length ? [{ ref: location, message: `Columns not used: ${header.mapping.unmapped.join(', ')}.` }, ...out.warnings] : out.warnings;
    return { drafts: out.drafts, warnings, ref: path.basename(location), raw: { name: path.basename(location), content: text } };
};
