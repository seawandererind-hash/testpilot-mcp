import path from 'node:path';

import ExcelJS from 'exceljs';

import { cellText, findHeaderRow, rowsToDrafts } from '../normalize.js';
import { ImportError, type Importer } from './types.js';

/** Excel workbooks: picks the sheet (or the first with test-case headers) and maps columns by name. */
export const importExcel: Importer = async ({ store, location, sheet }) => {
    if (!/\.xlsx$/i.test(location)) {
        throw new ImportError(/\.xls$/i.test(location) ? 'Old .xls files are not supported. Open it in Excel and save as .xlsx (or export as CSV).' : 'Give the path of an .xlsx file inside the repository.');
    }
    if (!store.exists(location)) throw new ImportError(`No file at ${location}. Copy the workbook into the repository (for example test-cases/) and try again.`);
    const buffer = store.readBuffer(location);
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch (error) {
        throw new ImportError(`Could not read ${location} as an Excel workbook (${(error as Error).message}). Is it password-protected? Save an unprotected copy.`);
    }
    const sheets = workbook.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden');
    if (!sheets.length) throw new ImportError(`${location} has no visible sheets.`);
    const candidates = sheet ? sheets.filter(ws => ws.name.toLowerCase() === sheet.toLowerCase()) : sheets;
    if (sheet && !candidates.length) throw new ImportError(`No sheet named "${sheet}". Sheets: ${sheets.map(ws => ws.name).join(', ')}.`);

    const warnings = [];
    const drafts = [];
    let used = 0;
    for (const ws of candidates) {
        const rows: string[][] = [];
        ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            const values: string[] = [];
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                values[colNumber - 1] = cellText(cell.isMerged && cell.master !== cell ? cell.master.value : cell.value);
            });
            rows[rowNumber - 1] = Array.from(values, v => v ?? '');
        });
        const dense = Array.from(rows, r => r ?? []);
        const header = findHeaderRow(dense);
        if (!header) {
            if (sheet || candidates.length === 1) throw new ImportError(`Could not find a header row in sheet "${ws.name}". The first rows should contain column names such as ID, Title, Steps, Expected Result.`);
            continue;
        }
        if (header.mapping.columns.steps === undefined && header.mapping.columns.expected === undefined) {
            warnings.push({ ref: ws.name, message: 'No Steps or Expected Result column found; cases will have titles only.' });
        }
        if (header.mapping.unmapped.length) warnings.push({ ref: ws.name, message: `Columns not used: ${header.mapping.unmapped.join(', ')}.` });
        const out = rowsToDrafts(dense.slice(header.index + 1), header.mapping, `${path.basename(location)} › ${ws.name}`, header.index + 2);
        for (const d of out.drafts) d.area ??= candidates.length > 1 ? ws.name : undefined;
        drafts.push(...out.drafts);
        warnings.push(...out.warnings);
        used++;
    }
    if (!used) throw new ImportError(`None of the sheets in ${location} has test-case columns (ID, Title, Steps, Expected Result). Sheets: ${sheets.map(ws => ws.name).join(', ')}.`);
    return { drafts, warnings, ref: path.basename(location), raw: { name: path.basename(location), content: buffer } };
};
