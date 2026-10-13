import type { AppType, Pattern } from '../core/schema.js';

export interface Option {
    value: string;
    label: string;
    description: string;
}

export interface FrameworkOption extends Option {
    languages: string[];
    /** Template pack id when TestPilot can scaffold this combination itself. */
    packs?: Record<string, string>;
    pros: string[];
    cons: string[];
}

export const APP_TYPE_OPTIONS: Option[] = [
    { value: 'web', label: 'Web app', description: 'Runs in a browser and you open it with a URL.' },
    { value: 'android', label: 'Android app', description: 'Installed from an APK or AAB, or from the Play Store.' },
    { value: 'ios', label: 'iOS app', description: 'An IPA or .app. Local runs need a Mac with Xcode; otherwise use a device cloud.' },
    { value: 'android-ios', label: 'Android + iOS', description: 'The same app on both platforms, sharing test logic.' },
    { value: 'windows', label: 'Windows desktop', description: 'A Windows program (.exe).' },
    { value: 'macos', label: 'macOS desktop', description: 'A Mac application (.app).' },
    { value: 'electron', label: 'Electron desktop', description: 'A desktop app built with Electron (Slack, VS Code style).' },
    { value: 'api', label: 'API', description: 'REST or GraphQL endpoints, no user interface.' },
    { value: 'hybrid', label: 'Hybrid / WebView', description: 'A mobile app that shows web pages inside it.' }
];

