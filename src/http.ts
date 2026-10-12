import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
    type AuthInfo,
    createMcpHandler,
    getOAuthProtectedResourceMetadataUrl,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    type OAuthMetadata,
    type OAuthTokenVerifier,
    oauthMetadataResponse,
    originValidationResponse,
    requireBearerAuth
} from '@modelcontextprotocol/server';

import { userKey } from './remote/auth.js';
import { type DownloadSigner, downloadFile, type GitHubSettings } from './remote/delivery.js';
import { userBase } from './remote/workspaces.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

/**
 * The Streamable HTTP front door, as a web-standard fetch handler so it runs the
 * same under Node, in tests, and behind any proxy.
 *
 * - local: serves one repository on this machine (localhost only unless a token is set).
 * - remote: the hosted mode for ChatGPT and claude.ai. Every request needs a token from
 *   the organisation's identity provider (or a shared token), each person gets their own
 *   workspaces, and nothing runs programs on the server.
 */

export interface HttpAppOptions {
    mode: 'local' | 'remote';
    /** local: the repository to serve. */
    root?: string;
    /** Bind address; DNS-rebinding protection applies when it is a loopback address. */
    host: string;
    /** remote: public URL of the MCP endpoint, e.g. https://testpilot.example.com/mcp. */
    publicUrl?: URL;
    verifier?: OAuthTokenVerifier;
    requiredScopes?: string[];
    /** remote with OAuth: the identity provider's metadata, advertised to clients (RFC 9728). */
    authServer?: OAuthMetadata;
    workspacesDir?: string;
    signer?: DownloadSigner;
    github?: GitHubSettings;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function createHttpApp(options: HttpAppOptions): { fetch: (request: Request) => Promise<Response>; close: () => Promise<void> } {
    const remote = options.mode === 'remote';
    if (remote && (!options.publicUrl || !options.verifier || !options.workspacesDir || !options.signer)) {
        throw new Error('Hosted mode needs a public URL, a sign-in method and a workspaces folder.');
    }
    const mcpPath = options.publicUrl?.pathname.replace(/\/+$/, '') || '/mcp';

    const handler = createMcpHandler(
        ctx => {
            if (!remote) return createServer({ root: options.root, mode: 'local' });
            const auth = ctx.authInfo;
            return createServer({
                mode: 'remote',
                hosted: {
                    workspacesDir: options.workspacesDir!,
                    userBase: userBase(options.workspacesDir!, userKey(auth)),
                    user: String(auth?.extra?.user ?? 'unknown'),
                    publicOrigin: options.publicUrl!.origin,
                    signer: options.signer!,
                    github: options.github
                }
            });
        },
        { onerror: error => console.error('[testpilot] request failed:', error.message) }
    );

    const resourceMetadataUrl = remote && options.authServer ? getOAuthProtectedResourceMetadataUrl(options.publicUrl!) : undefined;
    const gate = options.verifier ? requireBearerAuth({ verifier: options.verifier, requiredScopes: options.requiredScopes?.length ? options.requiredScopes : undefined, resourceMetadataUrl }) : undefined;
    const loopback = LOOPBACK.has(options.host);

    async function serveDownload(request: Request, url: URL): Promise<Response> {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
        const check = options.signer!.verify(url.pathname);
        if ('error' in check) return new Response(check.error, { status: check.error === 'Not found' ? 404 : 403 });
        const file = downloadFile(options.workspacesDir!, check.rel);
        if (!file) return new Response('This file is no longer available. Ask TestPilot for a new download link.', { status: 404 });
        const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
        return new Response(stream, {
            headers: {
                'Content-Type': 'application/zip',
                'Content-Length': String(statSync(file).size),
                'Content-Disposition': `attachment; filename="${path.basename(file).replace(/[^\w.-]/g, '_')}"`,
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff'
            }
        });
    }

    return {
        async fetch(request: Request): Promise<Response> {
            const url = new URL(request.url);
            if (loopback) {
                // A page in the browser must not reach a local server by DNS rebinding.
                const refused = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());
                if (refused) return refused;
            }
            if (url.pathname === '/healthz') return Response.json({ status: 'ok', name: 'testpilot', version: VERSION, mode: options.mode });
            if (remote && options.authServer) {
                const metadata = oauthMetadataResponse(request, {
                    oauthMetadata: options.authServer,
                    resourceServerUrl: options.publicUrl!,
                    resourceName: 'TestPilot',
                    scopesSupported: options.requiredScopes?.length ? options.requiredScopes : undefined,
                    dangerouslyAllowInsecureIssuerUrl: options.authServer.issuer.startsWith('http://localhost') || options.authServer.issuer.startsWith('http://127.0.0.1')
                });
                if (metadata) return metadata;
            }
            if (remote && url.pathname.startsWith('/downloads/')) return serveDownload(request, url);
            if (url.pathname !== mcpPath && url.pathname !== `${mcpPath}/`) return new Response(`TestPilot MCP ${VERSION}: the MCP endpoint is ${mcpPath}`, { status: 404 });

            let authInfo: AuthInfo | undefined;
            if (gate) {
                const auth = await gate(request);
                if (auth instanceof Response) return auth;
                authInfo = auth;
            }
            return handler.fetch(request, { authInfo });
        },
        close: () => handler.close()
    };
}
