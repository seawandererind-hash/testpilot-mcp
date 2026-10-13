import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

function real(p: string): string {
    try {
        return existsSync(p) ? realpathSync.native(p) : path.join(real(path.dirname(p)), path.basename(p));
    } catch {
        return p;
    }
}

/**
 * Repository-relative POSIX path of an absolute path. Tools such as tsc and Playwright report
 * real paths, which differ from the root when it sits behind a symbolic link (macOS /var is
 * /private/var) or differs in case on Windows, so both sides are compared as real paths too.
 */
export function relativeToRoot(root: string, absolute: string): string {
    let rel = path.relative(root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        const again = path.relative(real(root), real(absolute));
        if (!again.startsWith('..') && !path.isAbsolute(again)) rel = again;
    }
    return rel.split(path.sep).join('/');
}
