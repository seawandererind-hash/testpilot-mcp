# TestPilot security model

This page is for security and platform reviewers. It describes what TestPilot can touch, what it never does, and how each promise is enforced in code.

## What TestPilot can do

| Mode | Reads | Writes | Runs | Network |
|---|---|---|---|---|
| Local (stdio, or HTTP on localhost) | Files inside the chosen repository | Files inside the chosen repository, after a preview and approval where it matters | `npm install`, Playwright or Appium/WebdriverIO, only when the person asks and approves | Test-management and tracker APIs the person configured in `.env`; the app under test during exploration and runs |
| Hosted (`--remote`) | The signed-in person's own workspaces | The same workspaces, a zip in the workspace, and draft pull requests in allowed GitHub owners | Nothing. Tools that run programs are switched off | The identity provider (signing keys), GitHub (if configured), trackers (if the administrator set service credentials) |

## Promises and where they are enforced

**Secrets never pass through the model.**
No tool has a parameter for a credential, and none returns one. `check_env` reports present / missing / invalid-format only (`src/core/env.ts`). Integration code reads `.env` inside the server and builds requests there (`src/integrations/`, `src/testcases/importers/`). Every tool result, audit entry and imported text goes through redaction (`src/core/redact.ts`): known token formats (bearer, basic, JWT, GitHub, Slack, AWS, Atlassian, private keys, URL credentials) and `key=value` pairs whose key looks secret. Error messages from test runs have every secret value from `.env` replaced before they are returned (`secretScrubber` in `src/run/playwright.ts`). Generated pipelines refer to CI secrets by name, never by value.

**Nothing destructive or external without the person's yes.**
Scaffolding, overwriting files, writing CI pipelines, sending results to a tracker, running against a URL that does not look like a test environment, and opening pull requests all follow the same pattern (`requireApproval` in `src/tools/common.ts`):
1. A preview call returns exactly what would change and a confirm token derived from that content.
2. The applying call must present the same token, so the change cannot differ from what was shown.
3. If the AI tool supports MCP forms, the person approves in a form the model cannot fill in. Otherwise the person must say yes in chat and the model passes `userApproved: true`; the approver's name and the channel go into `.testpilot/decisions.md`.

**Imported content is data.**
Test cases, web pages, app screens and tracker responses are never interpreted as instructions. Imported text is stripped of control characters, length-capped, redacted, and checked for injection patterns ("ignore previous instructions", "you are now an assistant", `<system>` tags, "run this command", `curl`/`wget` URLs, requests to send secrets and similar). Flagged cases are reported at import, and the generator skips them until a person edits the flagged text (`src/testcases/normalize.ts`, `src/generate/`). Tool descriptions and results remind the model of this.

**No writes outside the repository.**
Every path goes through `safeJoin` (`src/core/paths.ts`), which rejects absolute paths and `..`, and resolves symbolic links to make sure the real target is inside the root. Writes are atomic (temporary file, then rename). In hosted mode, workspace names are short slugs, never paths, and each person's workspaces sit under a folder derived from a hash of their issuer and subject.

**Generated tests stay honest.**
The generators (`src/generate/`) use role, label and test-id locators, wait for conditions instead of fixed sleeps, take credentials from `.env` or test data at run time, mark unfinished steps as `fixme`/pending instead of passing silently, and never relax an assertion. Run triage advises fixing causes, not assertions.

## Hosted mode specifics

- **Authentication**: OAuth 2.0 resource server. Tokens are JWTs from the configured issuer, verified locally (RS256/384/512, PS256/384/512, ES256/384/512, EdDSA) against the provider's JWKS with checks on issuer, audience, expiry and not-before, plus optional required scopes. Protected Resource Metadata (RFC 9728) is published so clients discover the provider. A shared bearer token is supported for small teams; it is compared in constant time and must be at least 24 characters.
- **Isolation**: one folder per person; a workspace that resolves outside that folder is refused.
- **No code execution**: `run_tests`, `explore_app`, `check_prerequisites` and dependency installs are refused in hosted mode.
- **Uploads**: only test-case document types (`.xlsx .xls .csv .tsv .docx .md .feature .txt .json`), at most 10 MB, saved under `inputs/`. `.env` files cannot be uploaded.
- **Downloads**: HMAC-signed links that expire after one hour and can only serve files inside the workspaces folder. `.env` files, `node_modules`, reports and other build output are never packed; files that look like they contain a credential are listed in the preview.
- **Pull requests**: only to owners in `TESTPILOT_GITHUB_OWNERS`; always a new branch and a draft pull request; previewed and approved first; the body names who asked and who approved. The GitHub token never leaves the server.
- **Transport**: HTTPS is required for non-local public URLs. A server bound to a loopback address checks `Host` and `Origin` headers against DNS rebinding.

## Audit trail

Each repository or workspace keeps `.testpilot/audit.log.jsonl` (one line per tool call: time, tool, redacted arguments, outcome) and `.testpilot/decisions.md` (each decision, why, who approved it and how). Both are plain files that can be reviewed in pull requests.

## Reporting a problem

Report suspected vulnerabilities privately to the repository owners rather than in a public issue.
