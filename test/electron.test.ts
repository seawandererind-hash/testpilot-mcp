import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigSchema, type TestCase } from '../src/core/schema.js';
import { ProjectStore } from '../src/core/store.js';
import { planPlaywrightTests } from '../src/generate/playwright.js';
import { renderContext, renderTemplate } from '../src/scaffold/engine.js';

const config = ConfigSchema.parse({
    appType: 'electron',
    stack: { framework: 'playwright-electron', language: 'typescript', templatePack: 'playwright-ts' },
    app: { kind: 'electron-path', ref: 'dist/MyApp' }
});

describe('Electron desktop apps', () => {
    it('scaffolds a fixture that launches the app and uses its first window as the page', () => {
        const ctx = renderContext(config);
        const fixtures = renderTemplate('playwright-ts', 'src/fixtures/test.ts.hbs', ctx);
        expect(fixtures).toContain("import { _electron as electron");
        expect(fixtures).toContain("requireEnv('ELECTRON_APP_PATH')");
        expect(fixtures).toContain('electronApp.firstWindow()');
        const basePage = renderTemplate('playwright-ts', 'src/pages/BasePage.ts.hbs', ctx);
        expect(basePage).not.toContain('page.goto');
    });

    it('never navigates by URL inside the app window', () => {
        const store = new ProjectStore(mkdtempSync(path.join(tmpdir(), 'testpilot-electron-')));
        const testCase = {
            id: 'DESK-1',
            title: 'Open the app and see the welcome screen',
            preconditions: [],
            tags: [],
            source: { type: 'excel', ref: 'desktop.xlsx' },
            steps: [
                { action: 'Launch the application', expected: '' },
                { action: 'Navigate to /settings', expected: '' },
                { action: 'Click the Save button', expected: 'Text "Saved" is shown' }
            ]
        } as unknown as TestCase;
        const plan = planPlaywrightTests(store, config, [testCase], []);
        const spec = plan.files.find(f => f.path.endsWith('DESK-1.spec.ts'));
        expect(spec?.content).toContain('The electronApp fixture has already opened the app window.');
        expect(spec?.content).toContain("TODO(testpilot): reach /settings through the app's menus");
        expect(spec?.content).not.toContain('page.goto');
    });
});
