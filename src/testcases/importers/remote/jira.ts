import { basicAuth, trimSlash } from '../../../integrations/http.js';
import type { Draft, ImportWarning } from '../../normalize.js';
import type { Importer, ImportRequest } from '../types.js';
import { adfToText } from './adf.js';
import { moreAtSource, needEnv, Remote, RemoteImportError, structureText } from './common.js';

/**
 * Jira Cloud (REST v3). One issue becomes one test case: the summary is the title and
 * steps come from the description (ADF): a step table, labelled sections or a numbered list.
 * Search uses the enhanced JQL endpoint (/rest/api/3/search/jql, nextPageToken paging);
 * the old /rest/api/3/search was removed. Auth: Basic with JIRA_EMAIL + JIRA_API_TOKEN.
 */

const KEY_LIST = /^\s*[A-Z][A-Z0-9_]*-\d+(?:\s*[,;\s]\s*[A-Z][A-Z0-9_]*-\d+)*\s*$/i;
const PROJECT_KEY = /^\s*[A-Z][A-Z0-9_]*\s*$/i;
const FIELDS = ['summary', 'description', 'priority', 'labels', 'components', 'issuetype'];
const PAGE_SIZE = 100;

export interface JiraQuery {
    jql: string;
    /** Used when jql fails, e.g. the project has no "Test" issue type. */
    fallbackJql?: string;
    ref: string;
    projectKey?: string;
}

/** Turns the location into JQL: issue keys, a bare project key (its Test issues), or JQL as written. */
export function jiraQuery(location: string, testIssueType = 'Test'): JiraQuery {
    const loc = location.trim();
    if (KEY_LIST.test(loc)) {
        const keys = [...new Set(loc.split(/[\s,;]+/).filter(Boolean).map(k => k.toUpperCase()))];
        return { jql: `key in (${keys.join(', ')}) ORDER BY key ASC`, ref: `Jira ${keys.length > 5 ? `${keys.slice(0, 5).join(', ')} …` : keys.join(', ')}`, projectKey: keys[0].split('-')[0] };
    }
    if (PROJECT_KEY.test(loc)) {
        const key = loc.toUpperCase();
        return { jql: `project = "${key}" AND issuetype = "${testIssueType}" ORDER BY key ASC`, fallbackJql: `project = "${key}" ORDER BY key ASC`, ref: `Jira project ${key}`, projectKey: key };
    }
    return { jql: loc, ref: `Jira JQL ${loc.length > 80 ? `${loc.slice(0, 80)} …` : loc}`, projectKey: loc.match(/\bproject\s*(?:=|in\s*\()\s*"?([A-Z][A-Z0-9_]*)/i)?.[1]?.toUpperCase() };
}

export interface JiraIssue {
    id: string;
    key: string;
    fields?: {
        summary?: string;
        description?: unknown;
        priority?: { name?: string } | null;
        labels?: string[];
        components?: Array<{ name?: string }>;
        issuetype?: { name?: string };
    };
}

interface SearchPage {
    issues?: JiraIssue[];
    nextPageToken?: string;
    isLast?: boolean;
}

export function jiraRemote(request: ImportRequest): { api: Remote; base: string } {
    const env = needEnv(request, 'Jira', ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']);
    const api = new Remote(request, {
        service: 'Jira',
        headers: { Authorization: basicAuth(env.JIRA_EMAIL, env.JIRA_API_TOKEN), Accept: 'application/json' },
        secretKeys: ['JIRA_API_TOKEN'],
        credentialKeys: ['JIRA_EMAIL', 'JIRA_API_TOKEN'],
        authHint: 'Jira API tokens expire within 365 days; create a new one if it has expired.'
    });
    return { api, base: trimSlash(env.JIRA_BASE_URL) };
}

/** Pages through a JQL search until `limit` issues; `more` says whether the search had more. */
export async function jiraSearch(api: Remote, base: string, jql: string, fields: string[], limit: number): Promise<{ issues: JiraIssue[]; pages: SearchPage[]; more: boolean }> {
    const issues: JiraIssue[] = [];
    const pages: SearchPage[] = [];
    let token: string | undefined;
    // A hard stop in case a server keeps handing out tokens.
    for (let page = 0; page < 1000; page++) {
        const body = { jql, fields, maxResults: Math.min(PAGE_SIZE, limit - issues.length), ...(token ? { nextPageToken: token } : {}) };
        const res = await api.json<SearchPage>(`${base}/rest/api/3/search/jql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        pages.push(res ?? {});
        const got = res?.issues ?? [];
        issues.push(...got);
        token = res?.isLast ? undefined : res?.nextPageToken;
        if (issues.length >= limit) return { issues: issues.slice(0, limit), pages, more: Boolean(token) || issues.length > limit };
        if (!token || !got.length) break;
    }
    return { issues, pages, more: false };
}

/** A browse link, unless the base URL is the scoped-token API gateway (api.atlassian.com), which has no browse pages. */
export function jiraBrowse(base: string | undefined): ((id: string) => string | undefined) | undefined {
    if (!base || /\/\/api\.atlassian\.com\b/i.test(base)) return undefined;
    const root = trimSlash(base);
    return id => `${root}/browse/${encodeURIComponent(id)}`;
}

function issueDraft(issue: JiraIssue): Draft {
    const f = issue.fields ?? {};
    const { text, tables } = adfToText(f.description);
    const s = structureText(text, tables, issue.key);
    return {
        id: issue.key,
        title: f.summary,
        description: s.description,
        preconditions: s.preconditions,
        steps: s.steps,
        expected: s.expected,
        testData: s.testData,
        priority: f.priority?.name,
        area: f.components?.find(c => c.name)?.name,
        tags: (f.labels ?? []).filter(l => typeof l === 'string'),
        sourceRef: issue.key
    };
}

export const importJira: Importer = async request => {
    const { api, base } = jiraRemote(request);
    const query = jiraQuery(request.location);
    const warnings: ImportWarning[] = [];
    let jql = query.jql;
    let found;
    try {
        found = await jiraSearch(api, base, jql, FIELDS, request.limit);
    } catch (error) {
        if (!(error instanceof RemoteImportError && error.status === 400 && query.fallbackJql)) throw error;
        jql = query.fallbackJql;
        found = await jiraSearch(api, base, jql, FIELDS, request.limit);
        warnings.push({ ref: query.ref, message: `Project ${query.projectKey} has no "Test" issue type, so every issue in it was read. Give a JQL query to narrow it, e.g. project = ${query.projectKey} AND labels = regression.` });
    }
    if (!found.issues.length) throw new RemoteImportError(`No issues match ${query.ref} (JQL: ${jql}). Check the project key or JQL in Jira's issue search first.`);
    const drafts = found.issues.map(issueDraft);
    const bare = drafts.filter(d => !d.steps.length && !d.expected).map(d => d.id!);
    if (bare.length) warnings.push({ ref: query.ref, message: `No steps found in the description of ${bare.length} issue(s) (${bare.slice(0, 10).join(', ')}${bare.length > 10 ? ', …' : ''}). Steps are read from a table with a Steps column, a "Steps:" section or a numbered list.` });
    if (found.more) warnings.push(moreAtSource(query.ref, request.limit));
    return {
        drafts,
        warnings,
        ref: query.ref,
        raw: api.raw(`jira-${query.projectKey ?? 'search'}.json`, { source: 'jira', jql, pages: found.pages }),
        linkFor: jiraBrowse(base),
        idPrefix: query.projectKey ?? 'JIRA'
    };
};
