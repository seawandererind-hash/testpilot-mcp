import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_ROOT } from './package-root.js';

const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    testpilot?: { install?: string };
};

export const VERSION: string = pkg.version;

/**
 * What generated MCP configs start (`npx -y <this>`): the GitHub release tarball of this exact
 * version, set by the release workflow. An organisation that publishes TestPilot to its own
 * registry sets TESTPILOT_PACKAGE (or `testpilot.install` in package.json) to its package name.
 */
export const PACKAGE_NAME: string = process.env.TESTPILOT_PACKAGE ?? pkg.testpilot?.install ?? pkg.name;
