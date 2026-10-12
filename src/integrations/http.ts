/**
 * Small HTTP helpers for integrations. Credentials come from .env inside the server;
 * errors describe what went wrong without echoing credentials or full responses.
 */

export type Fetch = typeof fetch;

export const basicAuth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

export class IntegrationError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = 'IntegrationError';
    }
}

function explain(service: string, status: number, body: string): string {
    const hint =
        status === 401
            ? 'the credentials were rejected; check the keys in .env (tokens expire)'
            : status === 403
              ? 'the account lacks permission for this action'
              : status === 404
                ? 'not found; check the base URL and the project, plan or run id'
                : status === 429
                  ? 'rate limited; wait a minute and try again'
                  : status >= 500
                    ? 'the service had an error; try again later'
                    : 'the request was refused';
    const detail = body
        .replace(/\s+/g, ' ')
        .replace(/("?(token|password|secret|key|authorization)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"')
        .slice(0, 300);
    return `${service} answered ${status}: ${hint}.${detail ? ` Details: ${detail}` : ''}`;
}

/** Longest wait TestPilot accepts from a Retry-After header before giving up. */
const MAX_RETRY_WAIT_MS = 10_000;

/** Milliseconds to wait before retrying a 429, from Retry-After (seconds or an HTTP date), or undefined when it asks for too long. */
export function retryDelay(header: string | null, now = Date.now()): number | undefined {
    if (header === null || header.trim() === '') return 1000;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (!Number.isFinite(ms)) return 1000;
    const wait = Math.max(0, ms);
    return wait <= MAX_RETRY_WAIT_MS ? wait : undefined;
}

export interface HttpResult<T> {
    data: T;
    headers: Headers;
}

/** Like `request`, but also returns the response headers (for continuation tokens). One retry on 429, honouring a short Retry-After. */
export async function requestWithHeaders<T = unknown>(service: string, doFetch: Fetch, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResult<T>> {
    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            res = await doFetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
        } catch (error) {
            throw new IntegrationError(`Could not reach ${service}: ${(error as Error).message}. Check the URL, VPN or proxy (HTTPS_PROXY).`);
        }
        if (res.status !== 429 || attempt > 0) break;
        const wait = retryDelay(res.headers.get('retry-after'));
        if (wait === undefined) break;
        await res.text().catch(() => '');
        await new Promise(resolve => setTimeout(resolve, wait));
    }
    const text = await res!.text();
    if (!res!.ok) throw new IntegrationError(explain(service, res!.status, text), res!.status);
    if (!text) return { data: undefined as T, headers: res!.headers };
    try {
        return { data: JSON.parse(text) as T, headers: res!.headers };
    } catch {
        return { data: text as T, headers: res!.headers };
    }
}

export async function request<T = unknown>(service: string, doFetch: Fetch, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    return (await requestWithHeaders<T>(service, doFetch, url, init)).data;
}

export function requireEnv(env: Record<string, string>, keys: string[]): void {
    const missing = keys.filter(k => !env[k]);
    if (missing.length) throw new IntegrationError(`Fill in ${missing.join(', ')} in .env first (see .env.example for where to get each).`);
}

export const trimSlash = (s: string) => s.replace(/\/+$/, '');
