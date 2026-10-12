import { trimSlash } from '../../../integrations/http.js';
import { type Draft, type ImportWarning, splitNumbered } from '../../normalize.js';
import { scenarioBodySteps } from '../gherkin.js';
import type { Importer } from '../types.js';
import { asText, htmlToText, mapLimit, moreAtSource, needEnv, Remote, RemoteImportError, structureText } from './common.js';

/**
 * Zephyr (formerly Zephyr Scale) Cloud, REST API v2. BETA: SmartBear's API reference is a
 * JavaScript-rendered page that could not be read when this was written, so the paths and
 * shapes below were checked against typed third-party clients instead:
 *   GET /testcases?projectKey=&folderId=&maxResults=&startAt=   → { values, startAt, maxResults, total, isLast }
 *   GET /testcases/{key}/teststeps?maxResults=&startAt=        → { values: [{ inline: { description, testData, expectedResult } | testCase: { testCaseKey } }] }
 *   GET /testcases/{key}/testscript                            → { type: plain | bdd, text }
 *   GET /folders?projectKey=&folderType=TEST_CASE, GET /priorities/{id}
 * Auth: Authorization: Bearer ZEPHYR_API_TOKEN. Text fields are HTML.
 */

const DEFAULT_BASE = 'https://api.zephyrscale.smartbear.com/v2';
const PAGE_SIZE = 100;
const LOCATION = /^\s*([A-Z][A-Z0-9_]*)(?:\s*\/\s*(\d+))?\s*$/i;

interface Paged<T> {
    values?: T[];
    startAt?: number;
    maxResults?: number;
    total?: number;
    isLast?: boolean;
}

interface ZephyrCase {
    id?: number;
    key?: string;
    name?: string;
    objective?: string | null;
    precondition?: string | null;
    labels?: string[];
    priority?: { id?: number } | null;
    folder?: { id?: number } | null;
    testScript?: { self?: string } | null;
}

interface ZephyrStep {
    inline?: { description?: string | null; testData?: string | null; expectedResult?: string | null } | null;
    testCase?: { testCaseKey?: string } | null;
}

interface ZephyrFolder {
    id: number;
    parentId?: number | null;
    name?: string;
}

const text = (html: string | null | undefined) => htmlToText(html).text;

async function pages<T>(api: Remote, url: (startAt: number, size: number) => string, limit: number, maxPages: number): Promise<{ values: T[]; more: boolean; raw: Paged<T>[] }> {
    const values: T[] = [];
    const raw: Paged<T>[] = [];
    let startAt = 0;
    for (let page = 0; page < maxPages && values.length < limit; page++) {
        const res = await api.json<Paged<T>>(url(startAt, Math.min(PAGE_SIZE, limit - values.length)));
        raw.push(res ?? {});
        const got = res?.values ?? [];
        values.push(...got);
        startAt += got.length;
        const last = res?.isLast ?? (res?.total !== undefined ? startAt >= res.total : got.length < (res?.maxResults ?? PAGE_SIZE));
        if (last || !got.length) return { values, more: false, raw };
    }
    return { values: values.slice(0, limit), more: true, raw };
}

