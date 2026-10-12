import { basicAuth, trimSlash } from '../../../integrations/http.js';
import { type Draft, type ImportWarning, splitNumbered } from '../../normalize.js';
import type { Importer } from '../types.js';
import { asText, htmlToText, moreAtSource, needEnv, Remote, RemoteImportError, structureText } from './common.js';

/**
 * BrowserStack Test Management, API v2:
 *   GET /api/v2/projects/{PR-x}/test-cases?p=<page>[&folder_id=<id>] → { success, test_cases, info: { page, page_size, count, prev, next } }
 * Each case has identifier (TC-123), title, description, preconditions, priority, tags, folder_id,
 * template (test_case_steps | test_case_text) and steps [{ step, result, order }] (HTML; create
 * calls name the same list test_case_steps). Root folders (GET /api/v2/projects/{PR-x}/folders)
 * give area names and, through their web URL, the numeric project id used in browse links.
 * Auth: Basic with BROWSERSTACK_USERNAME + BROWSERSTACK_ACCESS_KEY. BROWSERSTACK_TM_URL selects
 * a regional host (test-management-eu / -in.browserstack.com).
 */

const DEFAULT_BASE = 'https://test-management.browserstack.com';
const LOCATION = /^\s*([A-Z]+-\d+)(?:\s*\/\s*(\d+))?\s*$/i;

interface BsCase {
    identifier?: string;
    title?: string;
    description?: string | null;
    preconditions?: string | null;
    priority?: string | null;
    tags?: string[];
    folder_id?: number | null;
    template?: string;
    steps?: Array<{ step?: string | null; result?: string | null; order?: number }>;
    test_case_steps?: Array<{ step?: string | null; result?: string | null; order?: number }>;
}

interface BsPage {
    success?: boolean;
    message?: string;
    test_cases?: BsCase[];
    info?: { page?: number; next?: number | null; count?: number };
}

interface BsFolders {
    folders?: Array<{ id: number; name?: string; urls?: { self?: string } }>;
    info?: { next?: number | null };
}

export const importBrowserStack: Importer = async request => {
    const env = needEnv(request, 'BrowserStack Test Management', ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY']);
    const where = request.location.match(LOCATION);
    if (!where) throw new RemoteImportError('For BrowserStack, location is the Test Management project id (e.g. PR-1), optionally with a folder id: PR-1/123.');
    const project = where[1].toUpperCase();
    const folderId = where[2];
    const root = trimSlash(env.BROWSERSTACK_TM_URL || DEFAULT_BASE);
    const api = new Remote(request, {
        service: 'BrowserStack Test Management',
        headers: { Authorization: basicAuth(env.BROWSERSTACK_USERNAME, env.BROWSERSTACK_ACCESS_KEY), Accept: 'application/json' },
        secretKeys: ['BROWSERSTACK_ACCESS_KEY'],
        credentialKeys: ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY'],
        authHint: 'EU or India accounts also need BROWSERSTACK_TM_URL (https://test-management-eu.browserstack.com or https://test-management-in.browserstack.com).'
    });
    const ref = `BrowserStack ${project}${folderId ? ` folder ${folderId}` : ''}`;
    const warnings: ImportWarning[] = [];
    const projectUrl = `${root}/api/v2/projects/${encodeURIComponent(project)}`;

    const cases: BsCase[] = [];
    const raw: BsPage[] = [];
    let page: number | undefined = 1;
    let more = false;
    for (let n = 0; page && n < 1000; n++) {
        const res: BsPage = await api.json<BsPage>(`${projectUrl}/test-cases?${new URLSearchParams({ p: String(page), ...(folderId ? { folder_id: folderId } : {}) })}`);
        if (res?.success === false) throw api.error(`BrowserStack could not list the test cases of ${project}${res.message ? `: ${String(res.message).slice(0, 200)}` : '.'}`);
        raw.push(res ?? {});
        cases.push(...(res?.test_cases ?? []));
        const next: number | null | undefined = res?.info?.next;
        page = typeof next === 'number' && next > page ? next : undefined;
        if (cases.length >= request.limit) {
            more = Boolean(page) || cases.length > request.limit;
            break;
        }
    }
    const listed = cases.filter(c => c.identifier).slice(0, request.limit);
    if (!listed.length) throw new RemoteImportError(`No test cases in ${ref}. Check the project id (PR-…) in Test Management.`);

    // Root folder names for areas, and the numeric project id for browse links; both optional.
    const folderName = new Map<number, string>();
    let numericProject: string | undefined;
    try {
        const folders = await api.json<BsFolders>(`${projectUrl}/folders?p=1&page_size=300`);
        for (const f of folders?.folders ?? []) {
            if (f.name) folderName.set(f.id, f.name);
            numericProject ??= f.urls?.self?.match(/\/projects\/(\d+)\//)?.[1];
        }
    } catch (error) {
        if (!(error instanceof RemoteImportError) || error.status === 401) throw error;
    }

    const drafts: Draft[] = listed.map(tc => {
        const id = tc.identifier!;
        const description = htmlToText(tc.description);
        const steps = [...(tc.steps ?? tc.test_case_steps ?? [])]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map(s => ({ action: htmlToText(s.step).text, expected: htmlToText(s.result).text || undefined }));
        const draft: Draft = {
            id,
            title: tc.title,
            description: asText(description),
            preconditions: splitNumbered(htmlToText(tc.preconditions).text),
            steps,
            priority: tc.priority ?? undefined,
            area: tc.folder_id ? folderName.get(tc.folder_id) : undefined,
            tags: (tc.tags ?? []).filter(t => typeof t === 'string'),
            sourceRef: id
        };
        if (!steps.length) {
            // Text template: the steps are written in the description.
            const s = structureText(description.text, description.tables, id);
            draft.steps = s.steps;
            draft.expected = s.expected;
            draft.testData = s.testData;
            draft.preconditions.push(...s.preconditions);
            draft.description = s.description;
        }
        return draft;
    });
    const folderOf = new Map(listed.map(tc => [tc.identifier!, tc.folder_id]));
    const bare = drafts.filter(d => !d.steps.length && !d.expected).map(d => d.id!);
    if (bare.length) warnings.push({ ref, message: `${bare.length} case(s) have no steps (${bare.slice(0, 10).join(', ')}${bare.length > 10 ? ', …' : ''}).` });
    if (more) warnings.push(moreAtSource(ref, request.limit));
    return {
        drafts,
        warnings,
        ref,
        raw: api.raw(`browserstack-${project}.json`, { source: 'browserstack', project, folderId: folderId ?? null, pages: raw }),
        // Same link format as BrowserStack's own MCP server; needs the numeric project id.
        linkFor: numericProject
            ? id => {
                  const folder = folderOf.get(id) ?? folderOf.get(id.replace(/-\d+$/, ''));
                  return folder ? `${root}/projects/${numericProject}/folders/${folder}/test-cases/${encodeURIComponent(id)}` : undefined;
              }
            : undefined,
        idPrefix: 'TC'
    };
};
