import { junitFromRun } from '../report/report.js';
import type { RunSummary } from '../run/playwright.js';
import { basicAuth, type Fetch, IntegrationError, request, requireEnv, trimSlash } from './http.js';

/**
 * Sends a run's results to the team's test-management tool. Every target is matched by
 * the test-case id TestPilot put on each test (title prefix and test_key annotation).
 */

export const SYNC_TARGETS = ['xray', 'zephyr', 'testrail', 'browserstack', 'azure-devops'] as const;
export type SyncTarget = (typeof SYNC_TARGETS)[number];

export interface SyncOptions {
    projectKey?: string;
    projectId?: string;
    suiteId?: string;
    planId?: string;
    runName: string;
}

export interface SyncOutcome {
    target: SyncTarget;
    sent: number;
    skipped: string[];
    reference?: string;
    link?: string;
    note?: string;
}

/** Which results a sync would send, and why others are left out. */
export function syncPreview(target: SyncTarget, run: RunSummary, options: SyncOptions): { send: RunSummary['tests']; skipped: string[]; needs: string[] } {
    const ran = run.tests.filter(t => t.status !== 'skipped');
    const skipped: string[] = [];
    let send = ran;
    if (target === 'testrail') {
        send = ran.filter(t => /^C?\d+$/i.test(t.id));
        skipped.push(...ran.filter(t => !send.includes(t)).map(t => `${t.id} (TestRail needs case ids like C123)`));
    }
    if (target === 'azure-devops') {
        send = ran.filter(t => /^\D*\d+$/.test(t.id));
        skipped.push(...ran.filter(t => !send.includes(t)).map(t => `${t.id} (needs the Azure DevOps test case id)`));
    }
    const needs: string[] = [];
    if ((target === 'xray' || target === 'zephyr') && !options.projectKey) needs.push('projectKey (the Jira project key, e.g. SHOP)');
    if (target === 'testrail' && !options.projectId) needs.push('projectId (TESTRAIL_PROJECT_ID)');
    if (target === 'browserstack' && !options.projectId) needs.push('projectId (the BrowserStack Test Management project name or id)');
    if (target === 'azure-devops' && (!options.planId || !options.suiteId)) needs.push('planId and suiteId (Azure Test Plans)');
    return { send, skipped, needs };
}

export async function syncResults(target: SyncTarget, run: RunSummary, options: SyncOptions, env: Record<string, string>, doFetch: Fetch = fetch): Promise<SyncOutcome> {
    const { send, skipped, needs } = syncPreview(target, run, options);
    if (needs.length) throw new IntegrationError(`Missing: ${needs.join(', ')}.`);
    if (!send.length) throw new IntegrationError('No results to send: none of the tests in the last run match this tool\'s test-case ids.');
    const filtered: RunSummary = { ...run, tests: send };
    switch (target) {
        case 'xray':
            return { ...(await xray(filtered, options, env, doFetch)), skipped };
        case 'zephyr':
            return { ...(await zephyr(filtered, options, env, doFetch)), skipped };
        case 'testrail':
            return { ...(await testrail(filtered, options, env, doFetch)), skipped };
        case 'browserstack':
            return { ...(await browserstack(filtered, options, env, doFetch)), skipped };
        case 'azure-devops':
            return { ...(await azureDevOps(filtered, options, env, doFetch)), skipped };
    }
}

async function xray(run: RunSummary, options: SyncOptions, env: Record<string, string>, doFetch: Fetch): Promise<Omit<SyncOutcome, 'skipped'>> {
    requireEnv(env, ['XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET']);
    const base = trimSlash(env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app');
    const token = await request<string>('Xray', doFetch, `${base}/api/v2/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.XRAY_CLIENT_ID, client_secret: env.XRAY_CLIENT_SECRET })
    });
    const created = await request<{ key?: string; id?: string }>('Xray', doFetch, `${base}/api/v2/import/execution/junit?projectKey=${encodeURIComponent(options.projectKey!)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${String(token).replace(/^"|"$/g, '')}`, 'Content-Type': 'text/xml' },
        body: junitFromRun(run)
    });
    const key = created?.key;
    return { target: 'xray', sent: run.tests.length, reference: key, link: key && env.JIRA_BASE_URL ? `${trimSlash(env.JIRA_BASE_URL)}/browse/${key}` : undefined, note: key ? `Created Test Execution ${key}.` : undefined };
}

async function zephyr(run: RunSummary, options: SyncOptions, env: Record<string, string>, doFetch: Fetch): Promise<Omit<SyncOutcome, 'skipped'>> {
    requireEnv(env, ['ZEPHYR_API_TOKEN']);
    const base = trimSlash(env.ZEPHYR_BASE_URL || 'https://api.zephyrscale.smartbear.com/v2');
    const form = new FormData();
    form.append('file', new Blob([junitFromRun(run)], { type: 'application/xml' }), 'junit.xml');
    form.append('testCycle', new Blob([JSON.stringify({ name: options.runName })], { type: 'application/json' }));
    const created = await request<{ testCycle?: { key?: string } }>('Zephyr', doFetch, `${base}/automations/executions/junit?projectKey=${encodeURIComponent(options.projectKey!)}&autoCreateTestCases=false`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.ZEPHYR_API_TOKEN}` },
        body: form
    });
    return { target: 'zephyr', sent: run.tests.length, reference: created?.testCycle?.key, note: 'Zephyr matches results to test cases whose key appears in the test name.' };
}

