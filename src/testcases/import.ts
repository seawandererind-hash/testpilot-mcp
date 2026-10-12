import path from 'node:path';

import { digestOf } from '../core/confirm.js';
import type { TestCase, TestCaseSource } from '../core/schema.js';
import { CASES_RAW_DIR, type ProjectStore, safeFileName } from '../core/store.js';
import { IntegrationError } from '../integrations/http.js';
import { importCsv } from './importers/csv.js';
import { importExcel } from './importers/excel.js';
import { importGherkin } from './importers/gherkin.js';
import { importMarkdown } from './importers/markdown.js';
import { importAzureDevOps } from './importers/remote/azure-devops.js';
import { importBrowserStack } from './importers/remote/browserstack.js';
import { importJira } from './importers/remote/jira.js';
import { importTestRail } from './importers/remote/testrail.js';
import { importXray } from './importers/remote/xray.js';
import { importZephyr } from './importers/remote/zephyr.js';
import { ImportError, type Importer, type ImportRequest } from './importers/types.js';
import { importWord } from './importers/word.js';
import { finalise, type ImportWarning } from './normalize.js';

export const IMPORTERS: Partial<Record<TestCaseSource, Importer>> = {
    excel: importExcel,
    csv: importCsv,
    word: importWord,
    markdown: importMarkdown,
    gherkin: importGherkin,
    // Remote tools (importers/remote/): credentials come from request.env, never from tool arguments.
    jira: importJira,
    xray: importXray,
    zephyr: importZephyr,
    testrail: importTestRail,
    browserstack: importBrowserStack,
    'azure-devops': importAzureDevOps
};

/** Further sources (qTest, a team's in-house tool) can register here so the tool code stays the same. */
export function registerImporter(source: TestCaseSource, importer: Importer): void {
    IMPORTERS[source] = importer;
}

/** Guesses the source from a file name when the user did not say. */
export function sourceFromPath(location: string): TestCaseSource | undefined {
    const ext = path.extname(location).toLowerCase();
    return ({ '.xlsx': 'excel', '.xls': 'excel', '.csv': 'csv', '.tsv': 'csv', '.docx': 'word', '.doc': 'word', '.md': 'markdown', '.markdown': 'markdown', '.feature': 'gherkin' } as const)[ext as '.xlsx'];
}

/** The parts of a case that come from its source; a change here means the case needs a fresh review. */
export function contentDigest(tc: TestCase): string {
    const { id, title, description, preconditions, steps, expected, testData, priority, area, tags } = tc;
    return digestOf({ id, title, description, preconditions, steps, expected, testData, priority, area, tags });
}

export interface ImportOutcome {
    source: TestCaseSource;
    ref: string;
    added: string[];
    updated: string[];
    unchanged: string[];
    cases: TestCase[];
    warnings: ImportWarning[];
    flagged: string[];
    redactions: number;
    rawCopy?: string;
}

export async function runImport(store: ProjectStore, source: TestCaseSource, request: Omit<ImportRequest, 'store'>, dryRun: boolean): Promise<ImportOutcome> {
    const importer = IMPORTERS[source];
    if (!importer) throw new ImportError(`Importing from ${source} is not available yet. Export the cases to Excel or CSV and import that file.`);
    let batch;
    try {
        batch = await importer({ ...request, store });
    } catch (error) {
        // Integration helpers throw IntegrationError; the tool shows ImportError messages to the user.
        if (error instanceof IntegrationError) throw new ImportError(error.message);
        throw error;
    }
    const drafts = batch.drafts.slice(0, request.limit);
    const warnings = [...batch.warnings];
    if (batch.drafts.length > request.limit) warnings.push({ ref: batch.ref, message: `Only the first ${request.limit} of ${batch.drafts.length} cases were imported. Raise limit to import more.` });
    const done = finalise(drafts, { type: source, ref: batch.ref, linkFor: batch.linkFor }, batch.idPrefix);
    warnings.push(...done.warnings);

    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const cases: TestCase[] = [];
    for (const incoming of done.cases) {
        const existing = store.readCase(incoming.id);
        if (!existing) {
            added.push(incoming.id);
            cases.push(incoming);
            continue;
        }
        if (contentDigest(existing) === contentDigest(incoming)) {
            unchanged.push(incoming.id);
            cases.push(existing);
            continue;
        }
        // Changed at the source: keep the automation link, drop the review so it is redone.
        updated.push(incoming.id);
        cases.push({ ...incoming, automation: existing.automation });
    }

    let rawCopy: string | undefined;
    if (!dryRun) {
        for (const tc of cases) if (!unchanged.includes(tc.id)) store.writeCase(tc);
        if (batch.raw) {
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
            rawCopy = `${CASES_RAW_DIR}/${stamp}-${safeFileName(batch.raw.name)}`;
            store.write(rawCopy, batch.raw.content);
        }
        store.recordDecision(`Imported ${cases.length} test case(s) from ${source} (${batch.ref}): ${added.length} new, ${updated.length} changed`, 'Test-case import', 'user');
    }
    return { source, ref: batch.ref, added, updated, unchanged, cases, warnings, flagged: done.flagged, redactions: done.redactions, rawCopy };
}

export { ImportError };
