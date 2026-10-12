import type { ProjectStore } from '../../core/store.js';
import type { Draft, ImportWarning } from '../normalize.js';

export interface ImportRequest {
    store: ProjectStore;
    /** File path inside the repository, JQL, project id, … depending on the source. */
    location: string;
    /** Spreadsheet sheet name (Excel). */
    sheet?: string;
    env: Record<string, string>;
    fetch?: typeof fetch;
    limit: number;
}

export interface ImportedBatch {
    drafts: Draft[];
    warnings: ImportWarning[];
    /** Human-readable reference to where the cases came from (file name, JQL, …). */
    ref: string;
    /** Raw copy kept in .testpilot/test-cases/raw for traceability. */
    raw?: { name: string; content: string | Buffer };
    linkFor?: (id: string) => string | undefined;
    idPrefix?: string;
}

export type Importer = (request: ImportRequest) => Promise<ImportedBatch>;

export class ImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImportError';
    }
}
