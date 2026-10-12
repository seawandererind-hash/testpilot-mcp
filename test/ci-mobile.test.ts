import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { ConfigSchema } from '../src/core/schema.js';
import { ProjectStore } from '../src/core/store.js';
import { planCi } from '../src/report/ci.js';

function configFor(appType: string, framework: string, pack: string, ci: string) {
    return ConfigSchema.parse({ appType, stack: { framework, language: 'typescript', templatePack: pack }, integrations: { ci } });
}

const store = () => new ProjectStore(mkdtempSync(path.join(tmpdir(), 'testpilot-ci-')));

describe('CI pipelines for mobile projects', () => {
    it.each(['github-actions', 'azure-devops', 'gitlab', 'jenkins'])('runs %s on BrowserStack with secrets by name only', provider => {
        const plan = planCi(store(), configFor('android', 'webdriverio-appium', 'appium-ts', provider));
        if ('error' in plan) throw new Error(plan.error);
        const content = plan.file.content;
        expect(content).toContain('npm run test:browserstack');
        expect(content).toContain('@wdio/browserstack-service@');
        expect(content).not.toContain('playwright');
        expect(plan.secrets).toContain('BROWSERSTACK_ACCESS_KEY');
        expect(plan.variables).toEqual(expect.arrayContaining(['BROWSERSTACK_USERNAME', 'BROWSERSTACK_APP_ID']));
        expect(plan.variables).not.toContain('APP_PATH');
        if (provider !== 'jenkins') expect(() => parse(content)).not.toThrow();
    });

    it('keeps Playwright pipelines unchanged in substance', () => {
        const plan = planCi(store(), configFor('web', 'playwright', 'playwright-ts', 'github-actions'));
        if ('error' in plan) throw new Error(plan.error);
        const workflow = parse(plan.file.content);
        const steps = workflow.jobs.test.steps.map((s: { run?: string }) => s.run).filter(Boolean);
        expect(steps).toEqual(['npm ci', 'npx playwright install --with-deps chromium', 'npx playwright test']);
        expect(workflow.name).toBe('UI tests');
    });

    it('explains that desktop apps need a self-hosted runner', () => {
        const plan = planCi(store(), configFor('windows', 'webdriverio-appium', 'appium-ts', 'github-actions'));
        expect('error' in plan && plan.error).toMatch(/self-hosted/);
    });
});
