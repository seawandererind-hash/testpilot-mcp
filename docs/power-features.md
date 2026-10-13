# Power features

These tools sit on top of the guided setup. Each one previews before it writes and waits for your yes, keeps passwords in `.env`, and saves what it did in `.testpilot/`. You can ask for any of them in plain words ("test SHOP-1 live", "heal the failing tests", "show me the coverage map"); the AI picks the tool.

| Tool | What it does | Runs where |
|---|---|---|
| `demo_project` | A practice shop and five test cases, with the wizard filled in, for demos and first tries | Local |
| `live_test` | Drives a real browser through a test case while you watch, and records what worked | Local |
| `heal_tests` | Fixes broken locators with your approval, explains failures from traces, finds and quarantines flaky tests | Local |
| `quality_scan` | Quality gate for test code, explained accessibility checks, visual checks with smart masks | Local |
| `insights` | Coverage and traceability map, per-repository metrics, team dashboard, in-chat views | Local and hosted |
| `add_capability` | Log in once, test-data factory, faster CI, cloud browsers, API tests from OpenAPI, companion MCP servers, company rule pack | Local and hosted |

## Try it: `/qa-demo`

Say "give me the TestPilot demo" or use the `/qa-demo` prompt. `demo_project` creates a small shop website (served on this computer at http://localhost:4599), five sample test cases in `test-cases/shop.csv`, demo values in `.env`, and answers the wizard for you (web, Playwright, Page Object Model, CSV, GitHub Actions). If the folder already holds a project, the demo goes into a `testpilot-demo` subfolder.

It returns a script: the tool calls to make, in order, with one sentence to tell the audience at each step. `demo_project` action `break` renames the shop's "Sign in" button to "Log in" so a test fails and `heal_tests` can fix it; `restore` puts it back; `stop` stops the shop.

## Watch it test: `live_test`

Web apps only (mobile and desktop apps use `explore_app`).

- `start` opens a real browser on the test environment, on your screen when there is one (it falls back to an invisible browser in CI and says so). It refuses production-looking addresses unless you allow them.
- `auto` with a `caseId` performs the steps it understands by itself (open, type, click, check) and stops at the first step it cannot map, handing it to the AI.
- `step` performs one action the AI chooses: goto, click, fill, select, check, uncheck, press, hover, expectVisible, expectText, expectUrl. Elements are found by role and name first, then label, placeholder, text or test id; CSS only as a last resort. Passwords are passed by key name (`valueFromEnv: "TEST_USER_PASSWORD"`) and never appear in the chat or the recording. Clicks that look like paying, ordering, deleting or sending wait for your OK.
- `finish` saves the recording to `.testpilot/live/recordings/`, adds the locators that worked to `.testpilot/exploration/` (so `generate_tests` uses them), and after you approve the preview writes a ready-to-run test to `tests/recorded/<id>.spec.ts` (or `.js`).
- `snapshot` shows the current page; `stop` closes the browser. It also closes after 15 idle minutes.

## Heal and stabilise: `heal_tests`

- `propose` reads the latest run. For each locator failure it looks at what the page really showed when the test failed (Playwright's error context, then the exploration, then a fresh page visit) and proposes a fix as a one-line diff with a confidence and a plain reason, for example "The button is now called 'Log in' instead of 'Sign in'". It never proposes changes for assertion failures, because those may be real bugs.
- `apply` (after your yes) patches the files, re-runs only the affected tests, keeps the fixes that pass and undoes the rest. Each heal goes in `decisions.md` and `.testpilot/heal/history.jsonl`.
- `explain` reads each failed test's Playwright trace and writes a short story to `.testpilot/reports/failures.md`: the steps in plain words, what a person would have seen, the likely cause (a 500 from the server is an app bug, not a locator problem), the exact line, console errors and failed requests.
- `flaky` scores every test across all saved runs (pass rate, flips) and writes `.testpilot/reports/flaky.md`.
- `quarantine` / `unquarantine` (after your yes) tag flaky tests `@quarantine` and write a ticket draft per test. Run `npx playwright test --grep-invert @quarantine` as the blocking CI job and `--grep @quarantine` as a non-blocking one.
- `install-agents` (after your yes) runs `npx playwright init-agents` to add Playwright's own planner, generator and healer agents (Playwright 1.56 or newer).

Keep `trace: 'retain-on-failure'` (the TestPilot template does) so `explain` has traces to read.

## Quality checks: `quality_scan`

- `gate` checks test files before you trust them, with pass, fail or warn and line numbers: it compiles (`tsc`, `node --check`, or Maven for Java), no fixed waits, no passwords in code (compared with `.env` inside the server, never shown), every test really checks something, no leftover `.only` or unexplained skips, and stable locators (no XPath, `nth-child` or generated class names). With `run: true` it also runs them once. Report: `.testpilot/reports/quality-gate.md`.
- `accessibility` scans your pages with axe-core against WCAG 2.2 (level A, AA or AAA) and explains each problem in plain words: who it affects and how to fix it. Report: `.testpilot/reports/accessibility.html`. With `writeSpec: true` it adds a CI test that fails on serious and critical issues. The European Accessibility Act has applied since 28 June 2025.
- `visual` mode `setup` writes screenshot tests per page and hides areas that change between runs (clocks, dates, "3 minutes ago", videos, maps, ads, avatars, live regions), each with a comment saying why. `baseline` records the reference screenshots, `compare` shows expected, actual and difference side by side in `.testpilot/reports/visual.html`, and `approve` accepts a new look. The default tolerance is very strict (0.01% of pixels) so a changed word is caught; masked areas are ignored. Baselines depend on the operating system, so record them where CI runs.

## Coverage and team view: `insights`

- `coverage` links requirements to test cases, automated tests and the latest results. Requirements come from a CSV or Excel list (`requirementsFile`, columns such as id, title, area, priority), Jira stories or epics (`jql`, read-only), or, when you give neither, the test-case areas (clearly labelled "inferred"). A case is linked when the requirement id appears in its tags, title, description or source, through Jira "is tested by" links, or through explicit `links`. Each requirement is coloured: no tests, failing, manual only, automated, passing. Report: `.testpilot/reports/coverage.html` with a heat map and the list of requirements that have no tests.
- `metrics` writes `.testpilot/reports/metrics.json`: case counts, requirement coverage, pass rate, flaky rate, runs in the last 30 days and an estimate of manual hours saved (automated cases × runs × `manualMinutesPerCase`, default 5).
- `dashboard` combines metrics files from several teams (`sources`: metrics.json files, repository folders, or a shared folder where each team's CI drops its file) into `.testpilot/reports/team-dashboard.html`.
- In AI tools that support MCP Apps (Claude, ChatGPT, VS Code, Goose) the coverage map and metrics also appear as an interactive view in the chat, with a Refresh button. Other tools get the same results as text.

## Add-ons: `add_capability`

Ask in plain words ("log in once and reuse it", "run only what changed in CI", "generate API tests from our OpenAPI file"). The first call returns a preview: every file marked new or changed, with diffs of patched files. Nothing is written until you approve; files that already exist and differ are only replaced when listed in `overwrite`.

| Capability | What you get |
|---|---|
| `login-once` | A Playwright setup project that signs each role in `test-data/users.json` in once and saves the session to `playwright/.auth/` (git-ignored), so every test starts signed in. TestPilot's own `playwright.config` is patched (diff shown); other configs get a snippet to paste. For SSO or one-time codes, use test accounts with MFA off or a TOTP secret in `.env`. |
| `test-data` | `test-data/factory.ts` (or `.js`) with builders that make unique data per run using Faker, and a fixture that creates data through the API and deletes it after the test. It also scans imported test cases for real personal data (emails, phone numbers, card numbers checked with Luhn, IBANs, national ids) and reports them masked. `install: true` adds Faker. |
| `ci-speed` | GitHub Actions: on pull requests, only the tests affected by the changed files (`--only-changed`) plus `@smoke`; on main and nightly, the full suite split across `shards` machines (default 4) with one merged report. Other CI systems get the commands to paste. |
| `cloud-grid` | Run web tests on BrowserStack (`browserstack.yml` and `npm run test:browserstack`), Sauce Labs or LambdaTest (`provider`). Keys stay in `.env`; config files only name the variables. |
| `openapi` | API tests from an OpenAPI 3 or Swagger 2 file (`spec`): every GET is called and its status, content type and required fields are checked; POST, PUT, PATCH and DELETE start as `test.fixme` with an example body, because they change data. |
| `companions` | Adds companion MCP servers next to TestPilot, chosen from your setup: Playwright MCP, Appium MCP, BrowserStack MCP, Atlassian (Jira) and GitHub. Versions are pinned and servers you already have are never removed. Pick a subset with `servers`. |
| `org-policy` | A company rule pack (`policy`: a file in the repo or an https URL; example in [examples/org-policy/testpilot.org.yaml](../examples/org-policy/testpilot.org.yaml)): allowed frameworks, languages and patterns, required tags, test-name pattern, CI and forbidden code. TestPilot saves a copy in `.testpilot/org-policy.yaml`, checks the repository and writes `.testpilot/reports/policy.md` with how to fix each rule. Calling it again without `policy` re-checks. |

## Proof

- `scripts/scorecard.mjs` plays the whole demo through the MCP protocol and writes [scorecard.md](scorecard.md). The **Scorecard** workflow runs it weekly.
- `scripts/device-check.mjs` and the **Device check** workflow open a real Android app on an emulator (and on BrowserStack when its secrets are set) through TestPilot every night.
