// Makes the CLI entry executable after tsc (npm also does this on install).
import { chmodSync, existsSync } from 'node:fs';
if (existsSync('dist/index.js')) chmodSync('dist/index.js', 0o755);
