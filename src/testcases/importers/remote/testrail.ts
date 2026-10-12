import { basicAuth, trimSlash } from '../../../integrations/http.js';
import { clean, type Draft, type ImportWarning, pairSteps, splitNumbered } from '../../normalize.js';
import type { Importer } from '../types.js';
import { moreAtSource, needEnv, Remote, RemoteImportError } from './common.js';

/**
 * TestRail (API v2). get_cases/{project_id}&suite_id= pages with limit/offset and _links.next
 * (TestRail 6.7+; older servers return a plain array). Handles the "Test Case (Steps)" template
 * (custom_steps_separated: content / expected / additional_info) and the text template
 * (custom_steps / custom_expected), custom_preconds, priority names and section paths.
 * Ids become C<id>, the form result sync (integrations/sync.ts) matches.
 * Auth: Basic with TESTRAIL_USER + TESTRAIL_API_KEY.
 */

const PAGE_SIZE = 250;
const LOCATION = /^\s*P?(\d+)(?:\s*\/\s*S?(\d+))?\s*$/i;

interface TestRailCase {
    id: number;
    title?: string;
    section_id?: number;
    priority_id?: number;
    refs?: string | null;
    labels?: Array<{ title?: string; name?: string }>;
    custom_preconds?: string | null;
    custom_steps?: string | null;
    custom_expected?: string | null;
    custom_steps_separated?: Array<{ content?: string | null; expected?: string | null; additional_info?: string | null }> | null;
    custom_description?: string | null;
    custom_mission?: string | null;
    custom_goals?: string | null;
}

interface Paged {
    _links?: { next?: string | null };
    [list: string]: unknown;
}

/** Reads every page of a TestRail list call, following _links.next only when it points back at the same API method. */
async function pagesOf<T>(api: Remote, root: string, first: string, listKey: string, limit: number, maxPages: number): Promise<{ items: T[]; more: boolean; raw: unknown[] }> {
    const method = first.split('/')[0];
    const items: T[] = [];
    const raw: unknown[] = [];
    let path: string | undefined = first;
    for (let page = 0; path && page < maxPages; page++) {
        const res: Paged | T[] = await api.json<Paged | T[]>(`${root}/index.php?/api/v2/${path}`);
        raw.push(res);
        if (Array.isArray(res)) return { items: res.slice(0, limit), more: res.length > limit, raw };
        items.push(...((res?.[listKey] as T[]) ?? []));
        const next: string | null | undefined = res?._links?.next;
        path = typeof next === 'string' && next.startsWith(`/api/v2/${method}/`) ? next.slice('/api/v2/'.length) : undefined;
        if (items.length >= limit) return { items: items.slice(0, limit), more: Boolean(path) || items.length > limit, raw };
    }
    return { items, more: Boolean(path), raw };
}

/** Untrusted names that end up in an error message are cleaned and shortened. */
const safeName = (value: unknown) => {
    const c = clean(value);
    return c.suspicious ? '' : c.text.slice(0, 60);
};

