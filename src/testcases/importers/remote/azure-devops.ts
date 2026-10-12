import type { TestStep } from '../../../core/schema.js';
import { basicAuth, trimSlash } from '../../../integrations/http.js';
import type { Draft, ImportWarning } from '../../normalize.js';
import type { Importer } from '../types.js';
import { decode } from '../word.js';
import { asText, htmlToText, moreAtSource, needEnv, Remote, RemoteImportError } from './common.js';

/**
 * Azure DevOps Test Plans (api-version 7.1). Lists the test cases of a suite
 * (GET _apis/testplan/Plans/{plan}/Suites/{suite}/TestCase, continuation token in the
 * x-ms-continuationtoken header), then reads the work items 200 at a time
 * (GET _apis/wit/workitems?ids=…&fields=…). Steps live in Microsoft.VSTS.TCM.Steps as XML whose
 * two parameterizedString elements per step hold HTML-escaped action and expected result;
 * shared steps (<compref ref="id">) are read from their own work items. Ids stay the numeric
 * work item id so result sync matches them. Auth: Basic with an empty user and AZDO_PAT.
 */

const BATCH = 200;
const LOCATION = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;
const FIELDS = ['System.Id', 'System.Title', 'System.Description', 'System.AreaPath', 'System.Tags', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.TCM.Steps', 'Microsoft.VSTS.TCM.Parameters'];
const SHARED_FIELDS = ['System.Id', 'System.Title', 'Microsoft.VSTS.TCM.Steps'];

interface WorkItem {
    id: number;
    fields?: Record<string, unknown>;
}

type StepItem = TestStep | { shared: number };

/** Parses the Steps XML into steps and shared-step references, in order. */
export function parseStepsXml(xml: string | undefined): StepItem[] {
    const out: StepItem[] = [];
    if (!xml) return out;
    const token = /<(\/?)(step|compref)\b([^>]*?)(\/?)>|<parameterizedString\b[^>]*?(?:\/>|>([\s\S]*?)<\/parameterizedString>)/gi;
    let current: string[] | undefined;
    let m: RegExpExecArray | null;
    const emit = () => {
        if (!current) return;
        const [action = '', expected = ''] = current.map(s => htmlToText(decode(s)).text);
        if (action || expected) out.push({ action, expected: expected || undefined });
        current = undefined;
    };
    while ((m = token.exec(xml))) {
        const [, closing, tag, attrs, selfClosing, content] = m;
        if (!tag) {
            current?.push(content ?? '');
            continue;
        }
        if (tag.toLowerCase() === 'step') {
            if (closing) emit();
            else {
                emit();
                current = [];
                if (selfClosing) emit();
            }
            continue;
        }
        if (!closing) {
            emit();
            const ref = Number(attrs.match(/\bref\s*=\s*"(\d+)"/)?.[1]);
            if (Number.isFinite(ref) && ref > 0) out.push({ shared: ref });
        }
    }
    emit();
    return out;
}

const fieldText = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export const importAzureDevOps: Importer = async request => {
    const env = needEnv(request, 'Azure DevOps', ['AZDO_ORG_URL', 'AZDO_PROJECT', 'AZDO_PAT']);
    const where = request.location.match(LOCATION);
    if (!where) throw new RemoteImportError('For Azure DevOps, location is planId/suiteId (both numbers, from the Test Plans URL: ?planId=12&suiteId=34 → 12/34).');
    const [, planId, suiteId] = where;
    const org = trimSlash(env.AZDO_ORG_URL);
    const projectBase = `${org}/${encodeURIComponent(env.AZDO_PROJECT)}`;
    const api = new Remote(request, {
        service: 'Azure DevOps',
        headers: { Authorization: basicAuth('', env.AZDO_PAT), Accept: 'application/json' },
        secretKeys: ['AZDO_PAT'],
        credentialKeys: ['AZDO_PAT'],
        authHint: 'The token needs Test Management (read) and Work Items (read) scopes; global PATs stop working on 1 Dec 2026, so use an organisation-scoped one.'
    });
    const ref = `Azure DevOps plan ${planId} suite ${suiteId}`;
    const warnings: ImportWarning[] = [];

    const ids: number[] = [];
    const listPages: unknown[] = [];
    let continuation: string | undefined;
    let more = false;
    for (let n = 0; n < 500; n++) {
        const url = `${projectBase}/_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase?${continuation ? `continuationToken=${encodeURIComponent(continuation)}&` : ''}api-version=7.1`;
        const { data, headers } = await api.call<{ value?: Array<{ workItem?: { id?: number } }> } | Array<{ workItem?: { id?: number } }>>(url);
        listPages.push(data);
        const value = Array.isArray(data) ? data : (data?.value ?? []);
        for (const tc of value) if (typeof tc?.workItem?.id === 'number' && !ids.includes(tc.workItem.id)) ids.push(tc.workItem.id);
        continuation = headers.get('x-ms-continuationtoken') ?? undefined;
        if (ids.length >= request.limit) {
            more = Boolean(continuation) || ids.length > request.limit;
            break;
        }
        if (!continuation || !value.length) break;
    }
    const wanted = ids.slice(0, request.limit);
    if (!wanted.length) throw new RemoteImportError(`No test cases in ${ref}. Check the plan and suite ids and AZDO_PROJECT.`);

    const readItems = async (list: number[], fields: string[]) => {
        const items: WorkItem[] = [];
        for (let i = 0; i < list.length; i += BATCH) {
            const res = await api.json<{ value?: Array<WorkItem | null> }>(`${projectBase}/_apis/wit/workitems?ids=${list.slice(i, i + BATCH).join(',')}&fields=${fields.join(',')}&errorPolicy=omit&api-version=7.1`);
            items.push(...(res?.value ?? []).filter((w): w is WorkItem => Boolean(w && typeof w.id === 'number')));
        }
        return items;
    };
    const items = await readItems(wanted, FIELDS);
    const stepsOf = new Map(items.map(w => [w.id, parseStepsXml(fieldText(w.fields?.['Microsoft.VSTS.TCM.Steps']))]));

    // Shared steps are separate work items; read them once and put their steps in place.
    const sharedIds = [...new Set([...stepsOf.values()].flat().flatMap(s => ('shared' in s ? [s.shared] : [])))];
    const shared = new Map<number, TestStep[]>();
    let sharedItems: WorkItem[] = [];
    if (sharedIds.length) {
        try {
            sharedItems = await readItems(sharedIds, SHARED_FIELDS);
            for (const w of sharedItems) shared.set(w.id, parseStepsXml(fieldText(w.fields?.['Microsoft.VSTS.TCM.Steps'])).filter((s): s is TestStep => !('shared' in s)));
        } catch (error) {
            if (!(error instanceof RemoteImportError) || error.status === 401) throw error;
            warnings.push({ ref, message: 'Could not read shared steps; they are listed by id instead.' });
        }
    }

    const byId = new Map(items.map(w => [w.id, w]));
    const missing = wanted.filter(id => !byId.has(id));
    if (missing.length) warnings.push({ ref, message: `Could not read work item(s) ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''} (deleted or no access); skipped.` });
    const drafts: Draft[] = wanted
        .filter(id => byId.has(id))
        .map(id => {
            const f = byId.get(id)!.fields ?? {};
            const steps = (stepsOf.get(id) ?? []).flatMap(s => ('shared' in s ? (shared.get(s.shared) ?? [{ action: `Shared steps ${s.shared}` }]) : [s]));
            const area = fieldText(f['System.AreaPath'])
                .split('\\')
                .slice(1)
                .join('/');
            const params = [...fieldText(f['Microsoft.VSTS.TCM.Parameters']).matchAll(/<param\b[^>]*\bname\s*=\s*"([^"]+)"/gi)].map(p => `@${decode(p[1])}`);
            return {
                id: String(id),
                title: fieldText(f['System.Title']),
                description: asText(htmlToText(fieldText(f['System.Description']))),
                preconditions: [],
                steps,
                testData: params.length ? `Parameters: ${params.join(', ')}` : undefined,
                priority: fieldText(f['Microsoft.VSTS.Common.Priority']) || undefined,
                area: area || undefined,
                tags: fieldText(f['System.Tags'])
                    .split(';')
                    .map(t => t.trim())
                    .filter(Boolean),
                sourceRef: `work item ${id}`
            };
        });
    const bare = drafts.filter(d => !d.steps.length).map(d => d.id!);
    if (bare.length) warnings.push({ ref, message: `${bare.length} test case(s) have no steps (${bare.slice(0, 10).join(', ')}${bare.length > 10 ? ', …' : ''}).` });
    if (more) warnings.push(moreAtSource(ref, request.limit));
    return {
        drafts,
        warnings,
        ref,
        raw: api.raw(`azure-devops-${planId}-${suiteId}.json`, { source: 'azure-devops', planId, suiteId, testCases: listPages, workItems: items, sharedSteps: sharedItems }),
        linkFor: id => `${projectBase}/_workitems/edit/${encodeURIComponent(id.replace(/-\d+$/, ''))}`,
        idPrefix: 'AZ'
    };
};
