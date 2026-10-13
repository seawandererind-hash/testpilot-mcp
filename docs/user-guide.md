# Your first session with TestPilot

This guide walks through one complete session: a web shop, test cases in an Excel file, tests written with Playwright, results in CI. You do not need to know Playwright or test automation to follow it. Other app types and test-case sources work the same way; only the questions differ.

## 0. Before you start

- TestPilot is installed in your AI tool ([install.md](install.md)).
- You have the repository open (for a brand-new project, an empty folder with `git init` is fine).
- You know the address of a **test** environment, for example `https://staging.shop.example.com`. Never use production.
- You have the test cases somewhere: an Excel or Word file, Jira, TestRail, BrowserStack or similar.

## 1. Start

Say: **"Set up test automation for this repo."**

TestPilot looks at the repository first. If it finds an existing framework (for example Selenium tests), it asks whether to extend that framework or create a new one next to it.

Then the questions begin, one at a time, each with a recommended answer and a short reason:

| Question | For our example |
|---|---|
| What kind of application are you testing? | Web app |
| Which framework? | Playwright (recommended for web) |
| Which language? | TypeScript (JavaScript and Selenium with Java are equally supported; the choice is your team's) |
| Which design pattern? | Page Object Model: one class per screen holds where things are, so tests read like the test case. Teams that write Gherkin pick BDD (Cucumber) instead |
| Where should the tests run? | This computer (later CI) |
| Where are your test cases saved today? | Excel |
| Which CI system? | GitHub Actions |
| Which reports? | HTML and JUnit |

Answer in your own words; you can also say "go back to the framework question" at any time. Every answer lands in `.testpilot/config.yaml`, and the reasoning in `.testpilot/decisions.md`.

## 2. Credentials

TestPilot writes `.env.example`, a list of the keys the project needs with a note on where to get each one, and makes sure `.env` is ignored by git.

**You** copy `.env.example` to `.env` and fill it in, in your editor. Do not paste passwords or tokens into the chat; TestPilot never asks for them. When you are done, say "done", and TestPilot checks that each key is present and looks right, without reading the values back.

## 3. "Can I create the project framework?"

TestPilot shows every file it will create: the Playwright configuration (or `pom.xml` and `testng.xml` for Selenium with Java), a `BasePage` and a first page object, a smoke test (a feature file with BDD), test-data files, `AGENTS.md`, the rules and skills for each AI tool, and five QA agents in `.claude/agents/` and `.cursor/agents/` that know this repository's stack. Web projects also get the Playwright MCP in their MCP configs so the AI tool can open the app itself. Nothing is written until you say yes. If a file already exists with different content, it is kept unless you ask to replace it.

Afterwards it can install the tools (`npm install` and the browser; `mvn test-compile` for Java). If something is missing on your machine, `check_prerequisites` tells you exactly what to install.

## 4. The app

TestPilot asks for the test environment URL (or, for mobile, the APK or IPA path). It stores the address as a shared default in `.env.example` so teammates use the same environment, and refuses addresses that look like production unless you confirm.

It then offers extras: **exploring the app** (it opens the site, visits a few pages and records each button, field and link with a stable way to find it), accessibility checks, visual tests, an API layer for test data, a test-data factory and parallel runs. Exploration makes the generated tests much better, so it is worth saying yes.

## 5. Test cases

"Do you have the test cases saved in Jira, BrowserStack, Excel or a Word document?" Point TestPilot at the file, for example `docs/regression.xlsx`, or at the Jira query or project.

TestPilot reads every sheet that has test-case columns, matching headers like "ID", "Title", "Steps", "Expected result" and "Priority" even when they are named differently, and handles one-row-per-case and one-row-per-step layouts, merged cells and numbered steps. Each case is saved in one common format under `.testpilot/test-cases/`, with a link back to where it came from. Re-importing later updates changed cases and keeps their automation status.

## 6. Review and plan

TestPilot reviews each case and explains the result in plain words:

- **AUTOMATE**: clear steps, a checkable expected result, stable data.
- **MANUAL**: needs human judgement (for example "the layout looks good") or hardware that cannot be automated.
- **NEEDS-REWORK**: missing steps or expected results, several tests in one, or vague wording. TestPilot suggests a rewrite.

It also points out likely duplicates and gaps (a login test with no "wrong password" case, for example). You decide which suggestions to accept.

Then it writes `plans/automation-plan.md`: which cases are automated in which **wave** (critical paths first), which stay manual, the effort, the test hooks the developers may need to add, and the risks. A named person approves the plan, and the approval is recorded.

## 7. Generate

"Shall I write the tests for the first wave?" TestPilot shows the files first: page objects with the locators it found during exploration, and one test per case named and tagged with the case id (`TC-001 user can log in @TC-001`). Steps it could not turn into code become clear TODOs, and such tests are marked `fixme` (Playwright), `skipUntilDone` (TestNG) or `@testpilot-todo` (Cucumber) so they never pass by accident. Passwords come from `.env`, never from the code.

With the BDD pattern each case becomes a Gherkin scenario (`features/<area>/<ID>.feature`, or `src/test/resources/features/` in Java) and every step text gets one step definition in `steps/generated.steps.ts` (or `.js`) or `GeneratedSteps.java`. With Selenium the page objects land in `src/main/java/<package>/pages/` and the tests in `src/test/java/<package>/tests/<area>/`.

## 8. Run

"Shall I run the new tests?" TestPilot runs them, then runs them again to catch flaky tests. Each failure gets a likely cause and advice:

| Cause | What it means | Usual fix |
|---|---|---|
| locator | The button or field could not be found | Update the page object; prefer role and label |
| timing | Something took longer than allowed | Wait for a specific condition, not a fixed time |
| data | Wrong or used-up test data, or an account problem | Fix the data in `.env` or `test-data/` |
| environment | The site, network or browser was not available | Check the test environment and `.env` |
| assertion | The app did something different from the expected result | Possibly a real bug: check the screenshot and trace |
| script | The test code itself is broken | Fix the code |

The full Playwright report opens with `npx playwright show-report`; every failure has a screenshot, a video and a trace. Java projects run with `mvn test` (`-Dgroups=<ID>` or `-Dcucumber.filter.tags=@<ID>` for one case); their screenshots are under `target/screenshots/` and the reports under `target/surefire-reports/`.

## 9. Report and CI

TestPilot writes a one-page HTML report (`.testpilot/reports/latest.html`) that anyone can open, showing pass rate, progress against the plan, failures by cause, flaky tests and the trend. It can add the pipeline for your CI system and lists the secrets to add there. Mobile app pipelines run on BrowserStack real devices, because CI machines have no phones; desktop app tests need a self-hosted runner with the app installed. If your test cases live in Xray, Zephyr, TestRail, BrowserStack or Azure Test Plans, it can send the results back after you approve.

## Coming back later

Open the repository in any AI tool with TestPilot and ask **"Where are we?"** (`/qa-status`). Because everything is saved in `.testpilot/`, it does not matter which tool or which person ran the earlier steps. Typical follow-ups:

- "Import the new test cases from the sprint 14 sheet and review them."
- "Generate wave 2."
- "Run the checkout tests and tell me why they fail."
- "Send the last results to TestRail."

## Using ChatGPT or claude.ai

On a hosted TestPilot the steps are the same, with three differences: you work in a named workspace (say "use workspace shop-web"), you attach or paste test-case files instead of pointing at a path, and at the end you ask for a **zip** or a **pull request** instead of finding the files in your repository. Tests run on your computer or in CI, not on the server.
