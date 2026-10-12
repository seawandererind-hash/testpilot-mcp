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

export async function request<T = unknown>(service: string, doFetch: Fetch, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    let res: Response;
    try {
        res = await doFetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
    } catch (error) {
        throw new IntegrationError(`Could not reach ${service}: ${(error as Error).message}. Check the URL, VPN or proxy (HTTPS_PROXY).`);
    }
    const text = await res.text();
    if (!res.ok) throw new IntegrationError(explain(service, res.status, text), res.status);
    if (!text) return undefined as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        return text as T;
    }
}

export function requireEnv(env: Record<string, string>, keys: string[]): void {
    const missing = keys.filter(k => !env[k]);
    if (missing.length) throw new IntegrationError(`Fill in ${missing.join(', ')} in .env first (see .env.example for where to get each).`);
}

export const trimSlash = (s: string) => s.replace(/\/+$/, '');
