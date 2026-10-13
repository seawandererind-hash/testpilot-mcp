# TestPilot scorecard

Measured on 2026-10-13 with TestPilot 0.1.3 (linux, Node v22.22.0) by `scripts/scorecard.mjs`, which plays the whole demo against the practice shop through the MCP protocol, the way an AI tool does. No step is mocked.

| Measure | Result |
|---|---|
| Steps that worked | 25 of 25 |
| Setup (demo + framework, browser download skipped) | 3s |
| Tests generated for plan wave 1 | 2 (0 steps left for the AI to finish) |
| First-run pass rate | 100% |
| Flaky after two runs | 0 |
| Failures after renaming the Sign in button | 2 |
| Heals proposed / passing after apply | 1 / 1 |
| Live test steps done on its own (SHOP-1) | 4 |
| Quality gate verdict | ready |
| Whole story | 46s |

## Steps

| Step | Tool | Result | Time |
|---|---|---|---|
| Start the demo | `demo_project` | ok | 0.2s |
| Preview the framework | `preview_scaffold` | ok | 0.1s |
| Create the framework | `scaffold_project` | ok | 0.1s |
| Explore | `explore_app` | ok | 2.5s |
| Import test cases | `import_test_cases` | ok | 0.0s |
| Review | `review_test_cases` | ok | 0.0s |
| Watch it test (start) | `live_test` | ok | 1.6s |
| Watch it test (auto) | `live_test` | ok | 1.0s |
| Watch it test (finish) | `live_test` | ok | 0.2s |
| Plan | `automation_plan` | ok | 0.0s |
| Approve the plan | `automation_plan` | ok | 0.0s |
| Preview tests | `preview_tests` | ok | 0.0s |
| Generate tests | `generate_tests` | ok | 0.0s |
| First run | `run_tests` | ok | 4.4s |
| Stability run (x2) | `run_tests` | ok | 5.2s |
| Accessibility scan | `quality_scan` | ok | 3.3s |
| Quality gate | `quality_scan` | ok | 2.0s |
| Break the app | `demo_project` | ok | 0.0s |
| Run after the break | `run_tests` | ok | 19.1s |
| Propose heals | `heal_tests` | ok | 0.0s |
| Apply heals | `heal_tests` | ok | 3.3s |
| Coverage map | `insights` | ok | 0.0s |
| Report | `publish_results` | ok | 0.0s |
| Put the app back | `demo_project` | ok | 0.0s |
| Stop the shop | `demo_project` | ok | 0.0s |
