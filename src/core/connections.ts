/**
 * Connection tests for integrations. They use values from .env inside the server
 * and return only ok / error, never the values or full responses.
 */

export interface ConnectionResult {
    integration: string;
    ok: boolean;
    detail: string;
}

type Fetch = typeof fetch;

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function probe(integration: string, doFetch: Fetch, url: string, init: RequestInit, okDetail: string): Promise<ConnectionResult> {
    try {
        const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
        if (res.ok) return { integration, ok: true, detail: okDetail };
        const reason = res.status === 401 ? 'the credentials were rejected (401)' : res.status === 403 ? 'the account lacks permission (403)' : res.status === 404 ? 'the address was not found (404); check the base URL' : `the server answered ${res.status}`;
        return { integration, ok: false, detail: `Could not connect: ${reason}.` };
    } catch (error) {
        return { integration, ok: false, detail: `Could not reach the server: ${(error as Error).message}. Check the URL, VPN or proxy.` };
    }
}

export async function testConnection(integration: string, env: Record<string, string>, doFetch: Fetch = fetch): Promise<ConnectionResult> {
    const missing = (keys: string[]) => keys.filter(k => !env[k]);
    const need = (keys: string[]): ConnectionResult | undefined => {
        const m = missing(keys);
        return m.length ? { integration, ok: false, detail: `Fill in ${m.join(', ')} in .env first.` } : undefined;
    };
    switch (integration) {
        case 'jira': {
            const gap = need(['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']);
            if (gap) return gap;
            return probe('jira', doFetch, `${env.JIRA_BASE_URL.replace(/\/$/, '')}/rest/api/3/myself`, { headers: { Authorization: basic(env.JIRA_EMAIL, env.JIRA_API_TOKEN), Accept: 'application/json' } }, 'Jira accepted the API token. Note: Jira API tokens expire within 365 days.');
        }
        case 'zephyr': {
            // The same call and token the importer uses; Jira itself is checked as its own integration.
            const gap = need(['ZEPHYR_API_TOKEN']);
            if (gap) return gap;
            const base = (env.ZEPHYR_BASE_URL || 'https://api.zephyrscale.smartbear.com/v2').replace(/\/+$/, '');
            return probe('zephyr', doFetch, `${base}/testcases?maxResults=1`, { headers: { Authorization: `Bearer ${env.ZEPHYR_API_TOKEN}`, Accept: 'application/json' } }, 'Zephyr accepted the API token.');
        }
        case 'xray': {
            const gap = need(['XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET']);
            if (gap) return gap;
            const base = (env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app').replace(/\/+$/, '');
            return probe('xray', doFetch, `${base}/api/v2/authenticate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.XRAY_CLIENT_ID, client_secret: env.XRAY_CLIENT_SECRET }) }, 'Xray accepted the client id and secret.');
        }
        case 'browserstack': {
            const gap = need(['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY']);
            if (gap) return gap;
            return probe(integration, doFetch, 'https://api.browserstack.com/automate/plan.json', { headers: { Authorization: basic(env.BROWSERSTACK_USERNAME, env.BROWSERSTACK_ACCESS_KEY) } }, 'BrowserStack accepted the username and access key.');
        }
        case 'browserstack-tm': {
            // Test Management has its own host (regional ones too); check the API the importer reads.
            const gap = need(['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY']);
            if (gap) return gap;
            const base = (env.BROWSERSTACK_TM_URL || 'https://test-management.browserstack.com').replace(/\/+$/, '');
            return probe(integration, doFetch, `${base}/api/v2/projects`, { headers: { Authorization: basic(env.BROWSERSTACK_USERNAME, env.BROWSERSTACK_ACCESS_KEY), Accept: 'application/json' } }, 'BrowserStack Test Management accepted the username and access key.');
        }
        case 'testrail': {
            const gap = need(['TESTRAIL_URL', 'TESTRAIL_USER', 'TESTRAIL_API_KEY']);
            if (gap) return gap;
            return probe('testrail', doFetch, `${env.TESTRAIL_URL.replace(/\/$/, '')}/index.php?/api/v2/get_projects`, { headers: { Authorization: basic(env.TESTRAIL_USER, env.TESTRAIL_API_KEY), 'Content-Type': 'application/json' } }, 'TestRail accepted the API key.');
        }
        case 'azure-devops': {
            const gap = need(['AZDO_ORG_URL', 'AZDO_PROJECT', 'AZDO_PAT']);
            if (gap) return gap;
            return probe('azure-devops', doFetch, `${env.AZDO_ORG_URL.replace(/\/$/, '')}/${encodeURIComponent(env.AZDO_PROJECT)}/_apis/testplan/plans?api-version=7.1`, { headers: { Authorization: basic('', env.AZDO_PAT), Accept: 'application/json' } }, 'Azure DevOps accepted the token.');
        }
        case 'app': {
            const gap = need(['APP_BASE_URL']);
            if (gap) return gap;
            return probe('app', doFetch, env.APP_BASE_URL, { method: 'GET', redirect: 'follow' }, 'The test environment answered.');
        }
        case 'api': {
            const gap = need(['API_BASE_URL']);
            if (gap) return gap;
            try {
                await doFetch(env.API_BASE_URL, { signal: AbortSignal.timeout(15_000) });
                return { integration, ok: true, detail: 'The API answered.' };
            } catch (error) {
                return { integration, ok: false, detail: `Could not reach the API: ${(error as Error).message}.` };
            }
        }
        default:
            return { integration, ok: true, detail: 'No connection test for this integration; only key presence was checked.' };
    }
}
