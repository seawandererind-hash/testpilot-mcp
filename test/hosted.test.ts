import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApp } from '../src/http.js';
import { JwtVerifier, StaticTokenVerifier } from '../src/remote/auth.js';
import { DownloadSigner } from '../src/remote/delivery.js';
import { createZip } from '../src/remote/zip.js';

const ISSUER = 'https://login.example.com/tenant';
const PUBLIC = new URL('https://testpilot.example.com/mcp');

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwks = { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', use: 'sig' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', use: 'sig' }] };

function jwt(claims: Record<string, unknown>, opts: { kid?: string; alg?: 'RS256' | 'ES256'; key?: KeyObject } = {}): string {
    const alg = opts.alg ?? 'RS256';
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = enc({ alg, typ: 'JWT', kid: opts.kid ?? (alg === 'RS256' ? 'rsa-1' : 'ec-1') });
    const body = enc(claims);
    const key = opts.key ?? (alg === 'RS256' ? rsa.privateKey : ec.privateKey);
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key).toString('base64url');
    return `${head}.${body}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const claimsFor = (sub: string, extra: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: PUBLIC.href, sub, email: `${sub}@example.com`, exp: now + 600, iat: now, scope: 'testpilot', azp: 'chatgpt', ...extra });

function jwksFetch() {
    return vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;
}

describe('JWT verification', () => {
    const verifier = () => new JwtVerifier({ issuer: ISSUER, audience: PUBLIC.href, requiredScopes: [] }, 'https://login.example.com/keys', jwksFetch());

    it('accepts a valid RS256 or ES256 token and reports who signed in', async () => {
        const v = verifier();
        const info = await v.verifyAccessToken(jwt(claimsFor('alice')));
        expect(info).toMatchObject({ clientId: 'chatgpt', scopes: ['testpilot'], extra: { subject: 'alice', user: 'alice@example.com' } });
        expect((await v.verifyAccessToken(jwt(claimsFor('bob'), { alg: 'ES256' }))).extra?.subject).toBe('bob');
    });

    it.each([
        ['another audience', claimsFor('a', { aud: 'https://elsewhere.example.com' }), /different audience/],
        ['another issuer', claimsFor('a', { iss: 'https://evil.example.com' }), /different issuer/],
        ['an expired token', claimsFor('a', { exp: now - 3600 }), /expired/],
        ['no expiry', claimsFor('a', { exp: undefined }), /no expiry/],
        ['a future nbf', claimsFor('a', { nbf: now + 3600 }), /not valid yet/]
    ])('refuses %s', async (_label, claims, message) => {
        await expect(verifier().verifyAccessToken(jwt(claims))).rejects.toThrow(message);
    });

    it('refuses a forged signature and an unknown key', async () => {
        const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
        await expect(verifier().verifyAccessToken(jwt(claimsFor('a'), { key: other.privateKey }))).rejects.toThrow(/signature/);
        await expect(verifier().verifyAccessToken(jwt(claimsFor('a'), { kid: 'nope' }))).rejects.toThrow(/unknown key/);
        await expect(verifier().verifyAccessToken('not-a-jwt')).rejects.toThrow(/not a JWT/);
    });

    it('a shared token must be long and match exactly', async () => {
        expect(() => new StaticTokenVerifier('short')).toThrow(/24 characters/);
        const v = new StaticTokenVerifier('a-long-enough-shared-token-123');
        await expect(v.verifyAccessToken('a-long-enough-shared-token-12')).rejects.toThrow();
        expect((await v.verifyAccessToken('a-long-enough-shared-token-123')).extra?.subject).toBe('shared');
    });
});

/** Reads the entries of a zip produced by createZip. */
function unzip(buf: Buffer): Map<string, string> {
    const out = new Map<string, string>();
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let p = buf.readUInt32LE(end + 16);
    const count = buf.readUInt16LE(end + 10);
    for (let i = 0; i < count; i++) {
        const method = buf.readUInt16LE(p + 10);
        const size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
        const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(dataStart, dataStart + size);
        out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
        p += 46 + nameLen;
    }
    return out;
}

describe('zip writer', () => {
    it('round-trips stored and deflated entries', () => {
        const big = 'repeat '.repeat(500);
        const files = unzip(createZip([{ path: 'a/b.txt', data: Buffer.from(big) }, { path: 'x.bin', data: Buffer.from([1, 2, 3]) }, { path: 'ünïcode.md', data: Buffer.from('# hi') }]));
        expect(files.get('a/b.txt')).toBe(big);
        expect(files.get('ünïcode.md')).toBe('# hi');
        expect(files.size).toBe(3);
    });
});

describe('hosted mode over HTTP', () => {
    let apps: Array<{ close: () => Promise<void> }> = [];
    afterEach(async () => {
        vi.unstubAllGlobals();
        for (const a of apps) await a.close();
        apps = [];
    });

    function hosted(extra: { github?: { token: string; api: string; owners: string[] } } = {}) {
        const workspacesDir = mkdtempSync(path.join(tmpdir(), 'tp-ws-'));
        const signer = new DownloadSigner('test-secret');
        const app = createHttpApp({
            mode: 'remote',
            host: '0.0.0.0',
            publicUrl: PUBLIC,
            verifier: new JwtVerifier({ issuer: ISSUER, audience: PUBLIC.href, requiredScopes: [] }, 'https://login.example.com/keys', jwksFetch()),
            requiredScopes: ['testpilot'],
            authServer: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, response_types_supported: ['code'] } as never,
            workspacesDir,
            signer,
            github: extra.github
        });
        apps.push(app);
        return { app, workspacesDir, signer };
    }

    async function clientFor(app: { fetch: (r: Request) => Promise<Response> }, sub: string) {
        const token = jwt(claimsFor(sub));
        const transport = new StreamableHTTPClientTransport(PUBLIC, {
            fetch: (url, init) => {
                const headers = new Headers(init?.headers);
                headers.set('Authorization', `Bearer ${token}`);
                return app.fetch(new Request(url, { ...init, headers }));
            }
        });
        const client = new Client({ name: 'hosted-test', version: '1.0.0' });
        await client.connect(transport);
        const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; structuredContent?: any; isError?: boolean };
        return { client, call };
    }

    it('advertises the identity provider and challenges anonymous calls', async () => {
        const { app } = hosted();
        const meta = await app.fetch(new Request('https://testpilot.example.com/.well-known/oauth-protected-resource/mcp'));
        expect(meta.status).toBe(200);
        expect(await meta.json()).toMatchObject({ resource: PUBLIC.href, authorization_servers: [ISSUER] });

        const anon = await app.fetch(new Request(PUBLIC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
        expect(anon.status).toBe(401);
        expect(anon.headers.get('www-authenticate')).toContain('resource_metadata="https://testpilot.example.com/.well-known/oauth-protected-resource/mcp"');

        const health = await app.fetch(new Request('https://testpilot.example.com/healthz'));
        expect(await health.json()).toMatchObject({ status: 'ok', mode: 'remote' });
    });

    it('gives each person their own workspaces and never runs programs', async () => {
        const { app, workspacesDir } = hosted();
        const alice = await clientFor(app, 'alice');
        const bob = await clientFor(app, 'bob');

        const tools = (await alice.client.listTools()).tools.map(t => t.name);
        expect(tools).toContain('hosted_workspace');

        expect((await alice.call('wizard', { projectRoot: 'shop-web', action: 'answer', step: 'APP_TYPE', answer: 'web' })).isError).toBeFalsy();
        const withShop = readdirSync(workspacesDir).filter(f => existsSync(path.join(workspacesDir, f, 'shop-web', '.testpilot', 'config.yaml')));
        expect(withShop).toHaveLength(1);

        const bobList = await bob.call('hosted_workspace', { action: 'list' });
        expect(bobList.structuredContent.workspaces).toEqual([]);
        const aliceList = await alice.call('hosted_workspace', { action: 'list' });
        expect(aliceList.structuredContent.workspaces.map((w: { name: string }) => w.name)).toEqual(['shop-web']);

        const escape = await alice.call('wizard', { projectRoot: '/etc', action: 'next' });
        expect(escape.isError).toBe(true);
        expect(escape.content[0].text).toContain('workspace name');
        const dots = await alice.call('wizard', { projectRoot: '../bob', action: 'next' });
        expect(dots.isError).toBe(true);

        const run = await alice.call('run_tests', { projectRoot: 'shop-web' });
        expect(run.isError).toBe(true);
        expect(run.content[0].text).toContain('does not run tests');
        await alice.client.close();
        await bob.client.close();
    });

    it('takes shared files in, and hands the project out as a signed zip without .env', async () => {
        const { app, workspacesDir } = hosted();
        const alice = await clientFor(app, 'alice');
        const csv = 'ID,Title,Steps,Expected\nTC-1,Login works,"1. Open the login page\n2. Log in as standard",Dashboard is displayed\n';
        const saved = await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'add-file', path: 'cases.csv', content: csv });
        expect(saved.isError).toBeFalsy();
        expect(saved.structuredContent.path).toBe('inputs/cases.csv');
        expect((await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'add-file', path: '.env', content: 'X=1' })).isError).toBe(true);
        expect((await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'add-file', path: 'run.sh', content: 'rm -rf /' })).isError).toBe(true);

        const imported = await alice.call('import_test_cases', { projectRoot: 'shop', location: 'inputs/cases.csv', source: 'csv' });
        expect(imported.isError).toBeFalsy();
        expect(imported.structuredContent.added).toEqual(['TC-1']);

        const folder = readdirSync(workspacesDir).find(f => existsSync(path.join(workspacesDir, f, 'shop')))!;
        writeFileSync(path.join(workspacesDir, folder, 'shop', '.env'), 'TEST_USER_PASSWORD=hunter2-secret\n');
        const zipped = await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'zip' });
        expect(zipped.isError).toBeFalsy();
        const url = new URL(zipped.structuredContent.downloadUrl);
        expect(url.origin).toBe('https://testpilot.example.com');

        const download = await app.fetch(new Request(url));
        expect(download.status).toBe(200);
        expect(download.headers.get('content-disposition')).toContain('attachment');
        const files = unzip(Buffer.from(await download.arrayBuffer()));
        expect([...files.keys()]).toContain('shop/inputs/cases.csv');
        expect([...files.keys()]).toContain('shop/.testpilot/test-cases/normalized/TC-1.json');
        expect([...files.keys()].some(f => f.endsWith('.env'))).toBe(false);
        expect([...files.values()].join('\n')).not.toContain('hunter2-secret');

        const tampered = new URL(url);
        tampered.pathname = url.pathname.replace(/\/([A-Za-z0-9_-]+)\/([^/]+)$/, '/AAAA$1/$2');
        expect((await app.fetch(new Request(tampered))).status).toBe(403);
        await alice.client.close();
    });

    it('expires download links', () => {
        const signer = new DownloadSigner('k');
        const link = signer.sign('abc/x.zip', 60, 0);
        expect(signer.verify(link, 1000)).toEqual({ rel: 'abc/x.zip' });
        expect(signer.verify(link, 120_000)).toMatchObject({ error: expect.stringContaining('expired') });
    });

    it('opens a draft pull request only after preview and approval, and only for allowed owners', async () => {
        const { app } = hosted({ github: { token: 'ghs_servertoken', api: 'https://api.github.com', owners: ['acme'] } });
        const alice = await clientFor(app, 'alice');
        await alice.call('wizard', { projectRoot: 'shop', action: 'answer', step: 'APP_TYPE', answer: 'web' });
        await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'add-file', path: 'cases.md', content: '# Cases' });

        const calls: Array<{ method: string; url: string; body?: any }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit = {}) => {
                const method = init.method ?? 'GET';
                calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
                const route = new URL(url).pathname;
                const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
                if (method === 'GET' && route === '/repos/acme/shop-tests') return json({ default_branch: 'main', permissions: { push: true } });
                if (route === '/repos/acme/shop-tests/git/ref/heads/main') return json({ object: { sha: 'base-sha' } });
                if (route === '/repos/acme/shop-tests/git/commits/base-sha') return json({ tree: { sha: 'tree-sha' } });
                if (route === '/repos/acme/shop-tests/git/trees/tree-sha') return json({ tree: [{ path: 'README.md', type: 'blob' }, { path: 'tests/.testpilot/config.yaml', type: 'blob' }] });
                if (route === '/repos/acme/shop-tests/git/blobs') return json({ sha: `blob-${calls.length}` }, 201);
                if (route === '/repos/acme/shop-tests/git/trees') return json({ sha: 'new-tree' }, 201);
                if (route === '/repos/acme/shop-tests/git/commits') return json({ sha: 'new-commit' }, 201);
                if (route === '/repos/acme/shop-tests/git/refs') return json({ ref: 'refs/heads/x' }, 201);
                if (route === '/repos/acme/shop-tests/pulls') return json({ html_url: 'https://github.com/acme/shop-tests/pull/7', number: 7 }, 201);
                return json({ message: 'Not Found' }, 404);
            })
        );

        const denied = await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'pull-request', repository: 'evil/repo' });
        expect(denied.isError).toBe(true);
        expect(denied.content[0].text).toContain('not allowed');

        const preview = await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'pull-request', repository: 'acme/shop-tests', targetDir: 'tests' });
        expect(preview.isError).toBeFalsy();
        expect(preview.structuredContent.changed).toBe(1);
        expect(calls.every(c => c.method === 'GET')).toBe(true);

        const token = preview.structuredContent.confirmToken;
        const refused = await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'pull-request', repository: 'acme/shop-tests', targetDir: 'tests', confirmToken: token });
        expect(refused.isError).toBe(true);
        expect(calls.some(c => c.method === 'POST')).toBe(false);

        const opened = await alice.call('hosted_workspace', { projectRoot: 'shop', action: 'pull-request', repository: 'acme/shop-tests', targetDir: 'tests', confirmToken: token, userApproved: true, approver: 'Surya' });
        expect(opened.isError).toBeFalsy();
        expect(opened.structuredContent.url).toBe('https://github.com/acme/shop-tests/pull/7');
        const tree = calls.find(c => c.url.endsWith('/git/trees') && c.method === 'POST')!.body;
        expect(tree.base_tree).toBe('tree-sha');
        expect(tree.tree.every((t: { path: string }) => t.path.startsWith('tests/'))).toBe(true);
        const pr = calls.find(c => c.url.endsWith('/pulls'))!.body;
        expect(pr).toMatchObject({ head: expect.stringMatching(/^testpilot\/shop-/), base: 'main', draft: true });
        expect(pr.body).toContain('alice@example.com');
        expect(JSON.stringify(calls)).not.toContain('ghs_servertoken');
        await alice.client.close();
    });

    it('protects a loopback server from DNS rebinding', async () => {
        const app = createHttpApp({ mode: 'local', host: '127.0.0.1', root: mkdtempSync(path.join(tmpdir(), 'tp-local-')) });
        apps.push(app);
        const res = await app.fetch(new Request('http://evil.example.com/mcp', { method: 'POST', headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' }, body: '{}' }));
        expect(res.status).toBe(403);
        const ok = await app.fetch(new Request('http://127.0.0.1:3333/healthz', { headers: { Host: '127.0.0.1:3333' } }));
        expect(ok.status).toBe(200);
    });
});
