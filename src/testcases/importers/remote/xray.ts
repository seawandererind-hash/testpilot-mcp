import { trimSlash } from '../../../integrations/http.js';
import type { Draft, ImportWarning } from '../../normalize.js';
import { scenarioBodySteps } from '../gherkin.js';
import type { Importer } from '../types.js';
import { adfToText } from './adf.js';
import { asText, moreAtSource, needEnv, Remote, RemoteImportError, structureText, wikiToText } from './common.js';
import { jiraBrowse, jiraQuery, jiraRemote, jiraSearch } from './jira.js';

/**
 * Xray Cloud. Authenticates with XRAY_CLIENT_ID / XRAY_CLIENT_SECRET at /api/v2/authenticate
 * (the token comes back as a JSON string), then reads Tests through GraphQL getTests:
 * steps (action, data, result), Gherkin or unstructured definitions, preconditions, folder and
 * the Jira fields. getTests pages with limit (max 100) and start, but Xray refuses a JQL that
 * matches more than 100 issues; then, when Jira credentials are in .env, TestPilot finds the
 * issue ids with Jira's search and asks Xray for them 100 at a time.
 */

const DEFAULT_BASE = 'https://xray.cloud.getxray.app';
const PAGE_SIZE = 100;

const GET_TESTS = `query TestPilotImport($jql: String, $issueIds: [String], $limit: Int!, $start: Int) {
  getTests(jql: $jql, issueIds: $issueIds, limit: $limit, start: $start) {
    total
    start
    limit
    results {
      issueId
      testType { name kind }
      steps { action data result callTestIssueId }
      gherkin
      scenarioType
      unstructured
      folder { name path }
      preconditions(limit: 10) { total results { issueId definition jira(fields: ["key", "summary"]) } }
      jira(fields: ["key", "summary", "description", "labels", "priority", "components"])
    }
  }
}`;

interface XrayTest {
    issueId?: string;
    testType?: { name?: string; kind?: string };
    steps?: Array<{ action?: string; data?: string; result?: string; callTestIssueId?: string | null }>;
    gherkin?: string | null;
    scenarioType?: string | null;
    unstructured?: string | null;
    folder?: { name?: string; path?: string } | null;
    preconditions?: { total?: number; results?: Array<{ issueId?: string; definition?: string | null; jira?: { key?: string; summary?: string } }> } | null;
    jira?: { key?: string; summary?: string; description?: unknown; labels?: string[]; priority?: { name?: string } | null; components?: Array<{ name?: string }> };
}

interface TestsPage {
    getTests?: { total?: number; start?: number; limit?: number; results?: XrayTest[] };
}

class TooManyForJql extends Error {}

function testDraft(test: XrayTest): Draft {
    const jira = test.jira ?? {};
    const id = jira.key ?? test.issueId;
    const description = adfToText(jira.description);
    const kind = (test.testType?.kind ?? '').toLowerCase();
    const draft: Draft = {
        id,
        title: jira.summary,
        preconditions: (test.preconditions?.results ?? []).map(p => (p.definition?.trim() ? p.definition : p.jira?.summary) ?? '').filter(Boolean),
        steps: [],
        priority: jira.priority?.name ?? undefined,
        area: test.folder?.path?.replace(/^\/+/, '') || jira.components?.find(c => c.name)?.name,
        tags: (jira.labels ?? []).filter(l => typeof l === 'string'),
        sourceRef: id
    };
    if (kind === 'gherkin' && test.gherkin?.trim()) {
        const g = scenarioBodySteps(test.gherkin, test.scenarioType === 'scenario_outline');
        draft.steps = g.steps;
        draft.preconditions.push(...g.preconditions);
        draft.expected = g.expected;
        draft.testData = g.examples;
        draft.description = asText(description);
        draft.tags.push('gherkin');
        return draft;
    }
    if (test.steps?.length) {
        draft.steps = test.steps.map(s => ({
            action: s.action?.trim() || (s.callTestIssueId ? `Run the steps of test ${s.callTestIssueId}` : ''),
            data: s.data?.trim() || undefined,
            expected: s.result?.trim() || undefined
        }));
        draft.description = asText(description);
        return draft;
    }
    // Unstructured (generic) tests, or step tests with no steps yet: read the definition, then the description.
    const definition = wikiToText(test.unstructured);
    const s = structureText(definition.text || description.text, definition.text ? definition.tables : description.tables, id ?? 'test');
    draft.steps = s.steps;
    draft.expected = s.expected;
    draft.testData = s.testData;
    draft.preconditions.push(...s.preconditions);
    draft.description = definition.text ? [asText(description), s.description].filter(Boolean).join('\n\n') || undefined : s.description;
    return draft;
}

