import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProjectStore } from '../src/core/store.js';
import { answerWebSetup, connect, tempRepo } from './helpers.js';

describe('a file sitting where a folder is needed', () => {
    it('is shown in the preview, renamed aside on approval, and the framework is created', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        try {
            await answerWebSetup(c, root, { LANGUAGE: 'javascript' });
            // For example Cursor or another tool left a plain file called .cursor in the project.
            writeFileSync(path.join(root, '.cursor'), 'something');
            const preview = await c.call('preview_scaffold');
            expect(preview.isError).toBeFalsy();
            expect(preview.structuredContent.blockers).toEqual([{ file: '.cursor', renameTo: '.cursor.old' }]);
            expect(preview.content[0].text).toContain('renames the file to ".cursor.old"');

            const written = await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken, userApproved: true });
            expect(written.isError).toBeFalsy();
            expect(written.content[0].text).toContain('Renamed the file ".cursor" to ".cursor.old"');
            expect(statSync(path.join(root, '.cursor')).isDirectory()).toBe(true);
            expect(existsSync(path.join(root, '.cursor/rules/testpilot.mdc'))).toBe(true);
            expect(readFileSync(path.join(root, '.cursor.old'), 'utf8')).toBe('something');
        } finally {
            await c.close();
        }
    });

    it('a preview made before the file appeared no longer matches, so nothing is renamed without being shown', async () => {
        const root = tempRepo();
        const c = await connect(root, 'legacy');
        try {
            await answerWebSetup(c, root);
            const preview = await c.call('preview_scaffold');
            writeFileSync(path.join(root, '.cursor'), '');
            const out = await c.call('scaffold_project', { confirmToken: preview.structuredContent.confirmToken, userApproved: true });
            expect(out.isError).toBe(true);
            expect(statSync(path.join(root, '.cursor')).isFile()).toBe(true);
        } finally {
            await c.close();
        }
    });

    it('other writes explain the problem in plain words instead of ENOTDIR', () => {
        const root = tempRepo();
        writeFileSync(path.join(root, '.cursor'), '');
        mkdirSync(path.join(root, 'plans', 'x.md'), { recursive: true });
        const store = new ProjectStore(root);
        expect(() => store.write('.cursor/rules/a.mdc', 'x')).toThrow(/needs a folder called "\.cursor".*rename the file "\.cursor"/s);
        expect(() => store.write('plans/x.md', 'x')).toThrow(/there is a folder with that exact name/);
        expect(store.read('plans/x.md')).toBeUndefined();
    });
});
