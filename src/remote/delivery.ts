import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { redactString } from '../core/redact.js';

/**
 * Hands a hosted workspace over to the team: as a zip behind a short-lived signed
 * link, or as a draft pull request created through the GitHub REST API. Local
 * secrets files are never included.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'allure-results', 'allure-report', 'blob-report', 'dist', 'coverage']);
const SKIP_PATHS = ['.testpilot/deliveries/', '.testpilot/exploration/screenshots/'];
const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;

export interface WorkspaceFile {
    path: string;
    data: Buffer;
    modified: Date;
}

export interface Collected {
    files: WorkspaceFile[];
    bytes: number;
    /** Files left out because they hold local secrets (.env) or are too big. */
    excluded: string[];
    /** Files that look like they contain a credential; shown in the preview so a person checks them. */
    suspicious: string[];
}

const isSecretsFile = (name: string) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example');

export function collectWorkspace(root: string): Collected {
    const files: WorkspaceFile[] = [];
    const excluded: string[] = [];
    const suspicious: string[] = [];
    let bytes = 0;
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const abs = path.join(dir, entry.name);
            const rel = path.relative(root, abs).split(path.sep).join('/');
            if (lstatSync(abs).isSymbolicLink()) {
                excluded.push(`${rel} (symbolic link)`);
                continue;
            }
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.some(p => `${rel}/`.startsWith(p))) continue;
                walk(abs);
                continue;
            }
            if (!entry.isFile()) continue;
            if (isSecretsFile(entry.name)) {
                excluded.push(`${rel} (local secrets file)`);
                continue;
            }
            if (/\.tmp$/.test(entry.name)) continue;
            const size = statSync(abs).size;
            if (size > 10 * 1024 * 1024) {
                excluded.push(`${rel} (larger than 10 MB)`);
                continue;
            }
            if (files.length >= MAX_FILES || bytes + size > MAX_BYTES) {
                excluded.push(`${rel} (workspace size limit reached)`);
                continue;
            }
            const data = readFileSync(abs);
            if (size < 512 * 1024 && !data.includes(0)) {
                const text = data.toString('utf8');
                if (redactString(text) !== text) suspicious.push(rel);
            }
            files.push({ path: rel, data, modified: statSync(abs).mtime });
            bytes += size;
        }
    };
    walk(realpathSync(root));
    return { files, bytes, excluded, suspicious };
}

// ---- signed download links --------------------------------------------------

export class DownloadSigner {
    private readonly key: Buffer;

    constructor(secret?: string) {
        this.key = secret ? Buffer.from(secret, 'utf8') : randomBytes(32);
    }

    private mac(rel: string, expires: number): string {
        return createHmac('sha256', this.key).update(`${rel}\n${expires}`).digest('base64url');
    }

    /** A path for the HTTP server's /downloads route, valid for ttlSeconds. */
    sign(rel: string, ttlSeconds = 3600, now = Date.now()): string {
        const expires = Math.floor(now / 1000) + ttlSeconds;
        const encoded = Buffer.from(rel, 'utf8').toString('base64url');
        return `/downloads/${encoded}/${expires}/${this.mac(rel, expires)}/${encodeURIComponent(path.basename(rel))}`;
    }

    /** Checks a /downloads path and returns the file it points to (relative to the workspaces folder). */
    verify(urlPath: string, now = Date.now()): { rel: string } | { error: string } {
        const m = /^\/downloads\/([A-Za-z0-9_-]+)\/(\d+)\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(urlPath);
        if (!m) return { error: 'Not found' };
        const rel = Buffer.from(m[1], 'base64url').toString('utf8');
        const expires = Number(m[2]);
        const expected = Buffer.from(this.mac(rel, expires));
        const given = Buffer.from(m[3]);
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { error: 'Invalid link' };
        if (expires < Math.floor(now / 1000)) return { error: 'This download link has expired. Ask TestPilot for a new one.' };
        return { rel };
    }
}

/** Resolves a signed relative path inside the workspaces folder, refusing anything that escapes it. */
export function downloadFile(workspacesDir: string, rel: string): string | undefined {
    const base = realpathSync(workspacesDir);
    const abs = path.resolve(base, rel);
    if (!existsSync(abs)) return undefined;
    const real = realpathSync(abs);
    const inside = path.relative(base, real);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
    return real;
}

// ---- GitHub pull requests -------------------------------------------------------

export interface GitHubSettings {
    token: string;
    api: string;
    /** Owners (users or organisations) TestPilot may open pull requests in. */
    owners: string[];
}

export class DeliveryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeliveryError';
    }
}

type Fetch = typeof fetch;

