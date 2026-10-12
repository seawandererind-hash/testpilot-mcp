#!/usr/bin/env node
// Bundles the TestPilot server into plugins/testpilot/server/ so the Cursor and Claude Code plugin
// starts it with `node`, fetching nothing at run time. Runs from `npm version`, so the committed
// bundle always matches the latest release.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'plugins/testpilot/server');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
    entryPoints: [path.join(root, 'src/index.ts')],
    outfile: path.join(out, 'testpilot.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Readable on purpose: reviewers and users can read exactly what runs.
    minify: false,
    legalComments: 'linked',
    logLevel: 'warning',
    banner: { js: "import { createRequire as __testpilotRequire } from 'node:module';\nconst require = __testpilotRequire(import.meta.url);" }
});

cpSync(path.join(root, 'templates'), path.join(out, 'templates'), { recursive: true });
writeFileSync(
    path.join(out, 'package.json'),
    JSON.stringify(
        {
            name: pkg.name,
            version: pkg.version,
            description: 'TestPilot MCP server bundled for the plugin. Built from src/ by scripts/build-plugin.mjs; do not edit.',
            license: pkg.license,
            type: 'module',
            private: true,
            testpilot: pkg.testpilot
        },
        null,
        2
    ) + '\n'
);
console.log(`Bundled TestPilot ${pkg.version} into ${path.relative(root, out)}.`);
