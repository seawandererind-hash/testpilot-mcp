import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { planCi } from '../report/ci.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot } from '../scaffold/engine.js';
import { type CapabilityPlan, emptyPlan, type PlanOutcome, playwrightLang } from './shared.js';

export const FAST_WORKFLOW = '.github/workflows/ui-tests-pr.yml';

export interface CiSpeedOptions {
    shards: number;
    testRoot: string;
    browsers: string[];
    variables: string[];
    secrets: string[];
}

/** The GitHub Actions workflow: changed tests + smoke on pull requests, a sharded full run on main and nightly. */
export function fastWorkflow(o: CiSpeedOptions): string {
    const sub = o.testRoot !== '.';
    const prefix = sub ? `${o.testRoot}/` : '';
    const shardList = Array.from({ length: o.shards }, (_, i) => i + 1).join(', ');
    const env = [...o.variables.map(v => `${v}: \${{ vars.${v} }}`), ...o.secrets.map(s => `${s}: \${{ secrets.${s} }}`)];
    const envBlock = env.length ? ['    env:', ...env.map(e => `      ${e}`)] : [];
    const defaults = sub ? ['    defaults:', '      run:', `        working-directory: ${o.testRoot}`] : [];
    const setup = (fetchDepth: boolean, browsers: boolean) => [
        '      - uses: actions/checkout@v5',
        ...(fetchDepth ? ['        with:', '          # Full history, so Playwright can compare this branch with the base branch.', '          fetch-depth: 0'] : []),
        '      - uses: actions/setup-node@v5',
        '        with:',
        '          node-version: 22',
        '          cache: npm',
        ...(sub ? [`          cache-dependency-path: ${o.testRoot}/package-lock.json`] : []),
        '      - name: Install dependencies',
        '        run: npm ci',
        ...(browsers ? ['      - name: Install browsers', `        run: npx playwright install --with-deps ${o.browsers.join(' ')}`] : [])
    ];
    const lines = [
        `# ${CREATED_HEADER}`,
        '# Faster test runs:',
        '#   Pull requests: only the tests affected by the change (--only-changed), then the @smoke tests.',
        `#   Pushes to main, nightly and on demand: the full suite split across ${o.shards} machines (--shard), merged into one HTML report.`,
        '# Keeps using the same secrets and variables as ui-tests.yml (Settings → Secrets and variables → Actions).',
        'name: UI tests (fast)',
        '',
        'on:',
        '  pull_request:',
        '  push:',
        '    branches: [main]',
        '  schedule:',
        "    - cron: '0 2 * * *'",
        '  workflow_dispatch:',
        '',
        'permissions:',
        '  contents: read',
        '',
        'concurrency:',
        '  group: ui-tests-fast-${{ github.ref }}',
        '  cancel-in-progress: true',
        '',
        'jobs:',
        '  changed:',
        '    name: Changed tests and smoke',
        "    if: github.event_name == 'pull_request'",
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 30',
        ...defaults,
        ...envBlock,
        '    steps:',
        ...setup(true, true),
        '      - name: Run tests affected by this change',
        '        run: npx playwright test --only-changed=origin/${{ github.base_ref }} --pass-with-no-tests',
        '      - name: Run smoke tests',
        '        if: ${{ !cancelled() }}',
        '        run: npx playwright test --grep @smoke --pass-with-no-tests',
        '      - name: Upload report',
        '        if: ${{ !cancelled() }}',
        '        uses: actions/upload-artifact@v4',
        '        with:',
        '          name: playwright-report-pr',
        '          path: |',
        `            ${prefix}playwright-report/`,
        `            ${prefix}test-results/`,
        '          retention-days: 14',
        '',
        '  full:',
        '    name: Full run (shard ${{ matrix.shardIndex }} of ${{ matrix.shardTotal }})',
        "    if: github.event_name != 'pull_request'",
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 60',
        '    strategy:',
        '      fail-fast: false',
        '      matrix:',
        `        shardIndex: [${shardList}]`,
        `        shardTotal: [${o.shards}]`,
        ...defaults,
        ...envBlock,
        '    steps:',
        ...setup(false, true),
        '      - name: Run this shard',
        '        run: npx playwright test --shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }} --reporter=blob',
        '      - name: Upload blob report',
        '        if: ${{ !cancelled() }}',
        '        uses: actions/upload-artifact@v4',
        '        with:',
        '          name: blob-report-${{ matrix.shardIndex }}',
        `          path: ${prefix}blob-report`,
        '          retention-days: 1',
        '',
        '  merge:',
        '    name: Merge reports',
        "    if: ${{ !cancelled() && github.event_name != 'pull_request' }}",
        '    needs: [full]',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 15',
        ...defaults,
        '    steps:',
        ...setup(false, false),
        '      - name: Download blob reports',
        '        uses: actions/download-artifact@v4',
        '        with:',
        `          path: ${prefix}all-blob-reports`,
        '          pattern: blob-report-*',
        '          merge-multiple: true',
        '      - name: Merge into one HTML report',
        '        run: npx playwright merge-reports --reporter html ./all-blob-reports',
        '      - name: Upload HTML report',
        '        uses: actions/upload-artifact@v4',
        '        with:',
        '          name: playwright-report',
        `          path: ${prefix}playwright-report`,
        '          retention-days: 14',
        ''
    ];
    return lines.join('\n');
}

