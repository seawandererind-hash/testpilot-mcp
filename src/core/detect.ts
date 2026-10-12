import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface RepoDetection {
    root: string;
    isGitRepo: boolean;
    gitRemote?: string;
    languages: Array<{ language: string; files: number }>;
    buildTools: string[];
    testFrameworks: Array<{ name: string; evidence: string }>;
    ci: string[];
    hasTestPilot: boolean;
    existingTestDirs: string[];
    packageName?: string;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.vscode', 'coverage', '.next', 'bin', 'obj', 'Pods', 'playwright-report', 'test-results', 'allure-results', 'apps']);

const EXTENSIONS: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.java': 'java',
    '.kt': 'kotlin',
    '.py': 'python',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.rb': 'ruby',
    '.go': 'go',
    '.feature': 'gherkin'
};

const NODE_TEST_DEPS: Record<string, string> = {
    '@playwright/test': 'playwright',
    playwright: 'playwright',
    cypress: 'cypress',
    webdriverio: 'webdriverio',
    '@wdio/cli': 'webdriverio',
    'selenium-webdriver': 'selenium',
    appium: 'appium',
    '@cucumber/cucumber': 'cucumber',
    jest: 'jest',
    vitest: 'vitest',
    mocha: 'mocha',
    'allure-playwright': 'allure'
};

const TEXT_SIGNALS: Array<{ file: string; pattern: RegExp; name: string }> = [
    { file: 'pom.xml', pattern: /selenium-java/, name: 'selenium' },
    { file: 'pom.xml', pattern: /java-client|io\.appium/, name: 'appium' },
    { file: 'pom.xml', pattern: /com\.microsoft\.playwright/, name: 'playwright' },
    { file: 'pom.xml', pattern: /testng/, name: 'testng' },
    { file: 'pom.xml', pattern: /junit-jupiter|junit/, name: 'junit' },
    { file: 'pom.xml', pattern: /cucumber/, name: 'cucumber' },
    { file: 'pom.xml', pattern: /rest-assured/, name: 'rest-assured' },
    { file: 'build.gradle', pattern: /selenium/, name: 'selenium' },
    { file: 'build.gradle', pattern: /appium/, name: 'appium' },
    { file: 'build.gradle', pattern: /espresso/, name: 'espresso' },
    { file: 'build.gradle.kts', pattern: /espresso/, name: 'espresso' },
    { file: 'requirements.txt', pattern: /^pytest/m, name: 'pytest' },
    { file: 'requirements.txt', pattern: /playwright/, name: 'playwright' },
    { file: 'requirements.txt', pattern: /selenium/, name: 'selenium' },
    { file: 'requirements.txt', pattern: /Appium-Python-Client/i, name: 'appium' },
    { file: 'pyproject.toml', pattern: /pytest/, name: 'pytest' },
    { file: 'pyproject.toml', pattern: /playwright/, name: 'playwright' },
    { file: 'pyproject.toml', pattern: /selenium/, name: 'selenium' }
];

const BUILD_FILES: Record<string, string> = {
    'package.json': 'npm',
    'pnpm-lock.yaml': 'pnpm',
    'yarn.lock': 'yarn',
    'pom.xml': 'maven',
    'build.gradle': 'gradle',
    'build.gradle.kts': 'gradle',
    'requirements.txt': 'pip',
    'pyproject.toml': 'pip',
    'uv.lock': 'uv',
    'poetry.lock': 'poetry'
};

const CI_FILES: Array<{ path: string; name: string }> = [
    { path: '.github/workflows', name: 'github-actions' },
    { path: 'azure-pipelines.yml', name: 'azure-devops' },
    { path: '.gitlab-ci.yml', name: 'gitlab' },
    { path: 'Jenkinsfile', name: 'jenkins' },
    { path: 'bitbucket-pipelines.yml', name: 'bitbucket' },
    { path: '.circleci', name: 'circleci' }
];

/** Looks at a repository without changing anything. */
export function detectRepo(root: string): RepoDetection {
    const languageCounts = new Map<string, number>();
    const testDirs = new Set<string>();
    let seen = 0;

    const walk = (dir: string, depth: number) => {
        if (depth > 6 || seen > 20_000) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            if (IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.github')) continue;
            const full = path.join(dir, name);
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            seen++;
            if (stat.isDirectory()) {
                if (/^(tests?|e2e|specs?|cypress|features|__tests__|androidTest|uitests?)$/i.test(name)) testDirs.add(path.relative(root, full).split(path.sep).join('/'));
                walk(full, depth + 1);
            } else {
                const language = EXTENSIONS[path.extname(name).toLowerCase()];
                if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
            }
        }
    };
    walk(root, 0);

    const frameworks = new Map<string, string>();
    const pkgPath = path.join(root, 'package.json');
    let packageName: string | undefined;
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            packageName = pkg.name;
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            for (const [dep, name] of Object.entries(NODE_TEST_DEPS)) if (dep in deps && !frameworks.has(name)) frameworks.set(name, `package.json → ${dep}`);
        } catch {
            // ignore unreadable package.json
        }
    }
    for (const signal of TEXT_SIGNALS) {
        const file = path.join(root, signal.file);
        if (!frameworks.has(signal.name) && existsSync(file)) {
            try {
                if (signal.pattern.test(readFileSync(file, 'utf8'))) frameworks.set(signal.name, signal.file);
            } catch {
                // ignore
            }
        }
    }
    for (const config of ['playwright.config.ts', 'playwright.config.js', 'cypress.config.ts', 'cypress.config.js', 'wdio.conf.ts', 'wdio.conf.js']) {
        if (existsSync(path.join(root, config))) {
            const name = config.split('.')[0].replace('wdio', 'webdriverio');
            if (!frameworks.has(name)) frameworks.set(name, config);
        }
    }
    if (existsSync(path.join(root, '.maestro'))) frameworks.set('maestro', '.maestro/');

    const buildTools = [...new Set(Object.entries(BUILD_FILES).filter(([file]) => existsSync(path.join(root, file))).map(([, tool]) => tool))];
    const ci = CI_FILES.filter(c => existsSync(path.join(root, c.path))).map(c => c.name);

    return {
        root,
        isGitRepo: existsSync(path.join(root, '.git')),
        gitRemote: readGitRemote(root),
        languages: [...languageCounts.entries()].filter(([l]) => l !== 'gherkin' || languageCounts.size === 1).sort((a, b) => b[1] - a[1]).map(([language, files]) => ({ language, files })),
        buildTools,
        testFrameworks: [...frameworks.entries()].map(([name, evidence]) => ({ name, evidence })),
        ci,
        hasTestPilot: existsSync(path.join(root, '.testpilot', 'config.yaml')),
        existingTestDirs: [...testDirs].slice(0, 20),
        packageName
    };
}

/** UI automation frameworks found (unit-test runners alone do not count). */
export function uiFrameworksIn(detection: RepoDetection): string[] {
    const ui = new Set(['playwright', 'cypress', 'webdriverio', 'selenium', 'appium', 'espresso', 'maestro', 'rest-assured']);
    return detection.testFrameworks.map(f => f.name).filter(name => ui.has(name));
}

function readGitRemote(root: string): string | undefined {
    const config = path.join(root, '.git', 'config');
    if (!existsSync(config)) return undefined;
    try {
        const match = readFileSync(config, 'utf8').match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
        // Strip any credentials embedded in the remote URL.
        return match?.[1].replace(/\/\/[^@/]+@/, '//');
    } catch {
        return undefined;
    }
}
