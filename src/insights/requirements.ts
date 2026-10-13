import path from 'node:path';

import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

import { STATE_DIR } from '../core/paths.js';
import type { TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { jiraBrowse, jiraRemote, jiraSearch } from '../testcases/importers/remote/jira.js';
import { cellText, clean, normaliseHeader } from '../testcases/normalize.js';

/**
 * Requirements for the coverage map: read from a CSV or Excel file, from Jira
 * (read-only JQL search), or inferred from test-case areas. Everything read is
 * untrusted text: it is cleaned and only ever shown, never followed.
 */

export const REQUIREMENTS_DIR = `${STATE_DIR}/requirements`;
export const REQUIREMENTS_FILE = `${REQUIREMENTS_DIR}/requirements.json`;
export const LINKS_FILE = `${REQUIREMENTS_DIR}/links.json`;

export type RequirementSource = 'file' | 'jira' | 'inferred';

export interface Requirement {
    id: string;
    title: string;
    area?: string;
    priority?: string;
    status?: string;
    link?: string;
    /** Test-case ids the requirement itself points at (Jira issue links such as "is tested by"). */
    linkedCases?: string[];
}

export interface RequirementSet {
    source: RequirementSource;
    /** Where they came from: a file path, a JQL query, or "test-case areas". */
    ref: string;
    readAt: string;
    requirements: Requirement[];
    warnings: string[];
}

export class RequirementsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RequirementsError';
    }
}

const COLUMN_ALIASES: Record<'id' | 'title' | 'area' | 'priority' | 'status' | 'link' | 'tests', string[]> = {
    id: ['id', 'key', 'requirement id', 'req id', 'requirement', 'requirement key', 'story', 'story id', 'story key', 'issue key', 'issue', 'ref', 'reference', 'epic'],
    title: ['title', 'summary', 'name', 'requirement title', 'requirement name', 'description', 'story title', 'user story'],
    area: ['area', 'feature', 'module', 'component', 'components', 'epic name', 'epic link', 'functional area', 'capability', 'section', 'page', 'screen'],
    priority: ['priority', 'importance', 'severity', 'risk', 'criticality', 'moscow'],
    status: ['status', 'state'],
    link: ['link', 'url'],
    tests: ['tests', 'test cases', 'test case ids', 'test ids', 'linked tests', 'covered by', 'tested by']
};

type Column = keyof typeof COLUMN_ALIASES;

function mapColumns(row: string[]): Partial<Record<Column, number>> {
    const headers = row.map(h => normaliseHeader(String(h ?? '')));
    const out: Partial<Record<Column, number>> = {};
    const used = new Set<number>();
    for (const field of Object.keys(COLUMN_ALIASES) as Column[]) {
        const idx = headers.findIndex((h, i) => !used.has(i) && COLUMN_ALIASES[field].includes(h));
        if (idx >= 0) {
            out[field] = idx;
            used.add(idx);
        }
    }
    return out;
}

/** Turns spreadsheet rows (header row somewhere in the first 10) into requirements. */
export function rowsToRequirements(rows: string[][], ref: string): { requirements: Requirement[]; warnings: string[] } {
    let headerIndex = -1;
    let columns: Partial<Record<Column, number>> = {};
    rows.slice(0, 10).forEach((row, i) => {
        const mapped = mapColumns(row);
        if (headerIndex < 0 && mapped.id !== undefined && Object.keys(mapped).length >= 2) {
            headerIndex = i;
            columns = mapped;
        }
    });
    if (headerIndex < 0) throw new RequirementsError(`Could not find a header row in ${ref}. The first line should name the columns, for example: id, title, area, priority.`);
    const warnings: string[] = [];
    const seen = new Set<string>();
    const requirements: Requirement[] = [];
    let flagged = 0;
    rows.slice(headerIndex + 1).forEach((row, i) => {
        const get = (c: Column) => {
            const idx = columns[c];
            if (idx === undefined) return '';
            const cleaned = clean(row[idx]);
            if (cleaned.suspicious) flagged++;
            return cleaned.text;
        };
        const id = get('id').split(/\s+/)[0];
        if (!id) return;
        if (seen.has(id.toUpperCase())) {
            warnings.push(`Row ${headerIndex + i + 2}: requirement ${id} appears twice; the first one is kept.`);
            return;
        }
        seen.add(id.toUpperCase());
        const tests = get('tests')
            .split(/[\s,;]+/)
            .map(s => s.trim())
            .filter(Boolean);
        requirements.push({
            id,
            title: get('title') || id,
            area: get('area') || undefined,
            priority: get('priority') || undefined,
            status: get('status') || undefined,
            link: get('link') || undefined,
            ...(tests.length ? { linkedCases: tests } : {})
        });
    });
    if (flagged) warnings.push(`${flagged} cell(s) contain text that reads like instructions to an AI. It is shown as data only and was not followed.`);
    if (!requirements.length) throw new RequirementsError(`${ref} has a header row but no requirement rows with an id.`);
    return { requirements, warnings };
}