/** The same commands for CI systems TestPilot does not write a fast pipeline for yet. */
export function ciSpeedSnippet(provider: string, shards: number): string {
    const common = [
        'Pull requests (needs the full git history, not a shallow clone):',
        '  npx playwright test --only-changed=origin/<target-branch> --pass-with-no-tests',
        '  npx playwright test --grep @smoke',
        `Full run on main and nightly, split across ${shards} machines (run shard 1 to ${shards} in parallel):`,
        `  npx playwright test --shard=<index>/${shards} --reporter=blob`,
        'Then, in one job after all shards, collect every blob-report folder into all-blob-reports and run:',
        '  npx playwright merge-reports --reporter html ./all-blob-reports'
    ];
    const specific: Record<string, string[]> = {
        gitlab: [
            'GitLab CI:',
            `  parallel: ${shards}`,
            '  script: npx playwright test --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL --reporter=blob',
            '  Merge requests: --only-changed=origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME (set GIT_DEPTH: 0)'
        ],
        'azure-devops': [
            'Azure DevOps:',
            '  strategy:',
            `    parallel: ${shards}`,
            '  script: npx playwright test --shard=$(System.JobPositionInPhase)/$(System.TotalJobsInPhase) --reporter=blob',
            '  Pull requests: --only-changed=origin/$(System.PullRequest.TargetBranchName) (checkout with fetchDepth: 0)'
        ],
        jenkins: ['Jenkins:', `  Use a parallel block with ${shards} stages, each running --shard=N/${shards} --reporter=blob, then stash the blob-report folders and merge them in a final stage.`]
    };
    return [...common, '', ...(specific[provider] ?? [])].join('\n');
}

export function planCiSpeed(store: ProjectStore, config: Config, shards: number, providerOverride?: string): PlanOutcome {
    const lang = playwrightLang(config, 'Faster CI runs');
    if ('error' in lang) return lang;
    const provider = providerOverride ?? config.integrations.ci;
    if (!provider || provider === 'none') return { error: 'No CI system chosen yet. Pick one in the wizard (step CI) or pass ciProvider.' };
    if (!Number.isInteger(shards) || shards < 1 || shards > 32) return { error: 'shards must be a whole number from 1 to 32.' };
    const plan: CapabilityPlan = emptyPlan(
        'ci-speed',
        'Run only what changed',
        `Pull requests run only the tests touched by the change plus the @smoke tests, so feedback comes in minutes. The full suite runs on main and every night, split across ${shards} machines, with one merged report.`,
        `Added the fast CI pipeline for ${provider}: changed tests + @smoke on pull requests, full run in ${shards} shards on main and nightly`
    );
    if (provider !== 'github-actions') {
        plan.snippets.push({ title: `TestPilot writes the fast pipeline for GitHub Actions. For ${provider}, add these commands to your pipeline:`, content: ciSpeedSnippet(provider, shards) });
        plan.decision = `Showed the fast CI commands for ${provider} (${shards} shards)`;
        return plan;
    }
    const ci = planCi(store, config, 'github-actions');
    const keys = 'error' in ci ? { secrets: [], variables: [] } : { secrets: ci.secrets, variables: ci.variables };
    const testRoot = inTestRoot(config, '.') && inTestRoot(config, '.') !== '.' ? inTestRoot(config, '.').replace(/\/+$/, '') : '.';
    const browsers = config.appType === 'api' ? [] : config.execution.browsers?.length ? config.execution.browsers : ['chromium'];
    const content = fastWorkflow({ shards, testRoot, browsers: browsers.length ? browsers : ['chromium'], ...keys });
    plan.files.push(compareWithDisk(store, FAST_WORKFLOW, content));
    if (store.exists('.github/workflows/ui-tests.yml')) {
        plan.notes.push('Your existing .github/workflows/ui-tests.yml also runs on every pull request and push. Remove its pull_request and push triggers (keep workflow_dispatch) so each test does not run twice.');
    }
    if (keys.secrets.length || keys.variables.length) plan.notes.push(`Uses the same GitHub settings as ui-tests.yml:${keys.secrets.length ? ` secrets ${keys.secrets.join(', ')};` : ''}${keys.variables.length ? ` variables ${keys.variables.join(', ')}.` : ''}`);
    plan.notes.push('Tag a handful of critical tests with @smoke (in the title or with { tag: [\'@smoke\'] }) so pull requests always check them.');
    plan.data = { provider, shards, file: FAST_WORKFLOW };
    return plan;
}