export const importXray: Importer = async request => {
    const env = needEnv(request, 'Xray', ['XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET']);
    const base = trimSlash(env.XRAY_BASE_URL || DEFAULT_BASE);
    const api = new Remote(request, {
        service: 'Xray',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        secretKeys: ['XRAY_CLIENT_SECRET', 'XRAY_CLIENT_ID'],
        credentialKeys: ['XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET'],
        authHint: 'Create a new API key under Jira → Apps → Xray → API Keys if it was revoked.'
    });
    const token = await api.json<string>(`${base}/api/v2/authenticate`, { method: 'POST', body: JSON.stringify({ client_id: env.XRAY_CLIENT_ID, client_secret: env.XRAY_CLIENT_SECRET }) });
    const bearer = String(token ?? '').replace(/^"|"$/g, '').trim();
    if (!bearer) throw new RemoteImportError('Xray did not return a token. Check XRAY_CLIENT_ID and XRAY_CLIENT_SECRET in .env.');
    api.addSecret(bearer);
    api.setHeader('Authorization', `Bearer ${bearer}`);

    const query = jiraQuery(request.location);
    // getTests only returns Test issues, so a project key needs no issue-type filter.
    const jql = query.fallbackJql ?? query.jql;
    const ref = query.ref.replace(/^Jira/, 'Xray');
    const pages: TestsPage[] = [];
    const warnings: ImportWarning[] = [];

    const getTests = async (variables: { jql?: string; issueIds?: string[]; limit: number; start: number }) => {
        const res = await api.json<{ data?: TestsPage; errors?: Array<{ message?: string }> }>(`${base}/api/v2/graphql`, { method: 'POST', body: JSON.stringify({ query: GET_TESTS, variables }) });
        if (res?.errors?.length) {
            const messages = res.errors.map(e => e.message ?? '').join('; ');
            if (/refine|more than \d+|too many/i.test(messages)) throw new TooManyForJql(messages);
            throw api.error(`Xray could not run the search: ${messages.slice(0, 300)}`);
        }
        const page = res?.data ?? {};
        pages.push(page);
        return page.getTests ?? {};
    };

    const tests: XrayTest[] = [];
    let more = false;
    try {
        let start = 0;
        while (tests.length < request.limit) {
            const page = await getTests({ jql, limit: Math.min(PAGE_SIZE, request.limit - tests.length), start });
            const results = page.results ?? [];
            tests.push(...results);
            start += results.length;
            more = start < (page.total ?? 0);
            if (!results.length || !more) break;
        }
    } catch (error) {
        if (!(error instanceof TooManyForJql)) throw error;
        if (!env.JIRA_BASE_URL || !env.JIRA_EMAIL || !env.JIRA_API_TOKEN) {
            throw new RemoteImportError(
                `Xray accepts at most 100 tests per JQL search and ${ref} matches more. Narrow the JQL (for example add AND labels = smoke), or fill in JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env so TestPilot can page through the Test issues in Jira.`
            );
        }
        tests.length = 0;
        const jira = jiraRemote(request);
        const idsJql = query.fallbackJql ? query.jql : jql;
        const found = await jiraSearch(jira.api, jira.base, idsJql, ['key'], request.limit);
        more = found.more;
        const ids = found.issues.map(i => String(i.id));
        for (let i = 0; i < ids.length; i += PAGE_SIZE) {
            const page = await getTests({ issueIds: ids.slice(i, i + PAGE_SIZE), limit: PAGE_SIZE, start: 0 });
            tests.push(...(page.results ?? []));
        }
        warnings.push({ ref, message: 'The JQL matched more than 100 tests, so the Test issues were found through Jira search and read from Xray 100 at a time.' });
    }
    if (!tests.length) throw new RemoteImportError(`No Xray tests match ${ref} (JQL: ${jql}). Check the project key or JQL in Jira first.`);
    const drafts = tests.slice(0, request.limit).map(testDraft);
    const bare = drafts.filter(d => !d.steps.length && !d.expected).map(d => d.id!);
    if (bare.length) warnings.push({ ref, message: `${bare.length} test(s) have no steps or definition yet (${bare.slice(0, 10).join(', ')}${bare.length > 10 ? ', …' : ''}).` });
    if (more) warnings.push(moreAtSource(ref, request.limit));
    return {
        drafts,
        warnings,
        ref,
        raw: api.raw(`xray-${query.projectKey ?? 'search'}.json`, { source: 'xray', jql, pages }),
        linkFor: jiraBrowse(env.JIRA_BASE_URL),
        idPrefix: query.projectKey ?? 'XRAY'
    };
};
