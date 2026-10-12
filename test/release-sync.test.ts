import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('release links and plugin manifests', () => {
    it('all point at the version in package.json', () => {
        const run = spawnSync(process.execPath, ['scripts/sync-version.mjs', '--check'], { cwd: root, encoding: 'utf8' });
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
    });

    it('lists the plugin in both marketplaces under the same name as its manifests', () => {
        const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
        for (const market of ['.cursor-plugin/marketplace.json', '.claude-plugin/marketplace.json']) {
            expect(read(market).plugins.map((p: { name: string }) => p.name)).toEqual(['testpilot']);
        }
        expect(read('plugins/testpilot/.cursor-plugin/plugin.json').name).toBe('testpilot');
        expect(read('plugins/testpilot/.claude-plugin/plugin.json').name).toBe('testpilot');
        expect(readFileSync(path.join(root, 'plugins/testpilot/skills/testpilot/SKILL.md'), 'utf8')).toMatch(/^---\nname: testpilot\ndescription: .+\n---/);
    });
});
