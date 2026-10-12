# Running a hosted TestPilot (ChatGPT, claude.ai and shared servers)

ChatGPT and claude.ai can only reach MCP servers on the internet. Hosted mode runs one TestPilot for the whole organisation behind company sign-in. People connect it as an app (ChatGPT) or a custom connector (claude.ai) and get the same guided workflow, with three differences:

| | On a computer (stdio) | Hosted |
|---|---|---|
| Where files go | Straight into the open repository | A named **workspace** per person on the server |
| Test-case files | Any file in the repository | Pasted or attached in chat, saved with `hosted_workspace` action `add-file`; Jira, Xray, TestRail and the other trackers work as usual |
| Runs programs | Yes: installs, exploration, test runs | **Never.** No installs, browsers or test runs on the server |
| Handing over | Already in the repository | A **zip** behind a signed one-hour link, or a **draft pull request** in an allowed GitHub organisation |
| Secrets | `.env` on the person's computer | None in workspaces. Tracker credentials (if any) are service accounts set by you on the server |

## 1. Choose how people sign in

**Company sign-in (recommended).** TestPilot is an OAuth resource server: your identity provider issues the tokens and TestPilot checks their signature, issuer, audience and expiry against the provider's published keys. Each person gets their own workspaces, and their name goes into the decision log and pull requests.

Register TestPilot with your identity provider:

- **Microsoft Entra ID**: App registrations → New registration "TestPilot". Under **Expose an API**, set the Application ID URI (for example `api://testpilot`) and add a scope `testpilot.use`. Add the redirect URIs of the clients your people use (ChatGPT and claude.ai show theirs when you add the connector). Issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`. Audience: the Application ID URI or the app's client ID, whichever your tokens carry in `aud` (set `accessTokenAcceptedVersion` to 2 in the manifest).
- **Okta**: Security → API → Authorization Servers → add a server with audience `https://testpilot.example.com/mcp` and a scope `testpilot`. Issuer: `https://<your-okta-domain>/oauth2/<server-id>`.
- **Auth0**: Applications → APIs → Create API with identifier `https://testpilot.example.com/mcp`. Issuer: `https://<tenant>.auth0.com/`.
- **Keycloak**: create a client scope and an audience mapper for TestPilot's URL. Issuer: `https://<host>/realms/<realm>`.

Then set:

```bash
TESTPILOT_OAUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
TESTPILOT_OAUTH_AUDIENCE=api://testpilot        # default: the public URL
TESTPILOT_OAUTH_SCOPES=testpilot.use            # optional: scopes every call needs
```

TestPilot reads the provider's metadata at start-up and advertises it at `/.well-known/oauth-protected-resource/mcp`, so ChatGPT and claude.ai discover where to sign in by themselves. If your provider does not support dynamic client registration, create a client for each of ChatGPT and claude.ai and give people the client ID to enter when they add the connector.

**One shared token (small teams, trials).** Set `TESTPILOT_HTTP_TOKEN` to a random value of 24 characters or more (`openssl rand -base64 32`). Everyone who has the token shares one set of workspaces. Clients that support custom headers send `Authorization: Bearer <token>`.

## 2. Pull requests (optional)

To let people hand over their workspace as a draft pull request, give TestPilot a GitHub token that can create branches and pull requests, and list the organisations it may write to:

```bash
TESTPILOT_GITHUB_TOKEN=<fine-grained token or GitHub App installation token>
TESTPILOT_GITHUB_OWNERS=acme,acme-qa
TESTPILOT_GITHUB_API=https://github.example.com/api/v3   # only for GitHub Enterprise Server
```

A fine-grained token needs **Contents: read and write** and **Pull requests: read and write** on the repositories teams will use. Every pull request is previewed first, needs the person's explicit approval, opens as a draft on a new branch, and names who asked and who approved. TestPilot never pushes to an existing branch.

## 3. Run it

### Docker