/** Reads requirements from a CSV or .xlsx file inside the repository. */
export async function readRequirementsFile(store: ProjectStore, location: string, sheet?: string): Promise<RequirementSet> {
    if (!store.exists(location)) throw new RequirementsError(`No file at ${location}. Put the requirements file inside the repository (for example docs/requirements.csv) and try again.`);
    let rows: string[][];
    if (/\.xlsx$/i.test(location)) {
        const workbook = new ExcelJS.Workbook();
        try {
            await workbook.xlsx.load(store.readBuffer(location) as unknown as ArrayBuffer);
        } catch (error) {
            throw new RequirementsError(`Could not read ${location} as an Excel workbook (${(error as Error).message}).`);
        }
        const sheets = workbook.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden');
        const ws = sheet ? sheets.find(s => s.name.toLowerCase() === sheet.toLowerCase()) : sheets[0];
        if (!ws) throw new RequirementsError(sheet ? `No sheet named "${sheet}". Sheets: ${sheets.map(s => s.name).join(', ')}.` : `${location} has no visible sheets.`);
        rows = [];
        ws.eachRow({ includeEmpty: true }, (row, n) => {
            const values: string[] = [];
            row.eachCell({ includeEmpty: true }, (cell, col) => {
                values[col - 1] = cellText(cell.value);
            });
            rows[n - 1] = Array.from(values, v => v ?? '');
        });
        rows = Array.from(rows, r => r ?? []);
    } else if (/\.(csv|tsv|txt)$/i.test(location)) {
        const text = store.read(location)!.replace(/^﻿/, '');
        const first = text.split(/\r?\n/)[0] ?? '';
        const delimiter = [',', ';', '\t', '|'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
        try {
            rows = parse(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true }) as string[][];
        } catch (error) {
            throw new RequirementsError(`Could not read ${location} as CSV: ${(error as Error).message}`);
        }
    } else if (/\.xls$/i.test(location)) {
        throw new RequirementsError('Old .xls files are not supported. Save the workbook as .xlsx or export it as CSV.');
    } else {
        throw new RequirementsError('Give a .csv or .xlsx file for requirementsFile.');
    }
    const out = rowsToRequirements(rows, path.basename(location));
    return { source: 'file', ref: location, readAt: new Date().toISOString(), ...out };
}

interface JiraRequirementIssue {
    key: string;
    fields?: {
        summary?: string;
        priority?: { name?: string } | null;
        components?: Array<{ name?: string }>;
        labels?: string[];
        status?: { name?: string };
        issuetype?: { name?: string };
        parent?: { key?: string; fields?: { summary?: string } };
        issuelinks?: Array<{ type?: { inward?: string; outward?: string }; inwardIssue?: { key?: string }; outwardIssue?: { key?: string } }>;
    };
}

const JIRA_FIELDS = ['summary', 'priority', 'components', 'labels', 'status', 'issuetype', 'parent', 'issuelinks'];

