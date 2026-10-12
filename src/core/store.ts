import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { safeJoin, STATE_DIR, toPosix } from './paths.js';
import { redact } from './redact.js';
import { type Config, ConfigSchema, CONFIG_SCHEMA_VERSION, type State, StateSchema, STATE_SCHEMA_VERSION, type TestCase, TestCaseSchema } from './schema.js';

export const CONFIG_FILE = `${STATE_DIR}/config.yaml`;
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const DECISIONS_FILE = `${STATE_DIR}/decisions.md`;
export const AUDIT_FILE = `${STATE_DIR}/audit.log.jsonl`;
export const CASES_RAW_DIR = `${STATE_DIR}/test-cases/raw`;
export const CASES_DIR = `${STATE_DIR}/test-cases/normalized`;
export const REVIEWS_DIR = `${STATE_DIR}/reviews`;
export const EXPLORATION_DIR = `${STATE_DIR}/exploration`;
export const RUNS_DIR = `${STATE_DIR}/runs`;
export const PLAN_FILE = 'plans/automation-plan.md';

const now = () => new Date().toISOString();

/**
 * Every read and write TestPilot makes inside a user's repository goes through
 * this class, so each path is sandboxed to the project root.
 */
export class ProjectStore {
    constructor(readonly root: string) {}

    resolve(relative: string): string {
        return safeJoin(this.root, relative);
    }

    /** Repository-relative POSIX path of an absolute path inside the root. */
    relative(absolute: string): string {
        return toPosix(path.relative(this.root, absolute));
    }

    exists(relative: string): boolean {
        return existsSync(this.resolve(relative));
    }

    read(relative: string): string | undefined {
        const file = this.resolve(relative);
        return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    }

    readBuffer(relative: string): Buffer {
        return readFileSync(this.resolve(relative));
    }

    /** Writes atomically (temp file + rename) after creating parent folders. */
    write(relative: string, content: string | Buffer): void {
        const file = this.resolve(relative);
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, content);
        renameSync(tmp, file);
    }

    remove(relative: string): void {
        rmSync(this.resolve(relative), { force: true });
    }

    append(relative: string, content: string): void {
        const file = this.resolve(relative);
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, content);
    }

    list(relativeDir: string, filter: (name: string) => boolean = () => true): string[] {
        const dir = this.resolve(relativeDir);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
        return readdirSync(dir)
            .filter(filter)
            .sort()
            .map(name => toPosix(path.join(relativeDir, name)));
    }

    // ---- config.yaml -------------------------------------------------------

    hasConfig(): boolean {
        return this.exists(CONFIG_FILE);
    }

    readConfig(): Config {
        const raw = this.read(CONFIG_FILE);
        const parsed = raw ? (YAML.parse(raw) ?? {}) : {};
        return ConfigSchema.parse(migrateConfig(parsed));
    }

    writeConfig(config: Config): void {
        const header = '# Generated and maintained by TestPilot MCP. Safe to edit; never put secrets here.\n';
        this.write(CONFIG_FILE, header + YAML.stringify(ConfigSchema.parse(config)));
    }

    updateConfig(mutate: (config: Config) => void): Config {
        const config = this.readConfig();
        mutate(config);
        this.writeConfig(config);
        return config;
    }

    // ---- state.json --------------------------------------------------------

    readState(): State {
        const raw = this.read(STATE_FILE);
        const parsed = raw ? JSON.parse(raw) : { createdAt: now() };
        return StateSchema.parse(migrateState(parsed));
    }

    writeState(state: State): void {
        state.updatedAt = now();
        state.createdAt ??= state.updatedAt;
        this.write(STATE_FILE, JSON.stringify(StateSchema.parse(state), null, 2) + '\n');
    }

    updateState(mutate: (state: State) => void): State {
        const state = this.readState();
        mutate(state);
        this.writeState(state);
        return state;
    }

    // ---- decisions.md and audit log ---------------------------------------

    recordDecision(what: string, why: string, who = 'user'): void {
        if (!this.exists(DECISIONS_FILE)) {
            this.write(
                DECISIONS_FILE,
                '# Decision log\n\nWhat was decided, why, who decided and when. TestPilot appends to this file; you can add notes too.\n\n| When | Decision | Why | Who |\n|---|---|---|---|\n'
            );
        }
        const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
        this.append(DECISIONS_FILE, `| ${now()} | ${cell(what)} | ${cell(why)} | ${cell(who)} |\n`);
    }

    audit(tool: string, args: unknown, status: 'ok' | 'error' | 'input_required', detail?: string): void {
        const entry = { ts: now(), tool, args: redact(args), status, ...(detail ? { detail: redact(detail).slice(0, 500) } : {}) };
        try {
            this.append(AUDIT_FILE, JSON.stringify(entry) + '\n');
        } catch {
            // Auditing must never break a tool call (e.g. read-only checkouts).
        }
    }

    // ---- test cases ----------------------------------------------------------

    caseFile(id: string): string {
        return `${CASES_DIR}/${safeFileName(id)}.json`;
    }

    readCases(): TestCase[] {
        return this.list(CASES_DIR, name => name.endsWith('.json')).map(file => TestCaseSchema.parse(JSON.parse(this.read(file)!)));
    }

    readCase(id: string): TestCase | undefined {
        const raw = this.read(this.caseFile(id));
        return raw ? TestCaseSchema.parse(JSON.parse(raw)) : undefined;
    }

    writeCase(testCase: TestCase): void {
        this.write(this.caseFile(testCase.id), JSON.stringify(TestCaseSchema.parse(testCase), null, 2) + '\n');
        this.write(this.caseFile(testCase.id).replace(/\.json$/, '.md'), renderCaseMarkdown(testCase));
    }
}

/** File-system safe version of a test-case id (keeps letters, digits, - and _). */
export function safeFileName(id: string): string {
    return id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'case';
}

export function renderCaseMarkdown(tc: TestCase): string {
    const lines = [`# ${tc.id} · ${tc.title}`, '', `Source: ${tc.source.type}${tc.source.ref ? ` (${tc.source.ref})` : ''} · Priority: ${tc.priority ?? 'not set'} · Area: ${tc.area ?? 'not set'}`, ''];
    if (tc.description) lines.push(tc.description, '');
    if (tc.preconditions.length) lines.push('## Preconditions', '', ...tc.preconditions.map(p => `- ${p}`), '');
    lines.push('## Steps', '', '| # | Action | Data | Expected |', '|---|---|---|---|');
    tc.steps.forEach((s, i) => lines.push(`| ${i + 1} | ${cell(s.action)} | ${cell(s.data ?? '')} | ${cell(s.expected ?? '')} |`));
    if (tc.expected) lines.push('', `**Overall expected result:** ${tc.expected}`);
    if (tc.review) {
        lines.push('', `## Review: ${tc.review.verdict} (${tc.review.score}/100)`, '');
        tc.review.issues.forEach(issue => lines.push(`- ${issue}`));
        if (tc.review.suggestions.length) lines.push('', 'Suggestions:', ...tc.review.suggestions.map(s => `- ${s}`));
    }
    lines.push('', '<!-- generated by TestPilot from the JSON file next to this one -->', '');
    return lines.join('\n');
}

function cell(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
    // Schema version 1 is the first release; future migrations go here.
    return { ...raw, schemaVersion: CONFIG_SCHEMA_VERSION };
}

function migrateState(raw: Record<string, unknown>): Record<string, unknown> {
    return { ...raw, schemaVersion: STATE_SCHEMA_VERSION };
}
