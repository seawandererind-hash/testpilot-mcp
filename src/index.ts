#!/usr/bin/env node
import { mkdirSync, realpathSync } from 'node:fs';
import { createServer as createNodeServer } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { toNodeHandler } from '@modelcontextprotocol/node';
import type { OAuthMetadata, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createHttpApp, type HttpAppOptions } from './http.js';
import { discoverAuthorizationServer, JwtVerifier, StaticTokenVerifier } from './remote/auth.js';
import { DownloadSigner, type GitHubSettings } from './remote/delivery.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `TestPilot MCP ${VERSION}

Usage:
  testpilot-mcp [--root <repo folder>]                  Serve one repository over stdio (Cursor, Claude Code, VS Code, Antigravity…)
  testpilot-mcp --http [--port 3333] [--host 127.0.0.1]  Serve one repository over Streamable HTTP on this machine
  testpilot-mcp --remote --public-url <url>             Hosted mode for ChatGPT and claude.ai (see docs/hosting.md)

Options:
  --root <path>        Repository folder to work in (default: TESTPILOT_ROOT or the current folder)
  --http               Serve Streamable HTTP instead of stdio
  --remote             Hosted mode: sign-in required, one set of workspaces per person, delivery as zip or pull request
  --public-url <url>   Public URL of the MCP endpoint, e.g. https://testpilot.example.com/mcp (hosted mode)
  --workspaces <dir>   Folder for hosted workspaces (default: TESTPILOT_WORKSPACES or ./testpilot-workspaces)
  --port <n>           HTTP port (default: PORT or 3333)
  --host <addr>        HTTP bind address (default 127.0.0.1; hosted mode defaults to 0.0.0.0)
  --version            Print the version