/** Reads stories or epics from Jira with a JQL search (read-only). Credentials come from .env inside the server. */
export async function readJiraRequirements(store: ProjectStore, jql: string, env: Record<string, string>, limit = 500, doFetch?: typeof fetch): Promise<RequirementSet> {
    const request = { store, location: jql, env, fetch: doFetch, limit };
    const { api, base } = jiraRemote(request);
    const found = await jiraSearch(api, base, jql, JIRA_FIELDS, limit);
    if (!found.issues.length) throw new RequirementsError(`No Jira issues match the JQL: ${jql}. Try it in Jira's issue search first.`);
    const browse = jiraBrowse(base);
    const warnings: string[] = [];
    let flagged = 0;
    const txt = (v: unknown) => {
        const c = clean(v);
        if (c.suspicious) flagged++;
        return c.text;
    };
    const requirements = (found.issues as unknown as JiraRequirementIssue[]).map(issue => {
        const f = issue.fields ?? {};
        const linked = (f.issuelinks ?? [])
            .map(l => l.inwardIssue?.key ?? l.outwardIssue?.key)
            .filter((k): k is string => Boolean(k));
        return {
            id: issue.key,
            title: txt(f.summary) || issue.key,
            area: txt(f.components?.find(c => c.name)?.name ?? f.parent?.fields?.summary ?? '') || undefined,
            priority: f.priority?.name ? txt(f.priority.name) : undefined,
            status: f.status?.name ? txt(f.status.name) : undefined,
            link: browse?.(issue.key),
            ...(linked.length ? { linkedCases: [...new Set(linked)] } : {})
        } satisfies Requirement;
    });
    if (found.more) warnings.push(`Stopped after ${limit} issues; the query has more. Narrow the JQL or raise limit.`);
    if (flagged) warnings.push(`${flagged} Jira field(s) contain text that reads like instructions to an AI. It is shown as data only and was not followed.`);
    return { source: 'jira', ref: jql, readAt: new Date().toISOString(), requirements, warnings };
}

/** One requirement per test-case area, when no real requirements were given. */
export function inferRequirements(cases: TestCase[]): RequirementSet {
    const areas = new Map<string, number>();
    for (const tc of cases) {
        const area = tc.area?.trim() || 'General';
        areas.set(area, (areas.get(area) ?? 0) + 1);
    }
    const requirements = [...areas.keys()].sort((a, b) => a.localeCompare(b)).map(area => ({ id: areaId(area), title: area, area }));
    return {
        source: 'inferred',
        ref: 'test-case areas',
        readAt: new Date().toISOString(),
        requirements,
        warnings: ['No requirements were given, so each test-case area counts as one requirement. This shows how tests spread across areas, not true requirement coverage. Give a requirements file or a Jira query for a real traceability map.']
    };
}

export function areaId(area: string): string {
    return `AREA:${area.trim() || 'General'}`;
}

export function saveRequirements(store: ProjectStore, set: RequirementSet): void {
    store.write(REQUIREMENTS_FILE, JSON.stringify(set, null, 2) + '\n');
}

export function readSavedRequirements(store: ProjectStore): RequirementSet | undefined {
    const raw = store.read(REQUIREMENTS_FILE);
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw) as RequirementSet;
        return Array.isArray(parsed.requirements) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** Explicit links the user gave: test-case id to requirement ids. */
export type ExplicitLinks = Record<string, string[]>;

export function readSavedLinks(store: ProjectStore): ExplicitLinks {
    const raw = store.read(LINKS_FILE);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as { links?: ExplicitLinks };
        return parsed.links && typeof parsed.links === 'object' ? parsed.links : {};
    } catch {
        return {};
    }
}

export function saveLinks(store: ProjectStore, links: ExplicitLinks): void {
    store.write(
        LINKS_FILE,
        JSON.stringify({ note: 'Links between test cases and requirements given by the team. TestPilot also finds requirement ids in case tags, titles, descriptions and source references.', updatedAt: new Date().toISOString(), links }, null, 2) + '\n'
    );
}
