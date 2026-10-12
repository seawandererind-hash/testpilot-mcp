import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { name: string; version: string };

export const VERSION: string = pkg.version;

/**
 * The npm name generated MCP configs start (`npx -y <name>`). An organisation that
 * republishes TestPilot under its own scope gets its own name here automatically.
 */
export const PACKAGE_NAME: string = process.env.TESTPILOT_PACKAGE ?? pkg.name;
