import { readFileSync } from 'node:fs';
import path from 'node:path';

import Handlebars from 'handlebars';

import { APP_TYPE_OPTIONS, CI_OPTIONS, EXECUTION_OPTIONS, findFramework, LANGUAGE_LABELS, PATTERN_OPTIONS, TEST_CASE_SOURCE_OPTIONS } from '../catalog/frameworks.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { GENERATED_HEADER, inTestRoot, type PlannedFile, TEMPLATES_DIR } from '../scaffold/engine.js';

const KNOWLEDGE_DIR = path.join(TEMPLATES_DIR, 'knowledge');
const hb = Handlebars.create();
hb.registerHelper('inc', (n: number) => n + 1);

interface ClientMap {
    skills: { canonical: string; mirrors: string[] };
    mcpConfigs: Array<{ file: string; key: string; clients: string[]; entry: Record<string, unknown> }>;
}

export function loadClientMap(): ClientMap {
    return JSON.parse(readFileSync(path.join(KNOWLEDGE_DIR, 'client-map.json'), 'utf8')) as ClientMap;
}

function render(file: string, ctx: Record<string, unknown>): string {
    return hb.compile(readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8'), { noEscape: true })(ctx);
}

const label = (options: Array<{ value: string; label: string }>, value: string | undefined, fallback = 'not chosen yet') => (value ? (options.find(o => o.value === value)?.label ?? value) : fallback);

/** Facts about the configured stack, shared by every generated document. */
export function knowledgeContext(config: Config, packageName: string): Record<string, unknown> {
    const fw = config.stack.framework ?? '';
    const isPlaywright = fw.startsWith('playwright');
    const isAppium = fw.startsWith('appium') || fw === 'webdriverio-appium';
    const lang = config.stack.language ?? 'typescript';
    const ext = { typescript: 'ts', javascript: 'js', java: 'java', python: 'py', csharp: 'cs', kotlin: 'kt', swift: 'swift' }[lang] ?? 'ts';
    const pagesDir = inTestRoot(config, isAppium ? 'src/screens' : 'src/pages');
    const testsDir = inTestRoot(config, isAppium ? 'test/specs' : 'tests');
    const runCommand = isPlaywright ? 'npx playwright test' : isAppium ? 'npx wdio run wdio.conf.ts' : 'see the framework docs';
    const frameworkLabel = (config.appType && findFramework(config.appType, fw)?.label) || fw || 'the chosen framework';
    const testIdAttribute = isAppium ? 'accessibility id (testID / contentDescription)' : 'data-testid';
    const locatorOrder = isAppium ? 'accessibility id (`~id`) → resource-id / name → class chain or UiAutomator selector → XPath (last resort)' : 'getByRole → getByLabel → getByTestId → getByText → CSS (last resort); never XPath';
    const reporting = new Set(config.integrations.reporting ?? []);
    const rules = [
        `Use the ${config.stack.pattern === 'bdd' ? 'feature files plus step definitions with page objects' : 'page objects'} in \`${pagesDir}\`; tests never use raw selectors.`,
        'Name each test "<test-case id> <title>" and tag it with the id so results trace back to the source.',
        'One behaviour per test; every expected result becomes an assertion.',
        'Test data from test-data/, secrets from environment variables (.env). Nothing hard-coded.',
        'Tests must pass when run alone, in any order, and in parallel.',
        'A new or changed test is done after it passes twice in a row.'
    ];
    const commands = isPlaywright
        ? [
              { what: 'Everything', cmd: 'npx playwright test' },
              { what: 'Smoke tests', cmd: 'npx playwright test --grep @smoke' },
              { what: 'One test case', cmd: 'npx playwright test --grep SHOP-123' },
              { what: 'Watch it run', cmd: 'npx playwright test --headed' },
              { what: 'Open the report', cmd: 'npx playwright show-report' }
          ]
        : isAppium
          ? [
                { what: 'Start Appium (local runs)', cmd: 'npx appium' },
                { what: 'Everything', cmd: 'npx wdio run wdio.conf.ts' },
                { what: 'Smoke tests', cmd: 'npx wdio run wdio.conf.ts --mochaOpts.grep @smoke' },
                { what: 'One test case', cmd: 'npx wdio run wdio.conf.ts --mochaOpts.grep SHOP-123' },
                ...(config.execution.target === 'browserstack' ? [{ what: 'On BrowserStack', cmd: 'npx wdio run wdio.browserstack.conf.ts' }] : [])
            ]
          : [{ what: 'Run tests', cmd: 'see the framework documentation' }];
    const folders = [
        { path: pagesDir, what: isAppium ? 'screen objects, one per app screen' : 'page objects, one per screen' },
        { path: testsDir, what: 'test specs, one file per test case, named after its id' },
        { path: inTestRoot(config, 'test-data'), what: 'test data as JSON (no secrets)' },
        { path: 'plans/automation-plan.md', what: 'what is automated, in which wave, and why' },
        { path: '.testpilot/', what: 'TestPilot state: choices, progress, imported test cases, reviews, run summaries' },
        { path: '.env.example', what: 'the credential keys; copy to .env and fill in' }
    ];
    return {
        generatedHeader: GENERATED_HEADER,
        packageName,
        appTypeLabel: label(APP_TYPE_OPTIONS, config.appType),
        appRef: config.app.ref,
        frameworkLabel,
        languageLabel: LANGUAGE_LABELS[lang] ?? lang,
        buildTool: config.stack.buildTool ?? 'npm',
        patternLabel: label(PATTERN_OPTIONS, config.stack.pattern, 'Page Object Model'),
        targetLabel: label(EXECUTION_OPTIONS, config.execution.target, 'this computer'),
        sourceLabel: label(TEST_CASE_SOURCE_OPTIONS, config.integrations.testCaseSource, 'not chosen yet'),
        source: config.integrations.testCaseSource,
        ciLabel: label(CI_OPTIONS, config.integrations.ci, 'none yet'),
        reportingList: [...reporting].join(', ') || 'HTML',
        reporting: { junit: reporting.has('junit'), allure: reporting.has('allure') },
        isPlaywright,
        isAppium,
        ext,
        pagesDir,
        testsDir,
        runCommand,
        reportCommand: isPlaywright ? 'npx playwright show-report' : 'npx allure open',
        runOneCommand: isPlaywright ? '`npx playwright test --grep <ID>`' : isAppium ? '`npx wdio run wdio.conf.ts --mochaOpts.grep <ID>`' : 'your runner\'s filter option',
        repeatCommand: isPlaywright ? '`npx playwright test --grep <ID> --repeat-each 10`' : 'run it 10 times in a loop',
        sleepName: isPlaywright ? 'page.waitForTimeout' : isAppium ? 'browser.pause' : 'Thread.sleep / time.sleep',
        stableRuns: 'two',
        testIdAttribute,
        locatorOrder,
        locatorRules: locatorOrder.split(' → '),
        rules,
        commands,
        folders,
        globs: `${testsDir}/**,${pagesDir}/**,${inTestRoot(config, 'test-data')}/**`
    };
}

const SOURCE_HOWTO: Record<string, { howTo: string; needsLocation: boolean }> = {
    jira: { howTo: 'Write the JQL that selects the cases, e.g. `project = SHOP AND labels = regression`. Credentials: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env.', needsLocation: true },
    xray: { howTo: 'Write the JQL that selects the Xray Test issues, e.g. `project = SHOP AND issuetype = Test`. Credentials: Jira keys plus XRAY_CLIENT_ID and XRAY_CLIENT_SECRET in .env.', needsLocation: true },
    zephyr: { howTo: 'Note the Jira project key that holds the Zephyr test cases. Credentials: ZEPHYR_API_TOKEN in .env.', needsLocation: true },
    browserstack: { howTo: 'Note the BrowserStack Test Management project id (e.g. PR-1). Credentials: BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY.', needsLocation: true },
    testrail: { howTo: 'Note the TestRail project id (and suite id if the project uses suites). Credentials: TESTRAIL_URL, TESTRAIL_USER, TESTRAIL_API_KEY.', needsLocation: true },
    'azure-devops': { howTo: 'Note the test plan id (and suite id if needed). Credentials: AZDO_ORG_URL, AZDO_PROJECT, AZDO_PAT.', needsLocation: true },
    excel: { howTo: 'Put the .xlsx file in the repository (e.g. `test-cases/regression.xlsx`). One row per case or one row per step both work; columns are matched by name (ID, Title, Steps, Expected Result, Priority, …).', needsLocation: true },
    csv: { howTo: 'Put the .csv file in the repository. Columns are matched by name (ID, Title, Steps, Expected Result, Priority, …).', needsLocation: true },
    word: { howTo: 'Put the .docx file in the repository. Test cases should be in tables with a header row (ID, Title, Steps, Expected Result).', needsLocation: true },
    gherkin: { howTo: 'Point to a .feature file or a folder of them. Each Scenario becomes a test case; tags such as @SHOP-123 become its id.', needsLocation: true },
    markdown: { howTo: 'Write each case as a `## ID: Title` heading followed by numbered steps; lines starting with "Expected:" are expected results.', needsLocation: true }
};

/** Every instruction, skill, rule and MCP config file TestPilot keeps in the repository. */
export function planKnowledge(store: ProjectStore, config: Config, packageName: string): PlannedFile[] {
    const ctx = knowledgeContext(config, packageName);
    const files: PlannedFile[] = [];
    const map = loadClientMap();

    files.push(ownedMarkdown(store, 'AGENTS.md', render('AGENTS.md.hbs', ctx)));
    files.push(planClaudeMd(store));
    files.push(ownedMarkdown(store, 'docs/automation-workflow.md', render('workflow.md.hbs', ctx)));
    files.push(ownedMarkdown(store, '.cursor/rules/testpilot.mdc', render('cursor-rule.mdc.hbs', ctx)));
    files.push(ownedMarkdown(store, '.agents/rules/testpilot.md', render('antigravity-rule.md.hbs', ctx)));
    files.push(ownedMarkdown(store, '.github/copilot-instructions.md', render('copilot-instructions.md.hbs', ctx)));

    for (const skill of skillsFor(config, ctx)) {
        for (const dir of [map.skills.canonical, ...map.skills.mirrors]) {
            files.push(ownedMarkdown(store, `${dir}/${skill.name}/SKILL.md`, skill.content));
        }
    }
    for (const mcp of map.mcpConfigs) files.push(planMcpConfig(store, mcp, packageName));
    return files;
}

function skillsFor(config: Config, ctx: Record<string, unknown>): Array<{ name: string; content: string }> {
    const fw = (config.stack.framework ?? 'framework').replace(/^appium-.*/, 'appium').replace(/^playwright-.*/, 'playwright').replace(/-appium$/, '');
    const target = config.execution.target ?? 'local';
    const skills: Array<{ name: string; file: string; extra?: Record<string, unknown> }> = [
        { name: `write-${slug(fw)}-test`, file: 'write-test.md.hbs' },
        { name: 'create-page-object', file: 'create-page-object.md.hbs' },
        { name: 'add-test-data', file: 'add-test-data.md.hbs' },
        { name: 'debug-flaky-test', file: 'debug-flaky-test.md.hbs' },
        {
            name: `run-tests-${slug(target)}`,
            file: 'run-tests.md.hbs',
            extra: {
                targetPhrase: target === 'local' ? 'on this computer' : `on ${target}`,
                isBrowserStack: target === 'browserstack',
                resultsWhere: ctx.isPlaywright
                    ? 'HTML report in playwright-report/, JSON in test-results/results.json, JUnit in test-results/junit.xml'
                    : ctx.isAppium
                      ? 'JSON in test-results/testpilot/, JUnit in test-results/junit-*.xml, failure screenshots in test-results/screenshots/'
                      : 'the reporter output configured in the runner'
            }
        },
        { name: 'review-test-case', file: 'review-test-case.md.hbs' },
        { name: 'update-automation-plan', file: 'update-automation-plan.md.hbs' }
    ];
    const source = config.integrations.testCaseSource;
    if (source && source !== 'none') {
        const how = SOURCE_HOWTO[source] ?? { howTo: 'Find where the cases are stored.', needsLocation: true };
        skills.push({ name: `import-test-cases-${slug(source)}`, file: 'import-test-cases.md.hbs', extra: { sourceHowTo: how.howTo, sourceNeedsLocation: how.needsLocation } });
    }
    return skills.map(s => ({ name: s.name, content: render(`skills/${s.file}`, { ...ctx, ...s.extra, skillName: s.name }) }));
}

function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tests';
}