export const importTestRail: Importer = async request => {
    const env = needEnv(request, 'TestRail', ['TESTRAIL_URL', 'TESTRAIL_USER', 'TESTRAIL_API_KEY']);
    const where = request.location.match(LOCATION);
    if (!where) throw new RemoteImportError('For TestRail, location is the numeric project id (e.g. 3), or project and suite: 3/12. The ids are in the TestRail URLs (projects/overview/3, suites/view/12).');
    const [, projectId, suiteId] = where;
    const root = trimSlash(env.TESTRAIL_URL);
    const api = new Remote(request, {
        service: 'TestRail',
        headers: { Authorization: basicAuth(env.TESTRAIL_USER, env.TESTRAIL_API_KEY), 'Content-Type': 'application/json' },
        secretKeys: ['TESTRAIL_API_KEY'],
        credentialKeys: ['TESTRAIL_USER', 'TESTRAIL_API_KEY'],
        authHint: 'The API must also be enabled under Administration → Site Settings → API.'
    });
    const suite = suiteId ? `&suite_id=${suiteId}` : '';
    const ref = `TestRail project ${projectId}${suiteId ? ` suite ${suiteId}` : ''}`;
    const warnings: ImportWarning[] = [];

    let listed;
    try {
        listed = await pagesOf<TestRailCase>(api, root, `get_cases/${projectId}${suite}&limit=${Math.min(PAGE_SIZE, request.limit)}`, 'cases', request.limit, 1000);
    } catch (error) {
        if (error instanceof RemoteImportError && error.status === 400 && !suiteId && /suite_id/i.test(error.message)) {
            const suites = await api.json<Array<{ id: number; name?: string }>>(`${root}/index.php?/api/v2/get_suites/${projectId}`).catch(() => []);
            const list = (Array.isArray(suites) ? suites : []).slice(0, 20).map(s => `${s.id}${safeName(s.name) ? ` (${safeName(s.name)})` : ''}`);
            throw new RemoteImportError(`TestRail project ${projectId} has several suites; say which one with location "${projectId}/<suiteId>".${list.length ? ` Suites: ${list.join(', ')}.` : ''}`, 400);
        }
        throw error;
    }
    const cases = listed.items.filter(c => typeof c?.id === 'number');
    if (!cases.length) throw new RemoteImportError(`No test cases in ${ref}.`);

    // Section paths and priority names are nice to have; the import goes on without them.
    const sectionPath = new Map<number, string>();
    try {
        const sections = await pagesOf<{ id: number; name?: string; parent_id?: number | null }>(api, root, `get_sections/${projectId}${suite}`, 'sections', 10_000, 100);
        const byId = new Map(sections.items.map(s => [s.id, s]));
        for (const s of sections.items) {
            const names: string[] = [];
            const seen = new Set<number>();
            for (let cur: typeof s | undefined = s; cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
                seen.add(cur.id);
                if (cur.name) names.unshift(cur.name);
            }
            sectionPath.set(s.id, names.join('/'));
        }
    } catch (error) {
        if (!(error instanceof RemoteImportError) || error.status === 401) throw error;
        warnings.push({ ref, message: 'Could not read section names, so cases have no area.' });
    }
    const priorityName = new Map<number, string>();
    try {
        const priorities = await api.json<Array<{ id: number; name?: string; short_name?: string }>>(`${root}/index.php?/api/v2/get_priorities`);
        for (const p of Array.isArray(priorities) ? priorities : []) if (p.name || p.short_name) priorityName.set(p.id, (p.name ?? p.short_name)!);
    } catch (error) {
        if (!(error instanceof RemoteImportError) || error.status === 401) throw error;
        warnings.push({ ref, message: 'Could not read priority names, so cases have no priority.' });
    }

    const drafts: Draft[] = cases.map(c => {
        const id = `C${c.id}`;
        const draft: Draft = {
            id,
            title: c.title,
            description: [c.custom_description, c.custom_mission, c.custom_goals].filter(v => typeof v === 'string' && v.trim()).join('\n\n') || undefined,
            preconditions: splitNumbered(c.custom_preconds ?? ''),
            steps: [],
            priority: c.priority_id !== undefined ? priorityName.get(c.priority_id) : undefined,
            area: c.section_id !== undefined ? sectionPath.get(c.section_id) : undefined,
            tags: [...(c.refs ?? '').split(/[,;]/).map(r => r.trim()), ...(c.labels ?? []).map(l => l.title ?? l.name ?? '')].filter(Boolean),
            sourceRef: id
        };
        const separated = Array.isArray(c.custom_steps_separated) ? c.custom_steps_separated : [];
        if (separated.length) {
            draft.steps = separated.map(s => ({ action: s.content ?? '', data: s.additional_info?.trim() || undefined, expected: s.expected?.trim() || undefined }));
            if (c.custom_expected?.trim()) draft.expected = c.custom_expected;
        } else if (c.custom_steps?.trim() || c.custom_expected?.trim()) {
            const { steps, overall } = pairSteps(c.custom_steps ?? '', c.custom_expected ?? '');
            draft.steps = steps;
            draft.expected = overall;
        }
        return draft;
    });
    const bare = drafts.filter(d => !d.steps.length && !d.expected).map(d => d.id!);
    if (bare.length) warnings.push({ ref, message: `${bare.length} case(s) have no steps or expected result (${bare.slice(0, 10).join(', ')}${bare.length > 10 ? ', …' : ''}).` });
    if (listed.more) warnings.push(moreAtSource(ref, request.limit));
    return {
        drafts,
        warnings,
        ref,
        raw: api.raw(`testrail-${projectId}${suiteId ? `-${suiteId}` : ''}.json`, { source: 'testrail', projectId, suiteId: suiteId ?? null, pages: listed.raw }),
        linkFor: id => `${root}/index.php?/cases/view/${id.replace(/^C/i, '').replace(/-\d+$/, '')}`,
        idPrefix: 'C'
    };
};
