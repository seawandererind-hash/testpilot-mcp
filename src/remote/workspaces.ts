import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ProjectRootError, STATE_DIR } from '../core/paths.js';

/**
 * In hosted mode every signed-in person gets their own folder of workspaces on the
 * server. A workspace plays the part of the repository: TestPilot writes the
 * framework, plans and tests there, and deliver_project hands it over as a zip or a
 * pull request. Workspaces are addressed by name, never by path.
 */

export const DEFAULT_WORKSPACE = 'default';
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function workspaceName(raw?: string): string {
    const name = (raw ?? '').trim().toLowerCase() || DEFAULT_WORKSPACE;
    if (!NAME.test(name)) {
        throw new ProjectRootError(
            `"${raw}" is not a workspace name. In hosted mode, projectRoot is a short workspace name such as "shop-web" (letters, digits and dashes), not a folder path.`
        );
    }
    return name;
}

/** The person's own folder, created on first use. */
export function userBase(workspacesDir: string, key: string): string {
    if (!/^[a-f0-9]{8,64}$/.test(key)) throw new Error('Invalid user key.');
    const dir = path.join(workspacesDir, key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return realpathSync(dir);
}

/** Resolves a workspace inside the person's folder, creating it unless create is false. */
export function resolveWorkspace(base: string, raw?: string, create = true): string {
    const name = workspaceName(raw);
    const dir = path.join(base, name);
    if (!existsSync(dir)) {
        if (!create) throw new ProjectRootError(`There is no workspace called ${name} yet.`);
        mkdirSync(path.join(dir, STATE_DIR), { recursive: true, mode: 0o700 });
        writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\ntest-results/\nplaywright-report/\n.testpilot/deliveries/\n');
    }
    const real = realpathSync(dir);
    if (path.dirname(real) !== realpathSync(base)) throw new ProjectRootError('That workspace is not inside your own folder.');
    return real;
}

export function listWorkspaces(base: string): Array<{ name: string; modified: string }> {
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory() && NAME.test(d.name))
        .map(d => ({ name: d.name, modified: statSync(path.join(base, d.name)).mtime.toISOString() }))
        .sort((a, b) => b.modified.localeCompare(a.modified));
}