const KEEP = /<!-- keep -->[\s\S]*?<!-- \/keep -->/g;

/**
 * Generated Markdown: regenerated freely while it carries TestPilot's header,
 * keeping anything between keep markers; a file without the header belongs to the user and is left alone.
 */
export function ownedMarkdown(store: ProjectStore, target: string, fresh: string): PlannedFile {
    const current = store.read(target);
    if (current === undefined) return { path: target, status: 'new', content: fresh };
    if (!current.includes(GENERATED_HEADER)) return { path: target, status: 'skip', content: fresh, note: 'You wrote this file yourself, so TestPilot leaves it alone.' };
    const kept = current.match(KEEP) ?? [];
    let i = 0;
    const merged = fresh.replace(KEEP, block => kept[i++] ?? block);
    return current === merged ? { path: target, status: 'unchanged', content: merged } : { path: target, status: 'merge', content: merged, note: 'Regenerated; your notes between keep markers are kept.' };
}

function planClaudeMd(store: ProjectStore): PlannedFile {
    const current = store.read('CLAUDE.md');
    if (current === undefined) return { path: 'CLAUDE.md', status: 'new', content: '@AGENTS.md\n' };
    if (/^@AGENTS\.md\s*$/m.test(current)) return { path: 'CLAUDE.md', status: 'unchanged', content: current };
    return { path: 'CLAUDE.md', status: 'merge', content: `${current.replace(/\s*$/, '\n')}\n@AGENTS.md\n`, note: 'Adds an import of AGENTS.md (Claude Code ignores AGENTS.md when CLAUDE.md exists).' };
}

function planMcpConfig(store: ProjectStore, mcp: ClientMap['mcpConfigs'][number], packageName: string): PlannedFile {
    const current = store.read(mcp.file);
    let json: Record<string, Record<string, unknown>> = {};
    if (current) {
        try {
            json = JSON.parse(current);
        } catch {
            return { path: mcp.file, status: 'skip', content: current, note: 'Not valid JSON, so TestPilot left it alone. Add the testpilot server by hand (see README).' };
        }
    }
    json[mcp.key] ??= {};
    if (json[mcp.key].testpilot) return { path: mcp.file, status: 'unchanged', content: current! };
    json[mcp.key].testpilot = JSON.parse(JSON.stringify(mcp.entry).replace(/\{\{package\}\}/g, packageName));
    const content = JSON.stringify(json, null, 2) + '\n';
    return current ? { path: mcp.file, status: 'merge', content, note: `Adds the testpilot server for ${mcp.clients.join(', ')}.` } : { path: mcp.file, status: 'new', content, note: `So ${mcp.clients.join(', ')} start TestPilot in this repo.` };
}
