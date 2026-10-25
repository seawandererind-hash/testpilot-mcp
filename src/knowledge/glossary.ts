/** Testing words explained for someone who has never done testing. Each entry: what it is, then an everyday example. */
export interface GlossaryEntry {
    term: string;
    aliases: string[];
    plain: string;
    example: string;
}

export const GLOSSARY: GlossaryEntry[] = [
    { term: 'Test case', aliases: ['test cases', 'test scenario', 'scenario'], plain: 'A short written recipe: the steps to take in the app and what should happen.', example: 'Open the sign-in page, enter a wrong password, click Sign in: the message "Wrong password" appears.' },
    { term: 'Automated test', aliases: ['automation', 'test automation', 'automated tests', 'test script', 'spec'], plain: 'A test case turned into a small program, so a computer can repeat it in seconds, as often as you like, without anyone clicking.', example: 'Instead of a person checking the sign-in page before every release, the automated test does it in 3 seconds.' },
    { term: 'Manual testing', aliases: ['manual test', 'manual'], plain: 'A person following the test case by hand. Still the right choice for things a computer cannot judge, such as "does this look nice?".', example: 'Checking that the new logo looks right on the home page.' },
    { term: 'Framework', aliases: ['test framework', 'testing framework', 'automation framework'], plain: 'The tool and folder structure that runs your automated tests: it opens the app, clicks, types and checks results, like a robot user.', example: 'Playwright, Selenium and Appium are frameworks.' },
    { term: 'Playwright', aliases: [], plain: 'A free framework from Microsoft that drives web browsers (Chrome, Firefox, Safari\'s engine). TestPilot\'s recommendation for websites because it waits for pages by itself, which makes tests reliable.', example: 'npx playwright test runs all your Playwright tests.' },
    { term: 'Selenium', aliases: [], plain: 'The oldest and most widely known framework for testing websites. Many testers know it, especially with Java.', example: 'Banks and large companies often already have Selenium tests.' },
    { term: 'Appium', aliases: [], plain: 'A free framework that drives phone apps (Android, iPhone) and desktop programs, the way Playwright drives browsers.', example: 'Appium taps the "Log in" button in your Android app on an emulator.' },
    { term: 'Emulator / simulator', aliases: ['emulator', 'simulator', 'virtual device'], plain: 'A pretend phone that runs on your computer, so you can test a phone app without a real phone.', example: 'Android Studio comes with Android emulators; iPhone simulators need a Mac.' },
    { term: 'Page Object Model', aliases: ['pom', 'page object', 'page objects'], plain: 'A tidy way to organise tests: the names of each page\'s buttons and fields live in one file per page. When a button changes, you fix one line instead of every test.', example: 'LoginPage knows where the email field and the Sign in button are; every test uses LoginPage.' },
    { term: 'BDD / Gherkin / Cucumber', aliases: ['bdd', 'gherkin', 'cucumber', 'given when then', 'feature file'], plain: 'Writing tests as plain-English sentences that start with Given, When and Then, so non-programmers can read and even write them.', example: 'Given I am on the sign-in page. When I sign in with a wrong password. Then I see "Wrong password".' },
    { term: 'Locator', aliases: ['locators', 'selector', 'selectors', 'xpath', 'css selector'], plain: 'How a test finds something on the screen: "the button called Sign in", "the field labelled Email".', example: 'getByRole(\'button\', { name: \'Sign in\' }) finds the Sign in button.' },
    { term: 'Assertion', aliases: ['assertions', 'expect', 'check', 'verification', 'expected result'], plain: 'The check at the end of a test: the thing that must be true, or the test fails.', example: 'expect(page).toHaveTitle(/Shop/) checks that the page title contains "Shop".' },
    { term: 'Pass / fail', aliases: ['passed', 'failed', 'failing test', 'passing test', 'red', 'green'], plain: 'A test passes when every check came out as expected, and fails when one did not. A failure is either a real bug in the app or a test that needs updating because the app changed on purpose.', example: '3 passed, 1 failed: look at the failed one to see what was different.' },
    { term: 'Flaky test', aliases: ['flaky', 'flakiness', 'unstable test', 'intermittent'], plain: 'A test that sometimes passes and sometimes fails with no change to the app. Usually it does not wait long enough. TestPilot runs new tests twice to catch this.', example: 'A test that clicks before the page finished loading fails one time in ten.' },
    { term: 'Smoke test', aliases: ['smoke', 'smoke tests', 'sanity test', 'sanity'], plain: 'A quick test that the most important things work at all, run first before anything deeper.', example: 'Does every page open? Can I sign in?' },
    { term: 'Regression', aliases: ['regression testing', 'regression test', 'regression suite'], plain: 'Something that used to work and broke after a change. Regression tests re-check old features so a new change does not silently break them.', example: 'A developer changes the checkout and the cart stops counting items: a regression.' },
    { term: 'Test environment / staging', aliases: ['staging', 'test environment', 'qa environment', 'uat', 'environment', 'production', 'prod', 'live site'], plain: 'A private copy of the app for testing, separate from the live (production) app your customers use. Tests may create fake orders or users, so they belong on the test copy.', example: 'https://staging.yourcompany.com instead of https://www.yourcompany.com.' },
    { term: '.env file', aliases: ['env', '.env', 'environment variables', 'secrets', 'credentials'], plain: 'A private file on your computer that holds passwords and keys the tests need. It is never shared or uploaded, and you never paste its contents into the chat.', example: 'TEST_USER_EMAIL=qa@yourcompany.com and TEST_USER_PASSWORD=… in .env.' },
    { term: 'CI (continuous integration)', aliases: ['ci', 'ci/cd', 'pipeline', 'github actions', 'jenkins', 'continuous integration'], plain: 'A service that runs your tests automatically every time someone changes the code, and tells the team if something broke.', example: 'GitHub Actions runs the tests on every pull request and shows a green tick or a red cross.' },
    { term: 'Test report', aliases: ['report', 'html report', 'junit', 'allure'], plain: 'The summary after a run: which tests passed, which failed, with screenshots of failures.', example: 'npx playwright show-report opens the last report in your browser.' },
    { term: 'Trace', aliases: ['traces', 'trace viewer'], plain: 'A recording of everything a test did (each click, each page, each network call), which you can replay step by step to see why it failed.', example: 'npx playwright show-trace test-results/…/trace.zip.' },
    { term: 'Headless', aliases: ['headless browser', 'headed'], plain: 'Running the browser without showing its window, which is faster. "Headed" shows the window so you can watch.', example: 'npx playwright test --headed shows the browser while tests run.' },
    { term: 'Accessibility', aliases: ['a11y', 'wcag', 'screen reader'], plain: 'Whether people with disabilities can use the app, for example blind people using a screen reader or people who cannot use a mouse. Many countries require it by law.', example: 'Every image needs a text description; every button needs a name a screen reader can read out.' },
    { term: 'Self-healing', aliases: ['heal', 'healing', 'self healing'], plain: 'When a button is renamed and a test can no longer find it, TestPilot finds the new name and offers to fix the test, after you approve.', example: '"Sign in" became "Log in": the test is updated in one line.' },
    { term: 'Test data', aliases: ['data', 'fixtures', 'test users'], plain: 'The made-up information tests use: test accounts, products, addresses. Kept separate so tests can repeat without surprises.', example: 'A test user called qa+checkout@yourcompany.com with an empty cart.' },
    { term: 'Coverage', aliases: ['test coverage', 'coverage map'], plain: 'How much of the app is protected by automated tests. TestPilot shows which pages and features have tests and which do not.', example: '8 of 12 pages have at least one test.' },
    { term: 'Wave', aliases: ['waves', 'automation plan', 'plan'], plain: 'TestPilot automates test cases in batches called waves, most important first, so you get value early.', example: 'Wave 1: sign-in and checkout. Wave 2: profile and settings.' }
];

/** Finds the entry for a word, by its name or any alias (case-insensitive). */
export function lookupTerm(word: string): GlossaryEntry | undefined {
    const w = word.trim().toLowerCase().replace(/[?.!]+$/, '').replace(/^(what('?s| is| are)|explain|define)\s+(an?\s+|the\s+)?/, '');
    if (!w) return undefined;
    return (
        GLOSSARY.find(e => e.term.toLowerCase() === w || e.aliases.includes(w)) ??
        GLOSSARY.find(e => e.term.toLowerCase().split(/\s*[/(]\s*/).some(part => part.trim() === w)) ??
        GLOSSARY.find(e => w.length >= 3 && (e.term.toLowerCase().includes(w) || e.aliases.some(a => a.includes(w))))
    );
}