async function gh<T>(settings: GitHubSettings, doFetch: Fetch, method: string, route: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
        res = await doFetch(`${settings.api.replace(/\/+$/, '')}${route}`, {
            method,
            headers: {
                Authorization: `Bearer ${settings.token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(60_000)
        });
    } catch (error) {
        throw new DeliveryError(`Could not reach GitHub: ${(error as Error).message}.`);
    }
    const text = await res.text();
    if (!res.ok) {
        const message = (() => {
            try {
                return String((JSON.parse(text) as { message?: string }).message ?? '');
            } catch {
                return '';
            }
        })();
        const hint =
            res.status === 401
                ? 'the server\'s GitHub token was rejected (expired or revoked); ask the TestPilot administrator'
                : res.status === 403
                  ? 'the server\'s GitHub token may not write to this repository'
                  : res.status === 404
                    ? 'the repository or branch was not found, or the server\'s GitHub token cannot see it'
                    : res.status === 422
                      ? 'GitHub refused the change'
                      : 'GitHub returned an error';
        throw new DeliveryError(`GitHub answered ${res.status} for ${method} ${route.split('?')[0]}: ${hint}.${message ? ` (${message.slice(0, 200)})` : ''}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
}

export function parseRepository(raw: string): { owner: string; repo: string } {
    const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(raw.trim());
    if (!m) throw new DeliveryError(`"${raw}" is not a repository. Use owner/name, e.g. acme/shop-tests.`);
    return { owner: m[1], repo: m[2] };
}

export function assertOwnerAllowed(settings: GitHubSettings, owner: string): void {
    if (!settings.owners.map(o => o.toLowerCase()).includes(owner.toLowerCase())) {
        throw new DeliveryError(`TestPilot is not allowed to open pull requests in ${owner}. Allowed: ${settings.owners.join(', ') || 'none'} (TESTPILOT_GITHUB_OWNERS).`);
    }
}

export const branchName = (raw: string) => {
    const name = raw.trim();
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes('..') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock')) throw new DeliveryError(`"${raw}" is not a valid branch name.`);
    return name;
};

export interface PullRequestPreview {
    owner: string;
    repo: string;
    base: string;
    baseSha: string;
    existing: string[];
    added: string[];
}

/** Reads the target repository so the preview can say which files are new and which would change. */
export async function previewPullRequest(settings: GitHubSettings, doFetch: Fetch, target: { owner: string; repo: string; base?: string; targetDir: string }, files: WorkspaceFile[]): Promise<PullRequestPreview> {
    assertOwnerAllowed(settings, target.owner);
    const repoInfo = await gh<{ default_branch: string; permissions?: { push?: boolean } }>(settings, doFetch, 'GET', `/repos/${target.owner}/${target.repo}`);
    if (repoInfo.permissions && repoInfo.permissions.push === false) throw new DeliveryError(`The server's GitHub token cannot push to ${target.owner}/${target.repo}.`);
    const base = target.base ?? repoInfo.default_branch;
    const ref = await gh<{ object: { sha: string } }>(settings, doFetch, 'GET', `/repos/${target.owner}/${target.repo}/git/ref/heads/${encodeURIComponent(base)}`);
    const commit = await gh<{ tree: { sha: string } }>(settings, doFetch, 'GET', `/repos/${target.owner}/${target.repo}/git/commits/${ref.object.sha}`);
    const tree = await gh<{ tree: Array<{ path: string; type: string }>; truncated?: boolean }>(settings, doFetch, 'GET', `/repos/${target.owner}/${target.repo}/git/trees/${commit.tree.sha}?recursive=1`);
    const present = new Set(tree.tree.filter(t => t.type === 'blob').map(t => t.path));
    const paths = files.map(f => joinTarget(target.targetDir, f.path));
    return { owner: target.owner, repo: target.repo, base, baseSha: ref.object.sha, existing: paths.filter(p => present.has(p)), added: paths.filter(p => !present.has(p)) };
}

export const joinTarget = (dir: string, rel: string) => (dir ? `${dir.replace(/^\/+|\/+$/g, '')}/${rel}` : rel);

export async function createPullRequest(
    settings: GitHubSettings,
    doFetch: Fetch,
    preview: PullRequestPreview,
    request: { branch: string; title: string; body: string; message: string; targetDir: string; files: WorkspaceFile[] }
): Promise<{ url: string; number: number; branch: string }> {
    const { owner, repo } = preview;
    const blobs: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
    for (const file of request.files) {
        const blob = await gh<{ sha: string }>(settings, doFetch, 'POST', `/repos/${owner}/${repo}/git/blobs`, { content: file.data.toString('base64'), encoding: 'base64' });
        blobs.push({ path: joinTarget(request.targetDir, file.path), mode: '100644', type: 'blob', sha: blob.sha });
    }
    const base = await gh<{ tree: { sha: string } }>(settings, doFetch, 'GET', `/repos/${owner}/${repo}/git/commits/${preview.baseSha}`);
    const tree = await gh<{ sha: string }>(settings, doFetch, 'POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: base.tree.sha, tree: blobs });
    const commit = await gh<{ sha: string }>(settings, doFetch, 'POST', `/repos/${owner}/${repo}/git/commits`, { message: request.message, tree: tree.sha, parents: [preview.baseSha] });
    try {
        await gh(settings, doFetch, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${request.branch}`, sha: commit.sha });
    } catch (error) {
        if (error instanceof DeliveryError && /422/.test(error.message)) throw new DeliveryError(`The branch ${request.branch} already exists in ${owner}/${repo}. Pick another branch name.`);
        throw error;
    }
    const open = (draft: boolean) => gh<{ html_url: string; number: number }>(settings, doFetch, 'POST', `/repos/${owner}/${repo}/pulls`, { title: request.title, head: request.branch, base: preview.base, body: request.body, draft });
    let pr: { html_url: string; number: number };
    try {
        pr = await open(true);
    } catch (error) {
        // Draft pull requests are not available on every plan; fall back to a normal one.
        if (!(error instanceof DeliveryError && /422/.test(error.message) && /draft/i.test(error.message))) throw error;
        pr = await open(false);
    }
    return { url: pr.html_url, number: pr.number, branch: request.branch };
}