Hosted mode settings (environment):
  TESTPILOT_OAUTH_ISSUER     Your identity provider's issuer URL (Entra ID, Okta, Auth0, Keycloak, Google…)
  TESTPILOT_OAUTH_AUDIENCE   Audience the tokens carry (default: the public URL)
  TESTPILOT_OAUTH_SCOPES     Scopes every call needs, space or comma separated (optional)
  TESTPILOT_HTTP_TOKEN       Or: one shared bearer token (24+ characters) instead of OAuth
  TESTPILOT_DOWNLOAD_SECRET  Signs download links; set it when running more than one instance
  TESTPILOT_GITHUB_TOKEN     Token used to open pull requests (optional)
  TESTPILOT_GITHUB_OWNERS    Users or organisations pull requests may go to, comma separated
  TESTPILOT_GITHUB_API       GitHub API URL for GitHub Enterprise Server (default https://api.github.com)
`;

const { values } = parseArgs({
    options: {
        root: { type: 'string' },
        http: { type: 'boolean', default: false },
        remote: { type: 'boolean', default: false },
        'public-url': { type: 'string' },
        workspaces: { type: 'string' },
        port: { type: 'string', default: process.env.PORT ?? '3333' },
        host: { type: 'string' },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
    },
    allowPositionals: false
});

if (values.help) {
    console.error(HELP);
    process.exit(0);
}
if (values.version) {
    console.error(VERSION);
    process.exit(0);
}

const env = process.env;
const list = (raw?: string) => (raw ?? '').split(/[\s,]+/).filter(Boolean);

function fail(message: string): never {
    console.error(`[testpilot] ${message}`);
    process.exit(1);
}

async function hostedOptions(host: string): Promise<HttpAppOptions> {
    const raw = values['public-url'] ?? env.TESTPILOT_PUBLIC_URL;
    if (!raw) fail('Hosted mode needs --public-url (or TESTPILOT_PUBLIC_URL), e.g. https://testpilot.example.com/mcp');
    let publicUrl: URL;
    try {
        publicUrl = new URL(raw);
    } catch {
        fail(`--public-url "${raw}" is not a URL.`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
    if (publicUrl.protocol !== 'https:' && !local) fail('The public URL must use https:// (ChatGPT and claude.ai only connect over HTTPS).');

    let verifier: OAuthTokenVerifier;
    let authServer: OAuthMetadata | undefined;
    const issuer = env.TESTPILOT_OAUTH_ISSUER;
    if (issuer) {
        const metadata = await discoverAuthorizationServer(issuer).catch(error => fail((error as Error).message));
        if (!metadata.jwks_uri) fail(`${issuer} does not publish signing keys (jwks_uri), so TestPilot cannot check its tokens.`);
        verifier = new JwtVerifier({ issuer, audience: env.TESTPILOT_OAUTH_AUDIENCE ?? publicUrl.href, requiredScopes: list(env.TESTPILOT_OAUTH_SCOPES) }, metadata.jwks_uri);
        authServer = metadata;
    } else if (env.TESTPILOT_HTTP_TOKEN) {
        try {
            verifier = new StaticTokenVerifier(env.TESTPILOT_HTTP_TOKEN);
        } catch (error) {
            fail((error as Error).message);
        }
        console.error('[testpilot] Using one shared token: everyone who has it shares the same workspaces. Use TESTPILOT_OAUTH_ISSUER for per-person sign-in.');
    } else {
        fail('Hosted mode needs sign-in: set TESTPILOT_OAUTH_ISSUER (recommended) or TESTPILOT_HTTP_TOKEN.');
    }

    const workspacesDir = path.resolve(values.workspaces ?? env.TESTPILOT_WORKSPACES ?? 'testpilot-workspaces');
    mkdirSync(workspacesDir, { recursive: true, mode: 0o700 });

    let github: GitHubSettings | undefined;
    if (env.TESTPILOT_GITHUB_TOKEN) {
        const owners = list(env.TESTPILOT_GITHUB_OWNERS);
        if (!owners.length) fail('TESTPILOT_GITHUB_TOKEN is set but TESTPILOT_GITHUB_OWNERS is empty. List the users or organisations pull requests may go to.');
        github = { token: env.TESTPILOT_GITHUB_TOKEN, api: env.TESTPILOT_GITHUB_API ?? 'https://api.github.com', owners };
    }
    if (!env.TESTPILOT_DOWNLOAD_SECRET) console.error('[testpilot] TESTPILOT_DOWNLOAD_SECRET is not set: download links stop working when the server restarts.');

    return {
        mode: 'remote',
        host,
        publicUrl,
        verifier,
        requiredScopes: issuer ? list(env.TESTPILOT_OAUTH_SCOPES) : [],
        authServer,
        workspacesDir: realpathSync(workspacesDir),
        signer: new DownloadSigner(env.TESTPILOT_DOWNLOAD_SECRET),
        github
    };
}

async function main(): Promise<void> {
    const root = values.root ?? env.TESTPILOT_ROOT;
    if (!values.http && !values.remote) {
        const handle = serveStdio(() => createServer({ root, mode: 'local' }));
        console.error(`[testpilot] TestPilot MCP ${VERSION} ready on stdio${root ? ` (root ${root})` : ''}`);
        process.on('SIGINT', () => void handle.close());
        return;
    }

    const host = values.host ?? (values.remote ? '0.0.0.0' : '127.0.0.1');
    let options: HttpAppOptions;
    if (values.remote) {
        options = await hostedOptions(host);
    } else {
        const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
        if (!loopback && !env.TESTPILOT_HTTP_TOKEN) fail('Serving a local repository on a non-local address needs TESTPILOT_HTTP_TOKEN. For a shared server use --remote.');
        options = { mode: 'local', root, host, verifier: env.TESTPILOT_HTTP_TOKEN ? new StaticTokenVerifier(env.TESTPILOT_HTTP_TOKEN) : undefined };
    }

    const app = createHttpApp(options);
    const server = createNodeServer(toNodeHandler(app, { maxRequestBodySize: 20 * 1024 * 1024, onerror: error => console.error('[testpilot]', error.message) }));
    server.listen(Number(values.port), host, () => {
        const where = options.publicUrl?.href ?? `http://${host}:${values.port}/mcp`;
        console.error(`[testpilot] TestPilot MCP ${VERSION} ${values.remote ? 'hosted mode' : 'serving'} on ${where}${values.remote ? ` (listening on ${host}:${values.port})` : ''}`);
    });
    const stop = async () => {
        await app.close();
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
}

main().catch(error => fail((error as Error).message));
