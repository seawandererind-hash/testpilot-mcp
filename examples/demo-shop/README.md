# Demo shop: a 15-minute TestPilot walkthrough

A tiny two-page shop and five test cases, for trying TestPilot or training a team. The cases are deliberately mixed: three can be automated, one needs a person (`SHOP-4`, "matches the brand guide"), and one is too vague to automate (`SHOP-5`).

## 1. Start the shop

```bash
cd examples/demo-shop/site
python3 -m http.server 4599      # or: npx serve -l 4599
```

Open http://localhost:4599: a sign-in form, and a products page with an "Add to cart" button and a cart counter. Any email and password signs in.

## 2. Make a practice repository

```bash
mkdir ~/demo-shop-tests && cd ~/demo-shop-tests
git init && npm init -y
cp -r /path/to/testpilot-mcp/examples/demo-shop/test-cases .
```

Open the folder in your AI tool with TestPilot installed ([install guide](../../docs/install.md)).

## 3. Talk to TestPilot

| You say | What happens |
|---|---|
| "Set up test automation for this repo." | Questions start: web, Playwright, TypeScript, Page Object Model, this computer, CSV, GitHub Actions, HTML + JUnit |
| (copy `.env.example` to `.env`, set `TEST_USER_EMAIL=qa@example.com` and any `TEST_USER_PASSWORD`) "Done." | TestPilot checks the keys are present without reading them |
| "Yes, create the framework, and install." | The preview lists about 35 files; after your yes they are written and Playwright is installed |
| "The URL is http://localhost:4599. Explore the app." | Two pages and their buttons, fields and links are recorded in `.testpilot/exploration/` |
| "Import test-cases/shop.csv and review them." | 3 AUTOMATE, 1 MANUAL, 1 NEEDS-REWORK, with reasons |
| "Build the plan. I approve it, my name is …" | `plans/automation-plan.md` with waves; your approval is logged |
| "Generate wave 1." | Page objects and one spec per case, previewed first |
| "Run them twice to check they are stable." | All pass; results in `.testpilot/runs/` |
| "Write the report and the GitHub pipeline." | `.testpilot/reports/latest.html` and `.github/workflows/ui-tests.yml` |

## 4. Break something on purpose

Change the button text in `site/index.html` from "Sign in" to "Log in" and ask TestPilot to run the login test again. It reports a **locator** failure and points at the page object to update. Change "Products" in `site/products.html` and the failure becomes an **assertion**: the app no longer shows what the test case expects.
