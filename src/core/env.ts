import { type EnvKey, isSetting, type KeyFormat } from '../catalog/env-keys.js';
import type { ProjectStore } from './store.js';

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';

/** Lines TestPilot makes sure are in .gitignore. */
export const GITIGNORE_LINES = ['.env', '.env.*', '!.env.example', 'apps/', 'test-results/', 'playwright-report/', 'allure-results/', 'allure-report/', '.features-gen/', 'target/', '.testpilot/tmp/', '.testpilot/tools/'];

/** Minimal dotenv parser: KEY=value, optional quotes, # comments, `export` prefix. */
export function parseDotenv(content: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        out.set(match[1], value);
    }
    return out;
}

/**
 * Adds missing keys to .env.example (never removing the user's own lines) and
 * makes sure .env is git-ignored. Returns which keys were added.
 */
export function writeEnvTemplate(store: ProjectStore, keys: EnvKey[]): { added: string[]; gitignoreUpdated: string[] } {
    const existing = store.read(ENV_EXAMPLE_FILE) ?? '# Copy this file to .env and fill in the values. Never commit .env.\n';
    const present = parseDotenv(existing);
    const blocks: string[] = [];
    const added: string[] = [];
    for (const key of keys) {
        if (present.has(key.name) || new RegExp(`^\\s*#?\\s*${key.name}=`, 'm').test(existing)) continue;
        blocks.push(`# ${key.description}${key.required ? '' : ' (optional)'}\n# Where to get it: ${key.whereToGet}\n${key.name}=`);
        added.push(key.name);
    }
    if (blocks.length) store.write(ENV_EXAMPLE_FILE, `${existing.replace(/\s*$/, '\n')}\n${blocks.join('\n\n')}\n`);
    return { added, gitignoreUpdated: ensureGitignore(store, GITIGNORE_LINES) };
}

export function ensureGitignore(store: ProjectStore, lines: string[]): string[] {
    const current = store.read('.gitignore') ?? '';
    const have = new Set(current.split(/\r?\n/).map(l => l.trim()));
    const missing = lines.filter(line => !have.has(line));
    if (missing.length) {
        const prefix = current && !current.endsWith('\n') ? '\n' : '';
        store.write('.gitignore', `${current}${prefix}${current ? '\n' : ''}# Added by TestPilot MCP\n${missing.join('\n')}\n`);
    }
    return missing;
}

export type KeyStatus = 'present' | 'missing' | 'invalid-format';

export interface EnvCheck {
    key: string;
    required: boolean;
    status: KeyStatus;
    hint?: string;
}

const FORMAT_CHECKS: Record<KeyFormat, (v: string) => boolean> = {
    url: v => {
        try {
            const u = new URL(v);
            return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
            return false;
        }
    },
    email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    nonempty: v => v.trim().length > 0,
    number: v => /^\d+$/.test(v.trim())
};

/**
 * Reports presence and format per key. Values are read here, inside the server,
 * and never returned: the result only says present / missing / invalid-format.
 */
export function checkEnv(store: ProjectStore, keys: EnvKey[], processEnv: NodeJS.ProcessEnv = process.env): { checks: EnvCheck[]; envFileExists: boolean; ok: boolean } {
    const raw = store.read(ENV_FILE);
    const values = raw ? parseDotenv(raw) : new Map<string, string>();
    const example = store.read(ENV_EXAMPLE_FILE);
    const defaults = example ? parseDotenv(example) : new Map<string, string>();
    const checks = keys.map(key => {
        const value = values.get(key.name) || processEnv[key.name] || (key.secret ? undefined : defaults.get(key.name));
        if (value === undefined || value === '') return { key: key.name, required: key.required, status: 'missing' as const, hint: key.whereToGet };
        if (!FORMAT_CHECKS[key.format](value)) return { key: key.name, required: key.required, status: 'invalid-format' as const, hint: `Expected ${key.format === 'url' ? 'a full URL starting with https://' : key.format === 'email' ? 'an email address' : key.format === 'number' ? 'a number' : 'a value'}.` };
        return { key: key.name, required: key.required, status: 'present' as const };
    });
    return { checks, envFileExists: raw !== undefined, ok: checks.every(c => c.status === 'present' || (!c.required && c.status === 'missing')) };
}

/** Loads .env values for the server's own use (connection tests, runs). Never return these. */
export function loadEnvValues(store: ProjectStore, processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const raw = store.read(ENV_FILE);
    const fromFile = raw ? Object.fromEntries([...parseDotenv(raw)].filter(([, v]) => v !== '')) : {};
    // Committed defaults in .env.example count only for settings, never for secrets.
    const example = store.read(ENV_EXAMPLE_FILE);
    const defaults = example ? Object.fromEntries([...parseDotenv(example)].filter(([k, v]) => v !== '' && isSetting(k))) : {};
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(processEnv)) if (typeof v === 'string' && v !== '') merged[k] = v;
    return { ...defaults, ...merged, ...fromFile };
}

/**
 * Sets the committed default of a non-secret setting (such as APP_BASE_URL) in .env.example.
 * Generated configs load .env first and .env.example second, so .env still overrides it.
 */
export function setEnvDefault(store: ProjectStore, name: string, value: string): void {
    if (/[\r\n]/.test(value)) throw new Error('Setting values must be a single line.');
    const current = store.read(ENV_EXAMPLE_FILE) ?? '# Copy this file to .env and fill in the values. Never commit .env.\n';
    const line = new RegExp(`^(\\s*#?\\s*)?${name}=.*$`, 'm');
    const next = line.test(current) ? current.replace(line, `${name}=${value}`) : `${current.replace(/\s*$/, '\n')}${name}=${value}\n`;
    if (next !== current) store.write(ENV_EXAMPLE_FILE, next);
}

/** The address tests will hit: .env, then the environment, then the committed default, then the wizard answer. */
export function resolveBaseUrl(store: ProjectStore, config: { appType?: string; app: { kind?: string; ref?: string } }, processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
    const key = config.appType === 'api' ? 'API_BASE_URL' : 'APP_BASE_URL';
    const fromEnv = store.read(ENV_FILE);
    const example = store.read(ENV_EXAMPLE_FILE);
    return (fromEnv ? parseDotenv(fromEnv).get(key) : undefined) || processEnv[key] || (example ? parseDotenv(example).get(key) : undefined) || (config.app.kind === 'url' ? config.app.ref : undefined);
}