export const importZephyr: Importer = async request => {
    const env = needEnv(request, 'Zephyr', ['ZEPHYR_API_TOKEN']);
    const where = request.location.match(LOCATION);
    if (!where) throw new RemoteImportError('For Zephyr, location is the Jira project key (e.g. SHOP), optionally with a folder id: SHOP/123.');
    const projectKey = where[1].toUpperCase();
    const folderId = where[2];
    const base = trimSlash(env.ZEPHYR_BASE_URL || DEFAULT_BASE);
    const api = new Remote(request, {
        service: 'Zephyr',
        headers: { Authorization: `Bearer ${env.ZEPHYR_API_TOKEN}`, Accept: 'application/json' },
        secretKeys: ['ZEPHYR_API_TOKEN'],
        credentialKeys: ['ZEPHYR_API_TOKEN'],
        authHint: 'Create a new token under your Jira profile → Zephyr API Access Tokens if it expired.'
    });
    const ref = `Zephyr ${projectKey}${folderId ? ` folder ${folderId}` : ''}`;
    const warnings: ImportWarning[] = [];

    const listed = await pages<ZephyrCase>(api, (startAt, size) => `${base}/testcases?${new URLSearchParams({ projectKey, ...(folderId ? { folderId } : {}), maxResults: String(size), startAt: String(startAt) })}`, request.limit, 1000);
    const cases = listed.values.filter(c => c.key);
    if (!cases.length) throw new RemoteImportError(`No Zephyr test cases in ${ref}. Check the project key${folderId ? ' and folder id' : ''}.`);

    // Folder and priority names are nice to have; the import goes on without them.
    const folderPath = new Map<number, string>();
    if (cases.some(c => c.folder?.id)) {
        try {
            const folders = await pages<ZephyrFolder>(api, (startAt, size) => `${base}/folders?${new URLSearchParams({ projectKey, folderType: 'TEST_CASE', maxResults: String(size), startAt: String(startAt) })}`, 5000, 50);
            const byId = new Map(folders.values.map(f => [f.id, f]));
            for (const f of folders.values) {
                const names: string[] = [];
                const seen = new Set<number>();
                for (let cur: ZephyrFolder | undefined = f; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
                    seen.add(cur.id);
                    if (cur.name) names.unshift(cur.name);
                }
                folderPath.set(f.id, names.join('/'));
            }
        } catch (error) {
            if (!(error instanceof RemoteImportError) || error.status === 401) throw error;
            warnings.push({ ref, message: 'Could not read folder names, so cases have no area.' });
        }
    }
    const priorityName = new Map<number, string>();
    try {
        for (const id of new Set(cases.map(c => c.priority?.id).filter((id): id is number => typeof id === 'number'))) {
            const p = await api.json<{ name?: string }>(`${base}/priorities/${id}`);
            if (p?.name) priorityName.set(id, p.name);
        }
    } catch (error) {
        if (!(error instanceof RemoteImportError) || error.status === 401) throw error;
        warnings.push({ ref, message: 'Could not read priority names, so cases have no priority.' });
    }

    const scripts: Record<string, unknown> = {};
    const drafts = await mapLimit(cases, 4, async (tc): Promise<Draft> => {
        const key = tc.key!;
        const objective = htmlToText(tc.objective);
        const draft: Draft = {
            id: key,
            title: tc.name,
            description: asText(objective),
            preconditions: splitNumbered(text(tc.precondition)),
            steps: [],
            priority: tc.priority?.id !== undefined ? priorityName.get(tc.priority.id) : undefined,
            area: tc.folder?.id ? folderPath.get(tc.folder.id) : undefined,
            tags: (tc.labels ?? []).filter(l => typeof l === 'string'),
            sourceRef: key
        };
        const self = tc.testScript?.self ?? '';
        try {
            if (/\/teststeps\/?$/.test(self)) {
                const steps = await pages<ZephyrStep>(api, (startAt, size) => `${base}/testcases/${encodeURIComponent(key)}/teststeps?maxResults=${size}&startAt=${startAt}`, 1000, 10);
                scripts[key] = steps.raw;
                draft.steps = steps.values.map(s =>
                    s.inline
                        ? { action: text(s.inline.description), data: text(s.inline.testData) || undefined, expected: text(s.inline.expectedResult) || undefined }
                        : { action: `Run the steps of ${s.testCase?.testCaseKey ?? 'another test case'}` }
                );
            } else if (/\/testscript\/?$/.test(self)) {
                const script = await api.json<{ type?: string; text?: string }>(`${base}/testcases/${encodeURIComponent(key)}/testscript`);
                scripts[key] = script;
                const body = htmlToText(script?.text);
                if (script?.type === 'bdd') {
                    const g = scenarioBodySteps(body.text);
                    draft.steps = g.steps;
                    draft.preconditions.push(...g.preconditions);
                    draft.expected = g.expected;
                    draft.testData = g.examples;
                } else {
                    const s = structureText(body.text, body.tables, key);
                    draft.steps = s.steps.length ? s.steps : body.text ? [{ action: body.text }] : [];
                    draft.expected = s.expected;
                    draft.preconditions.push(...s.preconditions);
                    draft.testData = s.testData;
                }
            }
        } catch (error) {
            if (!(error instanceof RemoteImportError) || error.status === 401 || error.status === 403) throw error;
            warnings.push({ ref: key, message: `Could not read the test script of ${key} (${error.status ?? 'error'}); imported without steps.` });
        }
        return draft;
    });
    const bare = drafts.filter(d => !d.steps.length && !d.expected).map(d => d.id!);
    if (bare.length) warnings.push({ ref, message: `${bare.length} case(s) have no test script yet (${bare.slice(0, 10).join(', ')}${bare.length > 10 ? ', …' : ''}).` });
    if (listed.more) warnings.push(moreAtSource(ref, request.limit));
    const jira = env.JIRA_BASE_URL ? trimSlash(env.JIRA_BASE_URL) : undefined;
    return {
        drafts,
        warnings,
        ref,
        raw: api.raw(`zephyr-${projectKey}.json`, { source: 'zephyr', projectKey, folderId: folderId ?? null, testcases: listed.raw, scripts }),
        // Zephyr's app page inside Jira; the fragment format is not documented by SmartBear.
        linkFor: jira ? id => `${jira}/projects/${projectKey}?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.kanoah.test-manager__main-project-page#!/v2/testCase/${encodeURIComponent(id)}` : undefined,
        idPrefix: `${projectKey}-T`
    };
};
