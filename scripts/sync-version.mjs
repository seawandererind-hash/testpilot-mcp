#!/usr/bin/env node
// Points every install link and plugin manifest at the release for the version in package.json.
// (The plugin's own MCP config starts the bundled server; scripts/build-plugin.mjs rebuilds that.)
// Runs automatically from `npm version`; `--check` only reports files that are out of step (used by the tests).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '')?.[1];
if (!slug) throw new Error('package.json repository.url must point at the GitHub repository.');

const version = pkg.version;
const url = `https://github.com/${slug}/releases/download/v${version}/testpilot-mcp-${version}.tgz`;
const server = { command: 'npx', args: ['-y', url] };
const cursorLink = `https://cursor.com/en/install-mcp?name=testpilot&config=${encodeURIComponent(Buffer.from(JSON.stringify(server)).toString('base64'))}`;

const RELEASE_URL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/download\/v[\d.]+[^/\s]*\/testpilot-mcp-[\d.]+[^\s"'`)]*?\.tgz/g;
const CURSOR_LINK = /https:\/\/cursor\.com\/en\/install-mcp\?name=testpilot&config=[A-Za-z0-9%]+/g;

const json = (file, update) => [file, text => JSON.stringify(update(JSON.parse(text)), null, 2) + '\n'];
const links = file => [file, text => text.replace(RELEASE_URL, url).replace(CURSOR_LINK, cursorLink)];

const files = [
    json('package.json', p => ({ ...p, testpilot: { ...p.testpilot, install: url } })),
    json('plugins/testpilot/.cursor-plugin/plugin.json', p => ({ ...p, version })),
    json('plugins/testpilot/.claude-plugin/plugin.json', p => ({ ...p, version })),
    links('README.md'),
    links('docs/install.md'),
    links('plugins/testpilot/README.md')
];

const stale = [];
for (const [file, update] of files) {
    const full = path.join(root, file);
    const before = readFileSync(full, 'utf8');
    const after = update(before);
    if (after === before) continue;
    stale.push(file);
    if (!check) writeFileSync(full, after);
}

if (check && stale.length) {
    console.error(`Out of step with version ${version}: ${stale.join(', ')}. Run node scripts/sync-version.mjs.`);
    process.exit(1);
}
console.log(stale.length ? `Updated ${stale.join(', ')} for ${version}.` : `Everything points at ${version}.`);