export const FRAMEWORKS: Record<AppType, FrameworkOption[]> = {
    web: [
        {
            value: 'playwright',
            label: 'Playwright',
            description: 'Fast, auto-waits for elements, built-in reports and traces.',
            languages: ['typescript', 'javascript', 'java', 'python', 'csharp'],
            packs: { typescript: 'playwright-ts', javascript: 'playwright-js' },
            pros: ['Waits for elements automatically, so fewer flaky tests', 'Trace viewer shows exactly what happened', 'Chromium, Firefox and WebKit from one API'],
            cons: ['No real Safari on Windows/Linux (WebKit is close but not identical)']
        },
        {
            value: 'selenium',
            label: 'Selenium 4',
            description: 'The long-standing standard, with a huge community. With Java: Maven, TestNG, Page Object Model, Cucumber for BDD.',
            languages: ['java', 'python', 'csharp', 'javascript'],
            packs: { java: 'selenium-java' },
            pros: ['Most widely known; most QA engineers already know it', 'Works with every grid and cloud', 'Selenium Manager downloads the browser drivers for you'],
            cons: ['Explicit waits are your job (the generated BasePage wraps them)', 'More setup than Playwright']
        },
        {
            value: 'webdriverio',
            label: 'WebdriverIO',
            description: 'JavaScript test runner that also drives mobile through Appium.',
            languages: ['typescript', 'javascript'],
            pros: ['One framework for web and mobile', 'Rich plugin ecosystem'],
            cons: ['BrowserStack supports only WebdriverIO 7 to 9 today']
        },
        {
            value: 'cypress',
            label: 'Cypress',
            description: 'Developer-friendly runner that runs inside the browser.',
            languages: ['typescript', 'javascript'],
            pros: ['Great interactive runner'],
            cons: ['Limited multi-tab and cross-origin support', 'No WebKit on all platforms']
        }
    ],
    android: [
        {
            value: 'appium',
            label: 'Appium 3 (UiAutomator2)',
            description: 'The standard open-source mobile automation server.',
            languages: ['typescript', 'java', 'python'],
            packs: { typescript: 'appium-ts' },
            pros: ['Same API for Android and iOS', 'Works on emulators, devices and BrowserStack'],
            cons: ['Needs Java and the Android SDK installed locally']
        },
        { value: 'webdriverio-appium', label: 'WebdriverIO + Appium', description: 'Appium driven from the WebdriverIO runner.', languages: ['typescript', 'javascript'], packs: { typescript: 'appium-ts' }, pros: ['Good TypeScript support'], cons: ['Two tools to learn'] },
        { value: 'maestro', label: 'Maestro', description: 'Simple YAML flows for mobile.', languages: ['yaml'], pros: ['Very quick to start'], cons: ['Less flexible for complex logic'] },
        { value: 'espresso', label: 'Espresso', description: 'Google\'s in-app Android test framework.', languages: ['kotlin', 'java'], pros: ['Fastest and most stable on Android'], cons: ['Needs the app source code'] }
    ],
    ios: [
        {
            value: 'appium',
            label: 'Appium 3 (XCUITest)',
            description: 'The standard open-source mobile automation server.',
            languages: ['typescript', 'java', 'python'],
            packs: { typescript: 'appium-ts' },
            pros: ['Same API for Android and iOS'],
            cons: ['Simulators need macOS with Xcode; real devices from Windows/Linux only on iOS 18+ with limits']
        },
        { value: 'maestro', label: 'Maestro', description: 'Simple YAML flows for mobile.', languages: ['yaml'], pros: ['Very quick to start'], cons: ['Less flexible'] },
        { value: 'xcuitest', label: 'XCUITest (native)', description: 'Apple\'s own UI test framework.', languages: ['swift'], pros: ['Most stable on iOS'], cons: ['Needs the app source and a Mac'] }
    ],
    'android-ios': [
        {
            value: 'appium',
            label: 'Appium 3',
            description: 'One test suite, platform-specific page objects.',
            languages: ['typescript', 'java', 'python'],
            packs: { typescript: 'appium-ts' },
            pros: ['Shares test logic across platforms'],
            cons: ['iOS runs need a Mac or a device cloud']
        },
        { value: 'webdriverio-appium', label: 'WebdriverIO + Appium', description: 'Appium driven from WebdriverIO.', languages: ['typescript'], packs: { typescript: 'appium-ts' }, pros: ['Good TypeScript support'], cons: ['Two tools to learn'] },
        { value: 'maestro', label: 'Maestro', description: 'YAML flows for both platforms.', languages: ['yaml'], pros: ['Quick to start'], cons: ['Less flexible'] }
    ],
    windows: [
        {
            value: 'appium-wincore',
            label: 'Appium WinCore driver',
            description: 'The official replacement for the deprecated Appium Windows driver.',
            languages: ['typescript', 'java', 'python', 'csharp'],
            packs: { typescript: 'appium-ts' },
            pros: ['No WinAppDriver or Developer Mode needed'],
            cons: ['New (first release September 2026)']
        },
        { value: 'appium-novawindows', label: 'Appium NovaWindows driver', description: 'Community drop-in alternative.', languages: ['typescript', 'java', 'python', 'csharp'], packs: { typescript: 'appium-ts' }, pros: ['Mature community driver'], cons: ['Community maintained'] },
        { value: 'flaui', label: 'FlaUI (.NET)', description: '.NET library over Windows UI Automation.', languages: ['csharp'], pros: ['Direct UI Automation access'], cons: ['.NET only'] }
    ],
    macos: [
        {
            value: 'appium-mac2',
            label: 'Appium Mac2 driver',
            description: 'Drives macOS apps through XCTest.',
            languages: ['typescript', 'java', 'python'],
            packs: { typescript: 'appium-ts' },
            pros: ['Standard Appium API'],
            cons: ['Runs only on a Mac with Xcode']
        }
    ],
    electron: [
        {
            value: 'playwright-electron',
            label: 'Playwright for Electron',
            description: 'Launches the Electron app and drives its windows like web pages.',
            languages: ['typescript', 'javascript'],
            packs: { typescript: 'playwright-ts', javascript: 'playwright-js' },
            pros: ['Same API as web tests'],
            cons: ['Playwright marks Electron support as experimental']
        }
    ],
    api: [
        {
            value: 'playwright-api',
            label: 'Playwright API testing',
            description: 'HTTP tests with Playwright\'s request client.',
            languages: ['typescript', 'javascript', 'java', 'python', 'csharp'],
            packs: { typescript: 'playwright-ts', javascript: 'playwright-js' },
            pros: ['Mix API and UI steps in one test'],
            cons: ['Fewer API-specific helpers than REST Assured']
        },
        { value: 'rest-assured', label: 'REST Assured', description: 'Java library for REST testing.', languages: ['java'], pros: ['Very expressive for REST'], cons: ['Java only'] },
        { value: 'newman', label: 'Postman / Newman', description: 'Run Postman collections from the command line.', languages: ['json'], pros: ['Reuses existing Postman collections'], cons: ['Harder to keep in code review'] }
    ],
    hybrid: [
        {
            value: 'appium',
            label: 'Appium 3 with context switching',
            description: 'Switches between native and WebView contexts.',
            languages: ['typescript', 'java', 'python'],
            packs: { typescript: 'appium-ts' },
            pros: ['Handles native and web parts in one test'],
            cons: ['WebView debugging must be enabled in the app build']
        }
    ]
};

