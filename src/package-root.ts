import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The folder that holds package.json and templates/: the repository, the installed package,
 * or the server bundled inside the Cursor and Claude Code plugin. Found by walking up from this
 * module, so it works whether the code runs from src/, dist/ or a single bundled file.
 */
export const PACKAGE_ROOT: string = (() => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'templates'))) return dir;
        const up = path.dirname(dir);
        if (up === dir) throw new Error('TestPilot could not find its templates folder next to package.json.');
        dir = up;
    }
})();
