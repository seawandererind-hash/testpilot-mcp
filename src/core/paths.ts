import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** Folder, relative to the project root, where TestPilot keeps its state. */
export const STATE_DIR = '.testpilot';

/** Files whose presence marks a folder as a project root. */
const PROJECT_MARKERS = ['.git', '.testpilot', 'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'requirements.txt'];

export class PathSandboxError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PathSandboxError';
    }
}

export class ProjectRootError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProjectRootError';
    }
}

/** True when the folder contains one of the usual project markers. */
export function looksLikeProject(dir: string): boolean {
    return PROJECT_MARKERS.some(marker => existsSync(path.join(dir, marker)));
}

/**
 * Picks the project root for a tool call.
 *
 * Order: an explicit `projectRoot` argument, then the TESTPILOT_ROOT environment
 * variable, then the server's working directory when it looks like a project.
 * MCP "roots" are deprecated in protocol 2026-07-28, so the root travels as a
 * tool argument instead (see docs/decisions.md D10).
 */
export function resolveProjectRoot(explicit?: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
    const candidate = explicit?.trim() || env.TESTPILOT_ROOT?.trim();
    if (candidate) {
        const abs = path.resolve(cwd, candidate);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
            throw new ProjectRootError(`The project folder "${abs}" does not exist or is not a folder.`);
        }
        return realpathSync(abs);
    }
    if (looksLikeProject(cwd)) return realpathSync(cwd);
    throw new ProjectRootError(
        'I could not tell which project folder to use. Pass `projectRoot` with the absolute path of the repository ' +
            '(or start the server with --root / TESTPILOT_ROOT).'
    );
}

/**
 * Resolves `relative` inside `root` and refuses anything that escapes it,
 * including `..` segments, absolute paths and symlinks that point outside.
 */
export function safeJoin(root: string, relative: string): string {
    if (path.isAbsolute(relative)) {
        throw new PathSandboxError(`Absolute paths are not allowed: ${relative}`);
    }
    const realRoot = realpathSync(root);
    const target = path.resolve(realRoot, relative);
    assertInside(realRoot, target, relative);

    // Walk up to the deepest existing ancestor and make sure its real path is still inside.
    let probe = target;
    while (!existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    assertInside(realRoot, realpathSync(probe), relative);
    return target;
}

function assertInside(root: string, target: string, label: string): void {
    const rel = path.relative(root, target);
    if (rel === '') return;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new PathSandboxError(`"${label}" is outside the project folder, so TestPilot will not touch it.`);
    }
}

/** Project-relative path with forward slashes, for display and for state files. */
export function toPosix(relative: string): string {
    return relative.split(path.sep).join('/');
}
