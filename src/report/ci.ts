import path from 'node:path';

import Handlebars from 'handlebars';

import { integrationsFor, keysFor } from '../catalog/env-keys.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { compareWithDisk, CREATED_HEADER, loadPack, type PlannedFile, readTemplate, TEMPLATES_DIR } from '../scaffold/engine.js';

const CI_FILES: Record<string, { template: string; target: string; where: string }> = {
    'github-actions': { template: 'github-actions.yml.hbs', target: '.github/workflows/ui-tests.yml', where: 'GitHub: Settings → Secrets and variables → Actions' },
    'azure-devops': { template: 'azure-devops.yml.hbs', target: 'azure-pipelines.yml', where: 'Azure DevOps: Pipelines → Library → variable group "testpilot"' },
    gitlab: { template: 'gitlab.yml.hbs', target: '.gitlab-ci.yml', where: 'GitLab: Settings → CI/CD → Variables' },
    jenkins: { template: 'Jenkinsfile.hbs', target: 'Jenkinsfile', where: 'Jenkins: Manage Jenkins → Credentials (Secret text)' }
};

export interface CiPlan {
    provider: string;
    file: PlannedFile;
    secrets: string[];
    variables: string[];
    where: string;
}

/** The pipeline file for the chosen CI, with every .env key mapped to a CI secret or variable. */
export function planCi(store: ProjectStore, config: Config, providerOverride?: string): CiPlan | { error: string } {
    const provider = providerOverride ?? config.integrations.ci;
    if (!provider || provider === 'none') return { error: 'No CI system chosen. Pick one in the wizard (step CI) or pass provider.' };
    const spec = CI_FILES[provider];
    if (!spec) return { error: `TestPilot has no pipeline template for ${provider} yet.` };
    const appium = config.stack.templatePack === 'appium-ts';
    const maven = config.stack.templatePack === 'selenium-java';
    const mobile = appium && ['android', 'ios', 'android-ios', 'hybrid'].includes(config.appType ?? '');
    if (appium && !mobile) {
        return {
            error: 'Desktop app tests need the app installed on the machine that runs them, so hosted CI runners cannot run them. Use a self-hosted Windows or macOS runner that has the app and Appium installed, and run `npm test` there.'
        };
    }
    if (!appium && !maven && !config.stack.framework?.startsWith('playwright')) return { error: `Pipeline templates cover Playwright, Selenium + Java and Appium today. For ${config.stack.framework}, adapt the run command from AGENTS.md.` };
    // Hosted CI runners have no phones, so mobile pipelines run on BrowserStack App Automate real devices.
    const groups = integrationsFor(config);
    if (mobile && !groups.includes('browserstack')) groups.push('browserstack');
    const localOnly = ['APPIUM_SERVER_URL', 'APP_PATH', 'APP_ID', ...(mobile && config.appType !== 'hybrid' ? ['APP_BASE_URL'] : [])];
    const keys = keysFor(groups).filter(k => !localOnly.includes(k.name));
    const secrets = keys.filter(k => k.secret).map(k => k.name);
    const variables = keys.filter(k => !k.secret).map(k => k.name);
    if (config.appType === 'android-ios' || config.appType === 'hybrid') variables.push('MOBILE_PLATFORM');
    const testRoot = config.project.testRoot && config.project.testRoot !== '.' ? config.project.testRoot.replace(/\/+$/, '') : '.';
    const browsers = config.execution.browsers?.length ? config.execution.browsers : ['chromium'];
    let playwrightVersion = '1.64.0';
    let browserstackService = '9.39.4';
    try {
        playwrightVersion = loadPack('playwright-ts').devDependencies['@playwright/test'] ?? playwrightVersion;
        browserstackService = loadPack('appium-ts').optionalDevDependencies?.browserstack?.['@wdio/browserstack-service'] ?? browserstackService;
    } catch {
        // keep the defaults
    }
    const testRootPrefix = testRoot === '.' ? '' : `${testRoot}/`;
    const bdd = config.stack.pattern === 'bdd';
    const tool = maven
        ? {
              title: 'Selenium',
              workflowName: 'UI tests',
              // Maven plus a JDK; Chromium is installed by the setup command (hosted GitHub and Azure runners already have Chrome).
              dockerImage: 'maven:3.9-eclipse-temurin-21',
              dockerArgs: '',
              setupName: 'Install Chromium',
              setupCommand: 'apt-get update -qq && apt-get install -y -qq chromium > /dev/null',
              runCommand: `mvn -B test -DHEADLESS=true${bdd ? '' : ''}`,
              junitFiles: `${testRootPrefix}target/surefire-reports/TEST-*.xml`,
              reportName: 'test-results',
              reportPaths: [`${testRootPrefix}target/testpilot/`, `${testRootPrefix}target/screenshots/`, `${testRootPrefix}target/surefire-reports/`, ...(bdd ? [`${testRootPrefix}target/cucumber-report.html`] : [])]
          }
        : appium
        ? {
              title: 'Appium',
              workflowName: 'Mobile tests',
              dockerImage: 'node:22-bookworm',
              dockerArgs: '',
              setupName: 'Add the BrowserStack service',
              // Projects scaffolded for local runs do not list the service; add it for this run only.
              setupCommand: `npm ls @wdio/browserstack-service >/dev/null 2>&1 || npm install --no-save @wdio/browserstack-service@${browserstackService}`,
              runCommand: 'npm run test:browserstack',
              junitFiles: `${testRootPrefix}test-results/junit-*.xml`,
              reportName: 'test-results',
              reportPaths: [`${testRootPrefix}test-results/`]
          }
        : {
              title: 'Playwright',
              workflowName: 'UI tests',
              dockerImage: `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`,
              dockerArgs: '--ipc=host',
              setupName: 'Install browsers',
              setupCommand: '',
              runCommand: 'npx playwright test',
              junitFiles: `${testRootPrefix}test-results/junit.xml`,
              reportName: 'playwright-report',
              reportPaths: [`${testRootPrefix}playwright-report/`, `${testRootPrefix}test-results/`]
          };
    const ctx = {
        header: CREATED_HEADER,
        secrets,
        variables,
        allKeys: [...variables, ...secrets],
        githubEnv: [...variables.map(v => `${v}: \${{ vars.${v} }}`), ...secrets.map(s => `${s}: \${{ secrets.${s} }}`)],
        testRoot,
        testRootIsSub: testRoot !== '.',
        testRootPrefix,
        browserList: browsers.join(' '),
        playwrightVersion,
        isAppium: appium,
        isMaven: maven,
        // Containers have no Chrome; point Selenium at the Chromium the setup command installs.
        dockerRunCommand: maven ? 'mvn -B test -DHEADLESS=true -DBROWSER_BINARY=/usr/bin/chromium' : tool.runCommand,
        ...tool
    };
    const content = Handlebars.compile(readTemplate(path.join(TEMPLATES_DIR, 'ci', spec.template)), { noEscape: true })(ctx);
    return { provider, file: compareWithDisk(store, spec.target, content), secrets, variables, where: spec.where };
}