export const LANGUAGE_LABELS: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    java: 'Java',
    python: 'Python',
    csharp: 'C# (.NET)',
    kotlin: 'Kotlin',
    swift: 'Swift',
    yaml: 'YAML flows',
    json: 'JSON collections'
};

export const BUILD_TOOLS: Record<string, string[]> = {
    typescript: ['npm', 'pnpm', 'yarn'],
    javascript: ['npm', 'pnpm', 'yarn'],
    java: ['maven', 'gradle'],
    kotlin: ['gradle'],
    python: ['pip', 'uv', 'poetry'],
    csharp: ['dotnet'],
    swift: ['xcodebuild'],
    yaml: ['maestro'],
    json: ['npm']
};

export const PATTERN_OPTIONS: Array<Option & { value: Pattern }> = [
    { value: 'pom', label: 'Page Object Model', description: 'One class per screen holds its locators and actions; tests read like the test case. Best default.' },
    { value: 'bdd', label: 'BDD (Gherkin)', description: 'Tests written as Given/When/Then feature files that business people can read.' },
    { value: 'screenplay', label: 'Screenplay', description: 'Actors perform tasks; scales well for very large suites.' },
    { value: 'keyword', label: 'Keyword / data-driven', description: 'Tests built from reusable keywords and data tables.' },
    { value: 'hybrid', label: 'Hybrid', description: 'Page objects plus data-driven tables.' }
];

export const EXECUTION_OPTIONS: Option[] = [
    { value: 'local', label: 'This computer', description: 'Run on local browsers, emulators or devices.' },
    { value: 'browserstack', label: 'BrowserStack', description: 'Cloud browsers and real devices. Needs a BrowserStack account.' },
    { value: 'grid', label: 'Selenium Grid', description: 'Your company\'s own grid.' },
    { value: 'saucelabs', label: 'Sauce Labs', description: 'Cloud browsers and devices.' },
    { value: 'lambdatest', label: 'LambdaTest', description: 'Cloud browsers and devices.' },
    { value: 'docker', label: 'Docker', description: 'Run inside containers, the same way as CI.' }
];

export const TEST_CASE_SOURCE_OPTIONS: Option[] = [
    { value: 'jira', label: 'Jira', description: 'Plain Jira issues (summary, description).' },
    { value: 'xray', label: 'Jira with Xray', description: 'Test issues managed by the Xray app.' },
    { value: 'zephyr', label: 'Jira with Zephyr', description: 'Zephyr (formerly Zephyr Scale).' },
    { value: 'browserstack', label: 'BrowserStack Test Management', description: 'Test cases stored in BrowserStack.' },
    { value: 'testrail', label: 'TestRail', description: 'Test cases in TestRail.' },
    { value: 'azure-devops', label: 'Azure DevOps Test Plans', description: 'Test Case work items.' },
    { value: 'excel', label: 'Excel', description: 'An .xlsx file in the repo.' },
    { value: 'csv', label: 'CSV', description: 'A .csv file in the repo.' },
    { value: 'word', label: 'Word', description: 'A .docx file with test-case tables.' },
    { value: 'gherkin', label: 'Gherkin', description: '.feature files.' },
    { value: 'markdown', label: 'Markdown', description: 'Test cases written in Markdown.' },
    { value: 'none', label: 'None yet', description: 'I\'ll help you write them from the app or from requirements.' }
];

