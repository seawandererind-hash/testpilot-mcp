import { readFileSync } from 'node:fs';
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
    if (!config.stack.framework?.startsWith('playwright')) return { error: `Pipeline templates cover Playwright today. For ${config.stack.framework}, adapt the run command from AGENTS.md.` };
    const keys = keysFor(integrationsFor(config)).filter(k => !['APPIUM_SERVER_URL'].includes(k.name));
    const secrets = keys.filter(k => k.secret).map(k => k.name);
    const variables = keys.filter(k => !k.secret).map(k => k.name);
    const testRoot = config.project.testRoot && config.project.testRoot !== '.' ? config.project.testRoot.replace(/\/+$/, '') : '.';
    const browsers = config.execution.browsers?.length ? config.execution.browsers : ['chromium'];
    let playwrightVersion = '1.64.0';
    try {
        playwrightVersion = loadPack('playwright-ts').devDependencies['@playwright/test'] ?? playwrightVersion;
    } catch {
        // keep the default
    }
    const ctx = {
        header: CREATED_HEADER,
        secrets,
        variables,
        allKeys: [...variables, ...secrets],
        githubEnv: [...variables.map(v => `${v}: \${{ vars.${v} }}`), ...secrets.map(s => `${s}: \${{ secrets.${s} }}`)],
        testRoot,
        testRootIsSub: testRoot !== '.',
        testRootPrefix: testRoot === '.' ? '' : `${testRoot}/`,
        browserList: browsers.join(' '),
        playwrightVersion
    };
    const content = Handlebars.compile(readTemplate(path.join(TEMPLATES_DIR, 'ci', spec.template)), { noEscape: true })(ctx);
    return { provider, file: compareWithDisk(store, spec.target, content), secrets, variables, where: spec.where };
}