```bash
docker build -t testpilot-mcp .
docker run -d --name testpilot -p 3333:3333 \
  -v testpilot-workspaces:/data \
  -e TESTPILOT_PUBLIC_URL=https://testpilot.example.com/mcp \
  -e TESTPILOT_OAUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0 \
  -e TESTPILOT_OAUTH_AUDIENCE=api://testpilot \
  -e TESTPILOT_DOWNLOAD_SECRET=$(openssl rand -hex 32) \
  testpilot-mcp
```

The image runs `testpilot-mcp --remote` as a non-root user, keeps workspaces in `/data`, and answers health checks at `/healthz`.

### Node directly

```bash
npm ci && npm run build
TESTPILOT_OAUTH_ISSUER=... node dist/index.js --remote \
  --public-url https://testpilot.example.com/mcp \
  --workspaces /var/lib/testpilot --port 3333
```

### In front of it

- Terminate HTTPS at your load balancer or reverse proxy and forward `/mcp`, `/downloads/`, `/.well-known/` and `/healthz` to port 3333. ChatGPT and claude.ai only connect over HTTPS.
- Allow request bodies up to 20 MB (attached Excel files arrive base64-encoded).
- Do not buffer responses on `/mcp`: answers can stream as server-sent events.
- Running more than one instance? Put `/data` on shared storage and set the same `TESTPILOT_DOWNLOAD_SECRET` on all of them.

## 4. Connect the clients

Give people the URL (for example `https://testpilot.example.com/mcp`) and point them to the ChatGPT and claude.ai sections of [install.md](install.md). Local tools can use the same URL: Cursor and Claude Code take `url`, VS Code takes `"type": "http"` with `url`, and Antigravity takes `serverUrl`.

## 5. Trackers in hosted mode

People cannot put credentials into a hosted workspace. If teams should import from or send results to Jira, Xray, Zephyr, TestRail, BrowserStack or Azure DevOps through the hosted server, set service-account credentials as server environment variables, using the same names as `.env.example` (for example `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`). Everyone using the server then imports with that account's permissions, so use a read-only account for imports and a separate decision for result sync. Without them, people paste or attach their test cases instead.

## 6. Operating it

- **Workspaces** live under `<workspaces>/<user-key>/<workspace-name>/`, where the user key is a hash of the person's issuer and subject. Delete old ones with an ordinary cleanup job; TestPilot keeps only the three newest zips per workspace.
- **Download links** are signed, expire after one hour, and only serve files from the workspaces folder.
- **Audit**: each workspace has `.testpilot/audit.log.jsonl` (every tool call, secrets redacted) and `.testpilot/decisions.md` (every approval and who gave it). Server logs go to standard error.
- **Updates**: rebuild the image from a new release. Workspaces are plain files and survive upgrades.

## Settings reference

| Setting | Meaning |
|---|---|
| `--public-url` / `TESTPILOT_PUBLIC_URL` | Public URL of the MCP endpoint (HTTPS outside localhost). Its path is the endpoint path |
| `--workspaces` / `TESTPILOT_WORKSPACES` | Folder for workspaces (default `./testpilot-workspaces`) |
| `--port` / `PORT`, `--host` | Listen address (hosted default `0.0.0.0:3333`) |
| `TESTPILOT_OAUTH_ISSUER` | Identity provider issuer URL |
| `TESTPILOT_OAUTH_AUDIENCE` | Required `aud` value (default: the public URL) |
| `TESTPILOT_OAUTH_SCOPES` | Scopes every call needs (space or comma separated) |
| `TESTPILOT_HTTP_TOKEN` | Shared bearer token instead of OAuth |
| `TESTPILOT_DOWNLOAD_SECRET` | Key for signing download links |
| `TESTPILOT_GITHUB_TOKEN`, `TESTPILOT_GITHUB_OWNERS`, `TESTPILOT_GITHUB_API` | Pull-request delivery |
