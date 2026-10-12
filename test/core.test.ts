import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { keysFor } from '../src/catalog/env-keys.js';
import { classifyAppRef } from '../src/core/app-target.js';
import { issueConfirmation, verifyConfirmation } from '../src/core/confirm.js';
import { detectRepo } from '../src/core/detect.js';
import { checkEnv, parseDotenv, writeEnvTemplate } from '../src/core/env.js';
import { PathSandboxError, ProjectRootError, resolveProjectRoot, safeJoin } from '../src/core/paths.js';
import { redact, redactString } from '../src/core/redact.js';
import { ProjectStore } from '../src/core/store.js';
import { answerStep, currentStepId, resetToStep } from '../src/core/wizard.js';
import { tempRepo } from './helpers.js';

describe('path sandbox', () => {
    it('refuses paths that leave the project', () => {
        const root = tempRepo();
        expect(() => safeJoin(root, '../outside.txt')).toThrow(PathSandboxError);
        expect(() => safeJoin(root, '/etc/passwd')).toThrow(PathSandboxError);
        expect(safeJoin(root, 'tests/a.spec.ts')).toBe(path.join(root, 'tests/a.spec.ts'));
    });

    it('refuses symlinks that point outside', () => {
        const root = tempRepo();
        const outside = path.join(tmpdir(), `tp-outside-${Date.now()}`);
        mkdirSync(outside);
        symlinkSync(outside, path.join(root, 'link'));
        expect(() => safeJoin(root, 'link/file.txt')).toThrow(PathSandboxError);
    });

    it('needs an explicit root when the folder is not a project', () => {
        const empty = path.join(tmpdir(), `tp-empty-${Date.now()}`);
        mkdirSync(empty);
        expect(() => resolveProjectRoot(undefined, {}, empty)).toThrow(ProjectRootError);
        expect(resolveProjectRoot(empty, {}, '/')).toContain('tp-empty');
    });
});

describe('redaction', () => {
    it('removes tokens and secret-looking keys', () => {
        expect(redactString('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
        expect(redactString('JIRA_API_TOKEN=ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz')).not.toContain('ATATT3');
        expect(redactString('https://user:hunter2@example.com')).not.toContain('hunter2');
        expect(redact({ password: 'x', nested: { apiKey: 'y', name: 'ok' } })).toEqual({ password: '[REDACTED]', nested: { apiKey: '[REDACTED]', name: 'ok' } });
    });
});

describe('.env handling', () => {
    it('parses dotenv files', () => {
        const map = parseDotenv('# c\nA=1\nexport B="two words"\nC=x # trailing\n');
        expect(map.get('A')).toBe('1');
        expect(map.get('B')).toBe('two words');
        expect(map.get('C')).toBe('x');
    });

    it('writes .env.example without values and git-ignores .env', () => {
        const store = new ProjectStore(tempRepo({ '.env.example': 'MY_OWN=keep\n' }));
        const { added } = writeEnvTemplate(store, keysFor(['app', 'jira']));
        expect(added).toContain('JIRA_API_TOKEN');
        const example = store.read('.env.example')!;
        expect(example).toContain('MY_OWN=keep');
        expect(example).toMatch(/^JIRA_API_TOKEN=$/m);
        expect(store.read('.gitignore')).toContain('.env');
        expect(writeEnvTemplate(store, keysFor(['app', 'jira'])).added).toHaveLength(0);
    });

    it('reports presence and format but never values', () => {
        const store = new ProjectStore(tempRepo({ '.env': 'JIRA_BASE_URL=not-a-url\nJIRA_EMAIL=a@b.co\nJIRA_API_TOKEN=supersecretvalue\n' }));
        const outcome = checkEnv(store, keysFor(['jira']), {});
        expect(JSON.stringify(outcome)).not.toContain('supersecretvalue');
        expect(outcome.checks.find(c => c.key === 'JIRA_BASE_URL')?.status).toBe('invalid-format');
        expect(outcome.checks.find(c => c.key === 'JIRA_API_TOKEN')?.status).toBe('present');
        expect(outcome.ok).toBe(false);
    });
});

describe('repo detection', () => {
    it('finds frameworks, languages and CI', () => {
        const root = tempRepo({ 'tests/login.spec.ts': 'x', '.github/workflows/ci.yml': 'on: push', 'pom.xml': '<artifactId>selenium-java</artifactId>' });
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', devDependencies: { '@playwright/test': '1.64.0' } }));
        const d = detectRepo(root);
        expect(d.testFrameworks.map(f => f.name)).toEqual(expect.arrayContaining(['playwright', 'selenium']));
        expect(d.languages[0].language).toBe('typescript');
        expect(d.ci).toContain('github-actions');
        expect(d.existingTestDirs).toContain('tests');
    });
});

describe('app references', () => {
    it('classifies URLs, files and ids', () => {
        expect(classifyAppRef('https://staging.shop.example.com', 'web').kind).toBe('url');
        expect(classifyAppRef('https://shop.example.com', 'web').note).toContain('production');
        expect(classifyAppRef('apps/app-debug.apk', 'android').kind).toBe('apk');
        expect(classifyAppRef('bs://abc123', 'android').kind).toBe('cloud-id');
        expect(classifyAppRef('com.example.shop', 'ios').kind).toBe('bundle-id');
        expect(classifyAppRef("I don't have one", 'android').kind).toBe('help');
    });
});

describe('wizard state machine', () => {
    it('saves answers, skips irrelevant steps and can go back', () => {
        const store = new ProjectStore(tempRepo());
        const d = detectRepo(store.root);
        answerStep(store, d, 'APP_TYPE', 'web');
        const next = answerStep(store, d, 'FRAMEWORK', 'playwright').next!;
        expect(next.step).toBe('LANGUAGE');
        expect(next.recommended).toBe('typescript');
        answerStep(store, d, 'LANGUAGE', 'typescript');
        expect(store.readConfig().stack.templatePack).toBe('playwright-ts');
        expect(store.read('.testpilot/decisions.md')).toContain('Framework: Playwright');
        resetToStep(store, 'FRAMEWORK');
        expect(currentStepId({ config: store.readConfig(), state: store.readState(), detection: d })).toBe('FRAMEWORK');
        expect(store.readState().completed).toEqual(['APP_TYPE']);
    });

    it('asks about extending when a framework already exists', () => {
        const root = tempRepo({ 'playwright.config.ts': 'export default {}' });
        const store = new ProjectStore(root);
        const d = detectRepo(root);
        const { next } = answerStep(store, d, 'APP_TYPE', 'web');
        expect(next?.step).toBe('EXISTING');
    });
});

describe('confirm tokens', () => {
    it('only accept the digest the preview showed', () => {
        const store = new ProjectStore(tempRepo());
        const token = issueConfirmation(store, 'scaffold', 'abc');
        expect(verifyConfirmation(store, 'scaffold', token, 'abc').ok).toBe(true);
        expect(verifyConfirmation(store, 'scaffold', token, 'changed').ok).toBe(false);
        expect(verifyConfirmation(store, 'scaffold', undefined, 'abc').ok).toBe(false);
    });
});