export const CI_OPTIONS: Option[] = [
    { value: 'github-actions', label: 'GitHub Actions', description: 'A workflow file in .github/workflows.' },
    { value: 'azure-devops', label: 'Azure Pipelines', description: 'azure-pipelines.yml.' },
    { value: 'gitlab', label: 'GitLab CI', description: '.gitlab-ci.yml.' },
    { value: 'jenkins', label: 'Jenkins', description: 'A Jenkinsfile.' },
    { value: 'none', label: 'Not now', description: 'Skip CI for now.' }
];

export const REPORTING_OPTIONS: Option[] = [
    { value: 'html', label: 'HTML report', description: 'Built-in report you open in a browser.' },
    { value: 'allure', label: 'Allure', description: 'Rich report with history and trends.' },
    { value: 'junit', label: 'JUnit XML', description: 'For CI and for importing results into Xray or BrowserStack.' }
];

export const EXTRA_OPTIONS: Option[] = [
    { value: 'explore', label: 'Explore the app', description: 'Open the app and record screens and stable locators.' },
    { value: 'accessibility', label: 'Accessibility checks', description: 'Add axe-core checks to key pages.' },
    { value: 'visual', label: 'Visual tests', description: 'Screenshot comparisons for key screens.' },
    { value: 'api-layer', label: 'API layer', description: 'Helpers to create test data through the API instead of the UI.' },
    { value: 'test-data', label: 'Test-data factory', description: 'Generates unique users, orders and so on per test.' },
    { value: 'parallel', label: 'Parallel runs', description: 'Run tests in parallel safely.' }
];

/**
 * The suggested framework and language for an app type, with a reason. The language is the team's
 * call: a repository that already has Java or Python code gets that language and a framework that
 * TestPilot can scaffold in it (Selenium + Java for the web); an empty repository gets TypeScript.
 */
export function recommendStack(appType: AppType, existingLanguages: string[] = []): { framework: string; language: string; pattern: Pattern; reason: string } {
    const hasJsTs = existingLanguages.some(l => l === 'typescript' || l === 'javascript');
    const repoLanguage = hasJsTs ? (existingLanguages.includes('typescript') ? 'typescript' : 'javascript') : (['java', 'python', 'csharp'] as const).find(l => existingLanguages.includes(l));
    const scaffoldable = FRAMEWORKS[appType].find(f => repoLanguage && f.packs?.[repoLanguage]);
    const framework = scaffoldable ?? FRAMEWORKS[appType][0];
    const language = repoLanguage && framework.languages.includes(repoLanguage) ? repoLanguage : framework.languages[0];
    const why = repoLanguage === language ? `it matches the ${LANGUAGE_LABELS[language]} already in this repository` : 'it has the best tooling for this framework; pick another if your team knows it better';
    return { framework: framework.value, language, pattern: 'pom', reason: `${framework.label} with ${LANGUAGE_LABELS[language]} and the Page Object Model: ${framework.description} I suggest ${LANGUAGE_LABELS[language]} because ${why}. The choice is yours: TestPilot scaffolds and generates tests for every combination marked as such.` };
}

export function findFramework(appType: AppType, value: string): FrameworkOption | undefined {
    return FRAMEWORKS[appType].find(f => f.value === value);
}

/** Template pack for a combination, or undefined when TestPilot can only guide. */
export function templatePackFor(appType: AppType | undefined, framework: string | undefined, language: string | undefined): string | undefined {
    if (!appType || !framework || !language) return undefined;
    return findFramework(appType, framework)?.packs?.[language];
}