async function testrail(run: RunSummary, options: SyncOptions, env: Record<string, string>, doFetch: Fetch): Promise<Omit<SyncOutcome, 'skipped'>> {
    requireEnv(env, ['TESTRAIL_URL', 'TESTRAIL_USER', 'TESTRAIL_API_KEY']);
    const base = `${trimSlash(env.TESTRAIL_URL)}/index.php?/api/v2`;
    const headers = { Authorization: basicAuth(env.TESTRAIL_USER, env.TESTRAIL_API_KEY), 'Content-Type': 'application/json' };
    const caseIds = run.tests.map(t => Number(t.id.replace(/^C/i, '')));
    const created = await request<{ id: number; url?: string }>('TestRail', doFetch, `${base}/add_run/${encodeURIComponent(options.projectId!)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: options.runName, include_all: false, case_ids: caseIds, ...(options.suiteId ? { suite_id: Number(options.suiteId) } : {}) })
    });
    await request('TestRail', doFetch, `${base}/add_results_for_cases/${created.id}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            results: run.tests.map(t => ({
                case_id: Number(t.id.replace(/^C/i, '')),
                status_id: t.status === 'passed' ? 1 : t.status === 'flaky' ? 4 : 5,
                comment: t.status === 'passed' ? 'Passed (TestPilot)' : `${t.status === 'flaky' ? `Flaky: passed ${t.passes} of ${t.runs}` : 'Failed'} (TestPilot)\n${t.category ? `Likely cause: ${t.category}\n` : ''}${(t.error ?? '').slice(0, 1500)}`,
                elapsed: `${Math.max(1, Math.round(t.durationMs / 1000))}s`
            }))
        })
    });
    return { target: 'testrail', sent: run.tests.length, reference: `R${created.id}`, link: created.url ?? `${trimSlash(env.TESTRAIL_URL)}/index.php?/runs/view/${created.id}` };
}

async function browserstack(run: RunSummary, options: SyncOptions, env: Record<string, string>, doFetch: Fetch): Promise<Omit<SyncOutcome, 'skipped'>> {
    requireEnv(env, ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY']);
    const form = new FormData();
    form.append('project_name', options.projectId!);
    form.append('test_run_name', options.runName);
    form.append('file_path', new Blob([junitFromRun(run)], { type: 'application/xml' }), 'junit.xml');
    const out = await request<{ url?: string; message?: string }>('BrowserStack Test Management', doFetch, 'https://test-management.browserstack.com/api/v1/import/results/xml/junit', {
        method: 'POST',
        headers: { Authorization: basicAuth(env.BROWSERSTACK_USERNAME, env.BROWSERSTACK_ACCESS_KEY) },
        body: form
    });
    return { target: 'browserstack', sent: run.tests.length, link: out?.url, note: out?.message };
}

async function azureDevOps(run: RunSummary, options: SyncOptions, env: Record<string, string>, doFetch: Fetch): Promise<Omit<SyncOutcome, 'skipped'>> {
    requireEnv(env, ['AZDO_ORG_URL', 'AZDO_PROJECT', 'AZDO_PAT']);
    const base = `${trimSlash(env.AZDO_ORG_URL)}/${encodeURIComponent(env.AZDO_PROJECT)}/_apis`;
    const headers = { Authorization: basicAuth('', env.AZDO_PAT), 'Content-Type': 'application/json' };
    const points = await request<{ value: Array<{ id: number; testCaseReference: { id: number } }> }>('Azure DevOps', doFetch, `${base}/testplan/Plans/${options.planId}/Suites/${options.suiteId}/TestPoint?api-version=7.1`, { headers });
    const pointFor = new Map(points.value.map(p => [p.testCaseReference.id, p.id]));
    const matched = run.tests.filter(t => pointFor.has(Number(t.id.replace(/\D+/g, ''))));
    if (!matched.length) throw new IntegrationError('None of the tests match a test case in that plan and suite.');
    const created = await request<{ id: number; webAccessUrl?: string }>('Azure DevOps', doFetch, `${base}/test/runs?api-version=7.1`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: options.runName, plan: { id: options.planId }, pointIds: matched.map(t => pointFor.get(Number(t.id.replace(/\D+/g, '')))), automated: true })
    });
    const existing = await request<{ value: Array<{ id: number; testPoint?: { id: string } }> }>('Azure DevOps', doFetch, `${base}/test/Runs/${created.id}/results?api-version=7.1`, { headers });
    const resultForPoint = new Map(existing.value.map(r => [Number(r.testPoint?.id), r.id]));
    await request('Azure DevOps', doFetch, `${base}/test/Runs/${created.id}/results?api-version=7.1`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(
            matched.map(t => ({
                id: resultForPoint.get(pointFor.get(Number(t.id.replace(/\D+/g, '')))!),
                outcome: t.status === 'passed' ? 'Passed' : 'Failed',
                state: 'Completed',
                durationInMs: t.durationMs,
                automatedTestName: t.title,
                errorMessage: t.status === 'passed' ? undefined : (t.error ?? '').slice(0, 1000),
                comment: t.status === 'flaky' ? `Flaky: passed ${t.passes} of ${t.runs}` : undefined
            }))
        )
    });
    await request('Azure DevOps', doFetch, `${base}/test/runs/${created.id}?api-version=7.1`, { method: 'PATCH', headers, body: JSON.stringify({ state: 'Completed' }) });
    return { target: 'azure-devops', sent: matched.length, reference: String(created.id), link: created.webAccessUrl };
}
