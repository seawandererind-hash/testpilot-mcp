import { createHash, createPublicKey, type JsonWebKey, type KeyObject, timingSafeEqual, verify as verifySignature, constants } from 'node:crypto';

import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

/**
 * Hosted mode authentication. TestPilot is an OAuth resource server only: the
 * organisation's identity provider (Entra ID, Okta, Auth0, Keycloak, Google…)
 * issues the tokens, and TestPilot checks them locally against the provider's
 * published signing keys. No passwords or client secrets live in TestPilot.
 */

export type Fetch = typeof fetch;

export interface OAuthSettings {
    /** The identity provider's issuer URL, exactly as it appears in the token's iss claim. */
    issuer: string;
    /** The audience tokens must carry (usually TestPilot's public URL or an API identifier). */
    audience: string;
    /** Scopes every call needs; empty means any valid token for the audience. */
    requiredScopes: string[];
}

const SKEW_SECONDS = 60;

/** Fetches the provider's RFC 8414 / OpenID Connect metadata. */
export async function discoverAuthorizationServer(issuer: string, doFetch: Fetch = fetch): Promise<OAuthMetadata & { jwks_uri?: string }> {
    const url = new URL(issuer);
    const path = url.pathname.replace(/\/+$/, '');
    const candidates = [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
        `${url.origin}/.well-known/openid-configuration${path}`
    ];
    const problems: string[] = [];
    for (const candidate of candidates) {
        try {
            const res = await doFetch(candidate, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
            if (!res.ok) {
                problems.push(`${candidate}: ${res.status}`);
                continue;
            }
            const meta = (await res.json()) as OAuthMetadata & { jwks_uri?: string };
            if (meta.issuer && meta.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
                problems.push(`${candidate}: issuer is ${meta.issuer}`);
                continue;
            }
            return meta;
        } catch (error) {
            problems.push(`${candidate}: ${(error as Error).message}`);
        }
    }
    throw new Error(`Could not read the identity provider's metadata for ${issuer}. Tried:\n- ${problems.join('\n- ')}`);
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function decodeJson(part: string): Record<string, unknown> {
    try {
        const value = JSON.parse(b64url(part).toString('utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
        // fall through
    }
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is not a valid JWT.');
}

const ALGORITHMS: Record<string, { hash: string; kind: 'rsa' | 'pss' | 'ec' | 'eddsa' }> = {
    RS256: { hash: 'sha256', kind: 'rsa' },
    RS384: { hash: 'sha384', kind: 'rsa' },
    RS512: { hash: 'sha512', kind: 'rsa' },
    PS256: { hash: 'sha256', kind: 'pss' },
    PS384: { hash: 'sha384', kind: 'pss' },
    PS512: { hash: 'sha512', kind: 'pss' },
    ES256: { hash: 'sha256', kind: 'ec' },
    ES384: { hash: 'sha384', kind: 'ec' },
    ES512: { hash: 'sha512', kind: 'ec' },
    EdDSA: { hash: '', kind: 'eddsa' }
};

interface Jwk extends JsonWebKey {
    kid?: string;
    use?: string;
    alg?: string;
}

/** Verifies JWT access tokens against the provider's JWKS, refreshing keys when an unknown key id shows up. */
export class JwtVerifier implements OAuthTokenVerifier {
    private keys = new Map<string, KeyObject>();
    private loadedAt = 0;

    constructor(
        private readonly settings: OAuthSettings,
        private readonly jwksUri: string,
        private readonly doFetch: Fetch = fetch,
        private readonly now: () => number = () => Date.now()
    ) {}

    private async loadKeys(force: boolean): Promise<void> {
        // Refresh at most once a minute, and every hour regardless.
        const age = this.now() - this.loadedAt;
        if (!force && this.loadedAt && age < 3_600_000) return;
        if (force && this.loadedAt && age < 60_000) return;
        const res = await this.doFetch(this.jwksUri, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new OAuthError(OAuthErrorCode.ServerError, `Could not load the identity provider's signing keys (${res.status}).`);
        const body = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys ?? []) {
            if (jwk.use && jwk.use !== 'sig') continue;
            try {
                next.set(jwk.kid ?? '', createPublicKey({ key: jwk, format: 'jwk' }));
            } catch {
                // Skip keys Node cannot read (unsupported curve, symmetric keys).
            }
        }
        this.keys = next;
        this.loadedAt = this.now();
    }

    private async keyFor(kid: string | undefined): Promise<KeyObject> {
        await this.loadKeys(false);
        const find = () => (kid !== undefined ? this.keys.get(kid) : this.keys.size === 1 ? [...this.keys.values()][0] : undefined);
        let key = find();
        if (!key) {
            await this.loadKeys(true);
            key = find();
        }
        if (!key) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token was signed with an unknown key.');
        return key;
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const parts = token.split('.');
        if (parts.length !== 3) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is not a JWT. Configure the identity provider to issue JWT access tokens for this audience.');
        const header = decodeJson(parts[0]);
        const claims = decodeJson(parts[1]);
        const alg = ALGORITHMS[String(header.alg)];
        if (!alg) throw new OAuthError(OAuthErrorCode.InvalidToken, `Unsupported token algorithm ${String(header.alg)}.`);
        const key = await this.keyFor(typeof header.kid === 'string' ? header.kid : undefined);
        const data = Buffer.from(`${parts[0]}.${parts[1]}`);
        const signature = b64url(parts[2]);
        const ok =
            alg.kind === 'eddsa'
                ? verifySignature(null, data, key, signature)
                : verifySignature(alg.hash, data, alg.kind === 'ec' ? { key, dsaEncoding: 'ieee-p1363' } : alg.kind === 'pss' ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key, signature);
        if (!ok) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token signature is not valid.');

        const nowSeconds = Math.floor(this.now() / 1000);
        if (String(claims.iss ?? '').replace(/\/+$/, '') !== this.settings.issuer.replace(/\/+$/, '')) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token comes from a different issuer.');
        const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : claims.aud !== undefined ? [String(claims.aud)] : [];
        const wanted = this.settings.audience.replace(/\/+$/, '');
        if (!audiences.some(a => a.replace(/\/+$/, '') === wanted)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token was issued for a different audience.');
        if (typeof claims.exp !== 'number') throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token has no expiry.');
        if (claims.exp + SKEW_SECONDS < nowSeconds) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token has expired.');
        if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > nowSeconds) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is not valid yet.');

        const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : Array.isArray(claims.scp) ? claims.scp.map(String) : typeof claims.scp === 'string' ? claims.scp.split(/\s+/).filter(Boolean) : [];
        let resource: URL | undefined;
        try {
            resource = new URL(wanted);
        } catch {
            resource = undefined; // an API identifier such as api://testpilot is not compared as a URL
        }
        return {
            token,
            clientId: String(claims.azp ?? claims.client_id ?? claims.cid ?? claims.appid ?? 'unknown'),
            scopes,
            expiresAt: claims.exp,
            resource,
            extra: {
                subject: String(claims.sub ?? ''),
                issuer: String(claims.iss),
                user: String(claims.email ?? claims.preferred_username ?? claims.upn ?? claims.name ?? claims.sub ?? 'unknown')
            }
        };
    }
}

/** A single shared token, for small teams and for trying hosted mode out. */
export class StaticTokenVerifier implements OAuthTokenVerifier {
    private readonly digest: Buffer;

    constructor(token: string) {
        if (token.length < 24) throw new Error('TESTPILOT_HTTP_TOKEN must be at least 24 characters long.');
        this.digest = createHash('sha256').update(token).digest();
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const given = createHash('sha256').update(token).digest();
        if (!timingSafeEqual(given, this.digest)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown access token.');
        // The SDK refuses tokens without an expiry; a shared token is valid until it is rotated.
        return { token, clientId: 'shared-token', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { subject: 'shared', issuer: 'testpilot', user: 'shared token' } };
    }
}

/** The stable folder key for a signed-in person: their issuer and subject, hashed. */
export function userKey(auth: AuthInfo | undefined): string {
    const subject = String(auth?.extra?.subject ?? '');
    const issuer = String(auth?.extra?.issuer ?? '');
    if (!subject) throw new Error('The request has no signed-in user.');
    return createHash('sha256').update(`${issuer}\n${subject}`).digest('hex').slice(0, 24);
}
