# TestPilot MCP · Phase 0 research

Researched on 2026-10-12 against official docs, npm and vendor pages. Every fact in Parts A to C has its source link next to it. **UNVERIFIED** marks anything no official source confirmed. Part 0 is the summary: what the findings change in the build guide.

## Part 0 · What changes in the design

### Must change before Phase 1
| # | Build guide said | Research found | Decision |
|---|---|---|---|
| 1 | Official `@modelcontextprotocol/sdk` (latest) | That package is v1 (1.32.1). It's maintenance-only and will never support protocol 2026-07-28. SDK v2 (`@modelcontextprotocol/server` 2.3.1, released 2026-07-27) is split into packages and needs Zod ^4.2 | Build on SDK v2 and Zod 4 |
| 2 | Dual-era support (2025-06-18, 2025-11-25, 2026-07-28) | Confirmed: Cursor still speaks only 2025-11-25 and earlier, with no timeline. SDK v2 serves both eras from one factory by default (`serveStdio`, `createMcpHandler`) | Use the built-in support; CI tests both eras |
| 3 | Node 20+ | Node 20 reached end of life in April 2026. MCP Inspector needs 22.19+, `appium-mcp` and webdriverio 10 need 22+, and Playwright docs list 22/24/26 | Require Node ≥ 22.19 |
| 4 | Elicitation when the client supports it | In 2026-07-28, server-to-client requests are replaced by "input required" round trips. SDK v2's `inputRequired()` works in both eras through a built-in shim. The older `elicitInput` throws on modern requests | Build the wizard on `inputRequired()`, falling back to `wizard_next` text |
| 5 | Never collect secrets in chat | Confirmed and stronger: the spec says servers MUST NOT ask for passwords, API keys or tokens in form elicitation, and stdio servers SHOULD read credentials from the environment | Keep the `.env` plus presence-check design |
| 6 | Desktop: Appium Windows / NovaWindows driver | `appium-windows-driver` is now deprecated (WinAppDriver is unmaintained). Its official replacement is `appium-wincore-driver` (3.1.2); NovaWindows is the community alternative | Default to WinCore; offer NovaWindows |
| 7 | `.agents/skills/` canonical, synced to each tool | `.agents/skills` is read by Cursor, VS Code/Copilot, Antigravity, Codex, Devin Desktop and Gemini CLI. **Claude Code reads only `.claude/skills`** | Write `.agents/skills` and mirror to `.claude/skills` |
| 8 | `CLAUDE.md` pointing to AGENTS.md | Claude Code reads AGENTS.md only when no CLAUDE.md exists. `@AGENTS.md` import works | Generate a one-line `CLAUDE.md`: `@AGENTS.md` |

### Smaller corrections
- **Antigravity**: project MCP config is `.agents/mcp_config.json`. Remote servers need `serverUrl`, because `url`/`httpUrl` are rejected. Rules go in `.agents/rules/*.md` and need `trigger:` frontmatter, or they are silently dropped.
- **VS Code**: prefers the portable root `.mcp.json` (`mcpServers`). `.vscode/mcp.json` (`servers`) is called deprecated on one VS Code page but not in the config reference, so write `.mcp.json`.
- **Windsurf** was renamed **Devin Desktop** (2026-06-02). Its MCP config is user-level only, and the docs disagree on the path.
- **Gemini CLI** stopped serving consumer tiers on 2026-06-18. Antigravity CLI (`agy`) replaced it.
- **Claude Desktop**: `.mcpb` bundles still install by double-click, but the Anthropic directory no longer accepts them. It recommends distributing through a plugin.
- **ChatGPT**: remote only. Treats every tool without `readOnlyHint` as a write that needs confirmation. Developer mode with write actions is on Business/Enterprise/Edu; Pro gets read/fetch only.
- **Tool count**: Devin Desktop caps all servers at 100 tools combined. Cursor's historical 40-tool cap is UNVERIFIED today. Claude Code has no cap. In 2026-07-28, `tools/list` must not vary per connection, so tool lists can't be switched per wizard step. **Decision: consolidate the ~33 tools in the guide into about 15** (e.g. one `wizard` tool with actions, one `test_cases` tool with import/normalize/review).
- **Annotations**: every tool needs `title` plus `readOnlyHint`/`destructiveHint` (Anthropic directory rule). Keep `outputSchema` object-shaped for 2025-era clients, and also return JSON as text.
- **Output limits**: Claude Code caps a tool result at 25k tokens; claude.ai caps it at ~150k characters and a 240 s timeout. Return summaries plus `resource_link`s to files in the repo.
- **Roots and sampling** are deprecated in 2026-07-28. Take the project root as a tool parameter and confirm it once.
- **MCP Inspector** 2.10.1 defaults to the legacy era. Run CI with `--protocol-era legacy` and `--protocol-era modern`.
- **iOS**: simulators still need macOS. Real devices on iOS 18+ can be driven from Windows/Linux with limits.
- **Playwright test agents** (planner/generator/healer, since 1.56) and the bundled `npx playwright mcp` exist. TestPilot can reuse them for exploration and healing instead of building its own.
- **Traceability**: in Playwright 1.64 the JUnit reporter writes annotations as properties in a format Xray accepts, so `annotation: { type: 'test_key', description: 'PROJ-1' }` needs no extra package.
- **BrowserStack** lags upstream:
  - Appium up to 3.5.2 only.
  - WebdriverIO 7–9 only.
  - App upload returns `bs://…` and keeps the app for 30 days.
  - **Decision:** pin versions per execution target.
- **Jira**: `/rest/api/3/search` has been removed (use `/search/jql` with `nextPageToken`), and API tokens expire after at most 365 days. `test_connection` should warn before a token expires.
- **Zephyr** renamed: Scale is now "Zephyr" and Squad is "Zephyr Essential". `POST /testexecutions` now needs `spaceKey`.
- **Azure DevOps**: global PATs stop working on 2026-12-01. Use org-scoped PATs or Entra tokens.
- **Parsers**: npm `xlsx` is frozen at 0.18.5 (real SheetJS is installed from cdn.sheetjs.com), and exceljs 4.4.0 is in maintenance. **Decision:** exceljs for Phase 2, behind an interface. Use mammoth for .docx (tables only via HTML output) and `@cucumber/gherkin` 42 for `.feature` files.

### Versions to pin (npm, 2026-10-12)
| Package | Version |
|---|---|
| @modelcontextprotocol/server / client / core | 2.3.1 |
| @modelcontextprotocol/node | 2.1.1 |
| @modelcontextprotocol/inspector | 2.10.1 |
| zod | 4.6.6 |
| @playwright/test, playwright | 1.64.0 |
| @playwright/mcp | 0.0.83 |
| appium | 3.8.0 |
| appium-uiautomator2-driver | 8.7.0 |
| appium-xcuitest-driver | 12.17.1 |
| appium-mac2-driver | 4.4.0 |
| appium-wincore-driver | 3.1.2 |
| appium-novawindows-driver | 1.4.5 |
| appium-mcp | 1.97.0 |
| webdriverio | 10.0.2 (9.x for BrowserStack) |
| exceljs | 4.4.0 |
| mammoth | 1.13.0 |
| @cucumber/gherkin | 42.0.1 |
| allure-playwright | 3.13.0 |

### Still unverified (re-check during the phase that needs it)
- Zephyr endpoint paths, Xray token lifetime and regional hosts, and the qTest base URL and auth (Phase 5).
- Cursor's current tool cap, whether Cursor reads a root `.mcp.json`, and env interpolation in Antigravity (Phase 3).
- Elicitation support in Claude Desktop, claude.ai and Antigravity (Phase 1 client testing).
- Devin Desktop's MCP config path.

---

## Part A · MCP spec, SDK, clients, Inspector


Researched 2026-10-12. Every fact is followed by its source. Anything not confirmed from an official
spec, SDK or vendor source is marked **UNVERIFIED**. Vendor community forums are labelled as such.

## 1. Spec revisions

**Published revisions:** 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25 and **2026-07-28 (current)**
([versioning](https://modelcontextprotocol.io/specification/versioning),
[llms.txt index](https://modelcontextprotocol.io/llms.txt)). The draft changelog has no entries yet
([draft changelog](https://modelcontextprotocol.io/specification/draft/changelog)). The SDK also accepts
2024-10-07 as a legacy version
([v2 protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md)).

**The "2026-07-28 stateless" claim is TRUE.** That revision was released 2026-07-28, together with the TS,
Python, Go and C# SDKs ([blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)).

**The "Cursor rejects modern-only servers" claim is TRUE.** A Cursor staff member wrote on Cursor's official forum (2026-09-21) that the client "currently speaks the 2025-11-25 revision and earlier". The staff member also said there is no client-side workaround and, on 2026-09-25, "No timeline at the moment!" The fix has to be server-side: keep a legacy `initialize` path, which makes the server "dual-era" ([Cursor forum](https://forum.cursor.com/t/mcp-client-cannot-connect-to-modern-only-2026-07-28-streamable-http-servers-legacy-initialize-rejected/172536)).

### What changed in each revision (only the parts relevant to us)
- **2025-03-26**
  - Added OAuth 2.1 authorization, Streamable HTTP (replaces HTTP+SSE), JSON-RPC batching, **tool annotations**, audio content and the `completions` capability ([changelog](https://modelcontextprotocol.io/specification/2025-03-26/changelog)).
- **2025-06-18**
  - Removed batching.
  - Added **structured tool output** (`structuredContent`/`outputSchema`), **elicitation** (form only), **resource links** in tool results and the `title` field.
  - Servers became OAuth Resource Servers (Protected Resource Metadata), and clients MUST use RFC 8707 resource indicators.
  - Clients must send the `MCP-Protocol-Version` header on HTTP ([changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog)).
- **2025-11-25**
  - Added **URL-mode elicitation**, the enum schema rework (titled/multi-select), default values in elicitation schemas and **experimental tasks**.
  - Added icons, tool-name guidance, sampling with tools, Client ID Metadata Documents (CIMD), OpenID Connect discovery and incremental scope consent.
  - JSON Schema 2020-12 became the default dialect.
  - Input-validation errors should be returned as tool execution errors (`isError`), not protocol errors ([changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)).
- **2026-07-28** (breaking) ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)):
  - **Stateless.** Removes the `initialize`/`initialized` handshake. Every request carries `_meta` with `io.modelcontextprotocol/protocolVersion`, `clientCapabilities` and (SHOULD) `clientInfo`. Servers MUST implement `server/discover`. A version mismatch returns `UnsupportedProtocolVersionError` (-32022).
  - Removes `Mcp-Session-Id` sessions. `tools/list` MUST NOT vary per connection but MAY vary by authorization. For cross-call state, return explicit handles as tool arguments ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
  - **MRTR (Multi Round-Trip Requests)** replaces server-initiated requests (elicitation, sampling, roots). A server returns `resultType:"input_required"` with `inputRequests` and an optional `requestState`, and the client retries with `inputResponses`. This is allowed only on `tools/call`, `prompts/get` and `resources/read`. `requestState` is attacker-controlled: protect it with HMAC/AEAD if it affects authorization or business logic ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)).
  - Removes the HTTP GET stream, `resources/subscribe`, `ping`, `logging/setLevel`, SSE resumability (`Last-Event-ID`), `notifications/elicitation/complete` and `elicitationId`. Adds `subscriptions/listen`. The log level is now per request via `_meta` (changelog).
  - **Tasks moved to an extension** (`io.modelcontextprotocol/tasks`), polled with `tasks/get` (changelog).
  - New Streamable HTTP rules: required `Mcp-Method`/`Mcp-Name` headers that must match the body (400 with -32020 otherwise), and optional `x-mcp-header` mirroring of tool parameters. Do NOT mark secrets with `x-mcp-header`. Validate `Origin` (403) and bind to 127.0.0.1 when running locally ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
  - Required `ttlMs`/`cacheScope` on list and read results. `tools/list` SHOULD be in deterministic order. `inputSchema`/`outputSchema` may use any JSON Schema 2020-12 keyword, and `structuredContent` may be any JSON value (changelog).
  - Authorization: RFC 9207 `iss` validation. **DCR deprecated in favour of CIMD**. **Roots, Sampling and Logging deprecated** (kept for at least 12 months). HTTP+SSE formally deprecated (changelog).
- **Tool annotations** (hints only; clients MUST treat them as untrusted unless the server is trusted). Defaults: `readOnlyHint` false; `destructiveHint` true; `idempotentHint` false; `openWorldHint` true. destructive and idempotent are only meaningful when readOnly is false ([schema.ts](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
- **Structured output**
  - With an `outputSchema`, servers MUST return conforming `structuredContent`.
  - A tool with structured output SHOULD also return the serialized JSON in a TextContent block for backward compatibility ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
  - In 2025-11-25, `outputSchema` must be `type:"object"` and `structuredContent` an object. **For dual-era, keep outputs object-shaped** ([2025-11-25 schema.ts](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.ts)).
- **Resource links**: a `{type:"resource_link", uri, name, mimeType}` content item. It is not guaranteed to appear in `resources/list` ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
- **Tool names**: SHOULD be 1–128 characters from `[A-Za-z0-9_.-]` and case-sensitive ([tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). Anthropic's directory requires 64 characters or fewer ([review criteria](https://claude.com/docs/connectors/building/review-criteria.md)).
- **Authorization (HTTP)**
  - Optional. When used: OAuth 2.1; servers MUST publish RFC 9728 Protected Resource Metadata and MUST validate the token audience (RFC 8707). Token passthrough is forbidden.
  - **stdio servers SHOULD NOT use OAuth and should take credentials from the environment** ([authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).

### Backward compatibility (servers)
- A server MAY be **dual-era**:
  - A request with modern `_meta` is served statelessly.
  - An `initialize` request selects legacy semantics for that stdio process or HTTP session.
  - A legacy client talking to a modern-only server fails, because legacy clients cannot move forward to the newer protocol ([versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
- A modern-only server SHOULD name its supported versions in the error it returns to `initialize`. On HTTP it should return 405 for GET/DELETE and ignore `Mcp-Session-Id` ([versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
- Era detection by modern clients:
  - stdio: a `server/discover` probe; any non-modern error or a timeout means legacy ([stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)).
  - HTTP: a modern request; a 400 without a recognised modern error body means legacy ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).

## 2. Elicitation and secrets (spec)
Source: [2026-07-28 elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).
- Servers **MUST NOT** use form mode to request "passwords, API keys, access tokens, or payment credentials", and **MUST** use URL mode for those. Name, email and username are not prohibited outright.
- In URL mode, sensitive data "must not pass through the MCP client".
  - Servers MUST NOT put credentials or personal data in the URL, and MUST NOT send pre-authenticated URLs.
  - Servers MUST verify that the user who opens the URL is the user who triggered the request (phishing).
  - Servers MUST NOT send credentials obtained this way to the client.
  - URL mode is NOT for authorizing the client to the MCP server; MCP auth does that.
- Capabilities: `elicitation:{form:{},url:{}}`. An empty `{}` means form only. Servers MUST NOT send a mode the client did not declare.
- Form schemas are a flat object of primitives:
  - string, with formats email, uri, date and date-time
  - number or integer, boolean
  - enum, single- and multi-select, with or without titles
  - `default` is allowed
- Results are `accept`, `decline` or `cancel`. Servers MUST handle decline, cancel and client failure.
- In 2026-07-28, elicitation travels inside `InputRequiredResult`, and URL-mode completion is detected when the client retries.

## 3. Official TypeScript SDK
- **v1, `@modelcontextprotocol/sdk` 1.32.1** (published 2026-10-05) is a **maintenance line that implements the spec up to 2025-11-25**. "Support for the 2026-07-28 spec is not planned for v1.x" ([v1 README in the npm tarball](https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.32.1.tgz)).
  - Gets fixes for at least 6 months after the v2 release on 2026-07-27, so roughly until late January 2027 ([repo README](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md)).
  - zod `^3.25 || ^4.0`, Node `>=18`. `SUPPORTED_PROTOCOL_VERSIONS` = 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07. API includes `Server.elicitInput()` and `getClientCapabilities()` ([npm registry](https://registry.npmjs.org/@modelcontextprotocol%2fsdk), tarball `dist/esm/types.js` and `server/index.d.ts`).
- **v2 is the current stable line (2.0.0 released 2026-07-27) and is split into packages** ([repo README](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md)):
  - `@modelcontextprotocol/server` 2.3.1, `/client` 2.3.1, `/core` 2.3.1
  - adapters: `/node` 2.1.1, `/express` 2.0.2, `/hono` 2.0.2, `/fastify` 2.0.1
  - migration only: `/server-legacy` and `/codemod`
  - Node `>=20` ([npm registry](https://registry.npmjs.org/@modelcontextprotocol%2fserver), [packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages.md))
- **v2 serves both eras.** It implements 2026-07-28 and serves 2025-era clients from the same factory by default:
  - `createMcpHandler(factory, {legacy:'stateless'|'reject'})` defaults to `stateless`.
  - `serveStdio(factory, {legacy})` defaults to `serve`.
  - The factory receives `{era, authInfo, requestInfo}`.
  - Legacy GET/DELETE return 405. The v2 server does not serve HTTP+SSE.
  - Sources: [legacy clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.md), [protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md), [HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.md).
- **Zod:** v2 requires **zod `^4.2.0`; zod v3 is not supported**. Any Standard Schema library works (Zod v4, Valibot, ArkType), or use `fromJsonSchema()`. Import with `import * as z from 'zod/v4'` ([migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2), [README](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md)).
- **Registration (v2)** ([tools](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.md), [prompts](https://ts.sdk.modelcontextprotocol.io/v2/servers/prompts.md), [resources](https://ts.sdk.modelcontextprotocol.io/v2/servers/resources.md), [migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)):
  - `server.registerTool(name, {title, description, inputSchema: z.object(...), outputSchema, annotations}, async (args, ctx) => result)`
  - `registerPrompt(name, {argsSchema, ...}, cb)`
  - `registerResource(name, uriOrResourceTemplate, metadata, readCb)`
  - The variadic `.tool()`/`.prompt()`/`.resource()` forms are removed, and raw-shape schemas are deprecated.
  - The SDK validates arguments (errors come back as `isError` results) and validates `structuredContent` against `outputSchema`.
  - `maxToolInputElements` is available as an optional cap.
- **Transports (v2)** ([stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.md), [migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)):
  - stdio: `serveStdio` from `@modelcontextprotocol/server/stdio`. Log to stderr only.
  - HTTP: `createMcpHandler` returns `{fetch}`. On Node, use the `@modelcontextprotocol/node` adapter or `toNodeHandler` for Express.
  - Classes: `NodeStreamableHTTPServerTransport` (in `/node`) and `WebStandardStreamableHTTPServerTransport`.
- **Elicitation API (v2)** ([elicitation](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation.md), [input required](https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.md)):
  - `ctx.mcpReq.elicitInput({mode:'form'|'url', ...})` is the 2025-era push API, and it **throws on a 2026-07-28 request**.
  - The modern pattern: `return inputRequired({inputRequests:{k: inputRequired.elicit({message, requestedSchema})}})`, then read answers on re-entry with `acceptedContent(ctx.mcpReq.inputResponses, k, zodSchema)`.
  - **A legacy shim (on by default) fulfils `inputRequired` on 2025-era connections by pushing a real `elicitation/create`, so one handler serves both eras.**
  - A missing client capability is rejected with -32021, or with an `isError` "Client does not support form elicitation."
- **Reading client capabilities (v2)**: `ctx.mcpReq.envelope` per request on the modern era. `server.getClientCapabilities()` is deprecated; it still returns the `initialize` value on legacy connections and is backfilled from the envelope on modern ones ([protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md); `@modelcontextprotocol/server@2.3.1` `.d.cts`).
- **Testing (v2)**: `InMemoryTransport.createLinkedPair()` connects 2025-era instances only. Use `handler.fetch` for 2026-era tests in-process ([testing](https://ts.sdk.modelcontextprotocol.io/v2/testing.md)).

## 4. Client capability matrix
Legend: Y = documented by the vendor; N = documented as not supported; ? = not documented (**UNVERIFIED**).

| Client | Tools | Prompts | Resources | Elicitation | Roots | Sampling | stdio | Remote HTTP | OAuth | 2026-07-28 |
|---|---|---|---|---|---|---|---|---|---|---|
| Cursor | Y | Y | Y | Y (modes ?) | Y | ? | Y | Y (+SSE) | Y | **N** |
| Claude Code | Y | Y (`/mcp__srv__prompt`) | Y (`@srv:uri`) | Y form+url | Y (stdio) | N | Y | Y (+SSE, WS) | Y | Y (v2 runtime, auto-negotiates) |
| Claude Desktop | Y | Y | Y | ? | ? | N | Y (config / MCPB) | Y (connector) | Y | ? |
| claude.ai | Y | Y | Y | ? | ? | N | N | Y (+SSE) | Y | ? |
| VS Code Copilot | Y | Y (`/server.prompt`) | Y | Y (modes ?) | Y | Y | Y | Y (+SSE fallback) | Y | ? |
| Antigravity | Y | ? | Y | ? | ? | ? | Y | Y (+SSE) | Y | ? |
| Windsurf / Devin Desktop | Y | Y | Y | ? | ? | ? | Y | Y (+SSE) | Y | ? |
| ChatGPT dev mode / plugins | Y | ? | UI/skills only | Y (modes ?) | ? | ? | N | Y (+SSE) | Y | ? |

Row sources and limits:
- **Cursor**
  - Features and transports: [Cursor docs](https://cursor.com/docs/context/mcp) list tools, prompts, resources, roots, elicitation and Apps as "Supported", and transports stdio, SSE and Streamable HTTP. OAuth works through DCR or static `auth` credentials. Config lives in `.cursor/mcp.json` or `~/.cursor/mcp.json` and supports `${env:NAME}`. The docs don't mention sampling.
  - Protocol: speaks only 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 ([Cursor forum, staff](https://forum.cursor.com/t/mcp-client-cannot-connect-to-modern-only-2026-07-28-streamable-http-servers-legacy-initialize-rejected/172536)).
  - **Tool limit:**
    - The 40-tool limit is historical: a staff reply in June 2025 cited it ([Cursor forum](https://forum.cursor.com/t/request-increase-mcp-tools-limit-for-enhanced-development-workflow/108637)).
    - Current docs state no limit.
    - In July 2026 the CLI hit a per-model "Too many MCP tools" cap. Staff said on 2026-09-09 this was fixed by lazy loading ([Cursor forum](https://forum.cursor.com/t/cli-mcp-tool-limits/165642)).
    - Whether the 40-tool limit still applies today is **UNVERIFIED**.
- **Claude Code** ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)):
  - Elicitation form+url; on 2026-07-28 it declares `elicitation:{form:{},url:{}}`.
  - Prompts appear as `/server:prompt (MCP)`; resources are referenced with `@`; roots work for stdio.
  - The v2 runtime (SDK 2.0) probes servers and falls back to v1 behaviour (`MCP_SDK_GENERATION`, `MCP_PROTOCOL_NEGOTIATION`).
  - **No fixed tool cap**: tool search defers tool definitions until needed.
  - Output warning at 10k tokens and a 25k-token cap by default (`MAX_MCP_OUTPUT_TOKENS`). Tool descriptions and server instructions are truncated at 2,048 characters. Top-level schema property names must be 1–64 characters from `[A-Za-z0-9_.-]`.
  - Root-level `anyOf`/`oneOf`/`allOf` input schemas get flattened.
  - Optional `_meta` keys: `anthropic/alwaysLoad`, `anthropic/requiresUserInteraction`, `anthropic/maxResultSizeChars`.
- **Claude Desktop and claude.ai** ([Claude connector docs](https://claude.com/docs/connectors/building)):
  - Exposes tools, prompts and resources. "Claude doesn't yet support" resource subscriptions, sampling, or "advanced or draft capabilities".
  - Transports: Streamable HTTP, plus legacy HTTP+SSE.
  - OAuth follows the 2025-03-26, 2025-06-18 and 2025-11-25 auth specs. Supports DCR. Callback URL is `https://claude.ai/api/mcp/auth_callback`.
  - Limits: about 150,000 characters per tool result and a 240-second tool call timeout.
  - Directory review requires a `title` plus `readOnlyHint`/`destructiveHint` on every tool; these drive auto-permissions ([review criteria](https://claude.com/docs/connectors/building/review-criteria.md)).
  - Desktop runs local stdio servers through `claude_desktop_config.json` ([MCP docs](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)) or a `.mcpb` bundle ([MCPB](https://claude.com/docs/connectors/building/mcpb.md)).
  - MCP Apps: supported on Claude web and Desktop ([extension matrix](https://modelcontextprotocol.io/extensions/client-matrix.md)).
  - Elicitation, roots and 2026-07-28 support are not documented (**UNVERIFIED**).
- **VS Code Copilot**
  - Features: tools, prompts, resources, elicitation, sampling, OAuth, server instructions, roots and MCP Apps ([VS Code MCP guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)).
  - Transports: stdio, http, and legacy sse.
  - Config: `.vscode/mcp.json` with a top-level `servers` key; `inputs` hold secrets; optional sandbox on macOS and Linux ([VS Code config reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)).
  - Prompts run as `/<server>.<prompt>` ([VS Code docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers)).
  - The 128-tools-per-request limit and protocol 2025-11-25 come only from a third-party page (**UNVERIFIED**, [zuplo](https://zuplo.com/learn/mcp/compatibility/clients/vs-code.md)).
- **Antigravity** ([Antigravity docs](https://antigravity.google/docs/mcp/)):
  - Documents tools and resources.
  - Transports: stdio, plus `serverUrl` for Streamable HTTP or SSE.
  - OAuth is automatic for servers that support DCR; otherwise use `oauth{clientId, clientSecret}` with redirect `https://antigravity.google/oauth-callback`.
  - Config: `~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json`, using a `mcpServers` key.
  - A 100-tools-per-server limit comes from a user report on Google's forum (2026-05-08) with no staff reply (**UNVERIFIED**, [forum](https://discuss.ai.google.dev/t/critical-dx-issue-antigravity-ide-hardcoded-mcp-tool-limit-100-configuration-fragmentation-with-gemini-cli/143969)).
- **Windsurf** ([Devin Desktop docs](https://docs.devin.ai/desktop/cascade/mcp)):
  - `docs.windsurf.com` now redirects to Devin Desktop, which uses the name "Cascade" for its legacy agent.
  - Supports "an MCP server's tools, resources, and prompts".
  - Transports: stdio, Streamable HTTP, SSE; OAuth on each transport.
  - Config: `~/.config/devin/mcp_config.json`.
  - **"Cascade has a limit of 100 total tools."**
- **ChatGPT**
  - Developer mode is "full MCP client support for all tools, both read and write".
  - Transports: SSE and streaming HTTP. Auth: OAuth (static credentials, CIMD or DCR), none, or mixed.
  - **`readOnlyHint` is respected; tools without it count as write actions and need confirmation.**
  - Available on Pro, Plus, Business, Enterprise and Edu plans, on the web ([developer mode](https://developers.openai.com/api/docs/guides/developer-mode.md)).
  - Elicitation: "Use MCP elicitation when the server needs structured information…". Server instructions: keep the first 512 characters self-contained ([OpenAI build guide](https://developers.openai.com/plugins/build/mcp-server)).
  - Local servers need a public HTTPS endpoint or the Secure MCP Tunnel ([OpenAI connect guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)).
  - MCP Apps (`_meta.ui.resourceUri`, `ui://`) is the primary UI path ([OpenAI UI guide](https://developers.openai.com/plugins/build/chatgpt-ui)).
- **Tasks and MCP Apps support**
  - MCP Apps: Cursor, Claude web and Desktop, VS Code and ChatGPT support it ([extension matrix](https://modelcontextprotocol.io/extensions/client-matrix.md)).
  - Tasks extension: the client package `@modelcontextprotocol/ext-tasks` is at 0.2.2 ([npm registry](https://registry.npmjs.org/@modelcontextprotocol%2fext-tasks)). Which of our target clients support tasks is **UNVERIFIED**.

## 5. MCP Inspector
- Package `@modelcontextprotocol/inspector`. Latest is 2.10.1 (2026-10-08); there is also a `v1-latest` tag at 1.0.2 ([npm registry](https://registry.npmjs.org/@modelcontextprotocol%2finspector)). Requires **Node >= 22.19.0** ([Inspector docs](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector.md)).
- One binary, three clients ([Inspector docs](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector.md)):
  - Web: `npx @modelcontextprotocol/inspector node build/index.js`. It prints a URL that carries a per-launch token.
  - CLI: `npx @modelcontextprotocol/inspector --cli node build/index.js --method tools/list`, or `... --cli https://host/mcp --transport http --method tools/call --tool-name X --tool-arg k=v --format json`.
  - TUI: `--tui`.
  - Remote server: `--server-url https://host/mcp --transport http`.
- **Protocol era**: each server has a `protocolEra` setting (`legacy` | `auto` | `modern`), and the CLI/TUI flag `--protocol-era <legacy|auto|modern>` overrides it for one run. **The default is `legacy`**, so test 2026-07-28 explicitly with `modern`. The Inspector drives MRTR manually ([protocol eras](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/protocol-eras.md)).
- Secrets go to the OS keychain. Without a keychain they are written to `~/.mcp-inspector/secrets.json`, unencrypted by default ([Inspector docs](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector.md)).

---

## Part B · AI tool config, instructions and skills


Rule: every fact below is followed by its source URL. Anything not confirmed from an official vendor page is marked **UNVERIFIED**.
The summary table is a digest of the per-tool sections; each cell is sourced in that tool's section.

## Summary table

| Tool | MCP config path(s) + top-level key | Remote URL key | Instruction file(s) read | Skills folder(s) (project / user) |
|---|---|---|---|---|
| Cursor | `.cursor/mcp.json`, `~/.cursor/mcp.json`; `mcpServers` | `url` (+`headers`) | `.cursor/rules/**/*.mdc`, `AGENTS.md` (root+nested), `CLAUDE.md`, legacy `.cursorrules` | `.agents/skills`, `.cursor/skills` (+compat `.claude/skills`, `.codex/skills`) / `~/.agents/skills`, `~/.cursor/skills` |
| Claude Code | `.mcp.json` (project); `~/.claude.json` (local+user); `mcpServers` | `"type":"http"` + `url` | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/**/*.md`; `AGENTS.md` only if no CLAUDE.md (v2.1.277+) | `.claude/skills` (+nested) / `~/.claude/skills` — **no `.agents/skills`** |
| Claude Desktop | `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Win `%APPDATA%\Claude\`); `mcpServers`, stdio only | Not in file; remote = Connectors UI | None from repo (account-level preferences / Projects) | Account skills via ZIP upload (Customize > Skills) |
| Antigravity (IDE, 2.0, CLI `agy`) | `.agents/mcp_config.json`; `~/.gemini/config/mcp_config.json`; `mcpServers` | `serverUrl` (`url`/`httpUrl` NOT supported) | `AGENTS.md`/`GEMINI.md`, `.agents/AGENTS.md`/`GEMINI.md`, `.agents/rules/*.md` (legacy `.agent/rules`) | `.agents/skills` (legacy `.agent/skills`) / IDE+2.0 `~/.gemini/config/skills`, CLI `~/.gemini/antigravity-cli/skills` |
| VS Code + Copilot | `.mcp.json` (portable, `mcpServers`); `.vscode/mcp.json` (`servers`, flagged deprecated); user profile `mcp.json` or `~/.copilot/mcp-config.json` | `"type":"http"` + `url` | `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/rules` | `.github/skills`, `.claude/skills`, `.agents/skills` / `~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills` |
| Windsurf → **Devin Desktop** (Cascade) | User-only `mcp_config.json` — path disputed (see §6); `mcpServers` | `serverUrl` (or `url`) | `.devin/rules/*.md` (pref), `.windsurf/rules/*.md`, `.windsurfrules`, `AGENTS.md` (root+nested) | `.devin/skills`, `.windsurf/skills`, `.agents/skills`, `.claude/skills` (opt-in) / `~/.codeium/windsurf/skills`, `~/.config/devin/skills`, `~/.agents/skills` |
| Gemini CLI | `.gemini/settings.json`, `~/.gemini/settings.json`; `mcpServers` | `httpUrl` (streamable HTTP), `url` (SSE) | `GEMINI.md` (global+ancestors+JIT subdirs); `AGENTS.md` only via `context.fileName` | `.gemini/skills` or `.agents/skills` / `~/.gemini/skills` or `~/.agents/skills` |
| OpenAI Codex CLI | `~/.codex/config.toml`; `.codex/config.toml` (trusted projects); TOML `[mcp_servers.<name>]` | `url` (TOML) | `AGENTS.override.md`/`AGENTS.md` (`~/.codex` + root→cwd), fallback names configurable | `.agents/skills` (cwd, parent, repo root) / `~/.agents/skills`, `/etc/codex/skills` |
| ChatGPT (dev mode / plugins) | UI only (no file) | Server URL in UI (remote only) | N/A (no repo files) | Skills via plugins (web/mobile); standalone skills in ChatGPT desktop app |
| claude.ai web | UI only: Customize > Connectors > Add custom connector | Server URL in UI (remote only) | N/A (no repo files) | Account skills via ZIP upload |

## Cross-cutting: Agent Skills open standard (agentskills.io)
- Format "originally developed by Anthropic, released as an open standard"; open to ecosystem contributions (GitHub agentskills/agentskills). https://agentskills.io/home
- Skill = folder with `SKILL.md` (YAML frontmatter + Markdown); optional `scripts/`, `references/`, `assets/`. https://agentskills.io/specification
- Required frontmatter: `name` (1–64 chars, lowercase a-z/0-9/hyphen, no leading/trailing/double hyphen, must match parent dir) and `description` (1–1024 chars). Optional: `license`, `compatibility` (≤500), `metadata` (string map), `allowed-tools` (experimental). https://agentskills.io/specification
- Validation tool: `skills-ref validate ./my-skill`. https://agentskills.io/specification
- **Folder location:** the spec itself "does not mandate where skill directories live". The client-implementation guide recommends scanning `<project>/.agents/skills/` and `~/.agents/skills/` "for cross-client interoperability" (plus the client's own `.<client>/skills/`), calling `.agents/skills/` "a widely-adopted convention". Some clients also scan `.claude/skills/` for compatibility. https://agentskills.io/client-implementation/adding-skills-support
- Convention: project-level skills override user-level on name collision; gate project skills on a trust check. https://agentskills.io/client-implementation/adding-skills-support
- Client showcase lists Cursor, Claude Code, Claude, Gemini CLI, GitHub Copilot, VS Code, ChatGPT & Codex, Kiro, OpenCode, Goose, etc. (Antigravity and Windsurf/Devin not listed there). https://agentskills.io/home
- Claude Code: outside Claude Code only spec fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) are allowed; other fields cause a hard error. https://code.claude.com/docs/en/skills

## 1. Cursor
- MCP config: project `.cursor/mcp.json`, global `~/.cursor/mcp.json`; key `mcpServers`. https://cursor.com/docs/context/mcp
- stdio: `{"mcpServers":{"name":{"command":"npx","args":["-y","mcp-server"],"env":{"API_KEY":"value"}}}}`. https://cursor.com/docs/context/mcp
- Remote: `{"mcpServers":{"name":{"url":"http://localhost:3000/mcp","headers":{"API_KEY":"value"}}}}`; no `type` required in examples. https://cursor.com/docs/context/mcp
- Env: `${env:NAME}` interpolation in `command`, `args`, `env`, `url`, `headers`; `envFile` (stdio only, e.g. `"${workspaceFolder}/.env"`). https://cursor.com/docs/context/mcp
- No `add` CLI documented; Cursor CLI has `agent mcp list|list-tools|login|enable|disable` and uses the editor's config. https://cursor.com/docs/cli/mcp
- Install deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64(JSON.stringify(config))`. https://cursor.com/docs/mcp/install-links
- Rules: `.cursor/rules` (subfolders OK), must be `.mdc`; plain `.md` there is ignored; frontmatter `description`, `globs`, `alwaysApply`. https://cursor.com/docs/context/rules
- `AGENTS.md` in project root and subdirectories (nested combined with parents). https://cursor.com/docs/context/rules
- `CLAUDE.md` in project root is read and "always applied"; `.cursorrules` "is legacy and will be deprecated"; user rule files `~/.cursor/rules`. https://cursor.com/help/customization/rules
- Skills: project `.agents/skills/`, `.cursor/skills/`; user `~/.agents/skills/`, `~/.cursor/skills/`; compat `.claude/skills/`, `.codex/skills/` (+ `~/` variants); nested dirs scanned; `name` must match folder; cites agentskills.io. https://cursor.com/docs/context/skills
- Whether Cursor reads root `.mcp.json` (Claude format): **UNVERIFIED** (not in docs).

## 2. Claude Code
- `claude mcp add [options] <name> -- <command> [args...]`; e.g. `claude mcp add --env KEY=VAL --transport stdio airtable -- npx -y airtable-mcp-server`; put another option between `--env` and the name. https://code.claude.com/docs/en/mcp
- Remote: `claude mcp add --transport http <name> <url> [--header "Authorization: Bearer ..."]`; `--scope local|project|user`. https://code.claude.com/docs/en/mcp
- `claude mcp add-json <name> '<json>'`. https://code.claude.com/docs/en/mcp
- Scopes: local (default) → `~/.claude.json` under project path; project → `.mcp.json` at repo root (shared via VCS); user → `~/.claude.json` top-level `mcpServers`. https://code.claude.com/docs/en/mcp-quickstart
- `.mcp.json` shape: `{"mcpServers":{"x":{"type":"http","url":"...","headers":{...}}, "y":{"type":"stdio","command":"npx","args":[...]}}}`. https://code.claude.com/docs/en/mcp-quickstart
- Env expansion `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers`; unset → warning, left literal. https://code.claude.com/docs/en/mcp
- Project `.mcp.json` servers need interactive approval (`claude mcp reset-project-choices`); auto-loaded in `-p`/SDK/cloud. https://code.claude.com/docs/en/mcp
- Does NOT read `~/.claude/mcp.json`, `~/.claude/.mcp.json`, etc.; `claude mcp add-from-claude-desktop` imports Desktop config (macOS/WSL); claude.ai connectors auto-load when signed in. https://code.claude.com/docs/en/mcp-quickstart
- Instructions: `./CLAUDE.md` or `./.claude/CLAUDE.md`, `./CLAUDE.local.md`, `~/.claude/CLAUDE.md`, `.claude/rules/**/*.md` (frontmatter `paths:`), `~/.claude/rules/`. https://code.claude.com/docs/en/memory
- `AGENTS.md` read natively since v2.1.277, **only when no CLAUDE.md/.claude/CLAUDE.md/CLAUDE.local.md exists** (default `claude-md-or-agents-md`); `@AGENTS.md` import in CLAUDE.md still supported; "anything under a `.agents/` directory" is not read. https://code.claude.com/docs/en/memory
- Skills: `.claude/skills/<name>/SKILL.md` (cwd + parents up to repo root, nested subdirs), `~/.claude/skills/`, plugins, `--add-dir`, claude.ai account skills; follows agentskills.io. `.agents/skills` not listed. https://code.claude.com/docs/en/skills

## 3. Claude Desktop (chat app)
- Config `claude_desktop_config.json`: macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`; opened via Settings > Developer > Edit Config; key `mcpServers`; stdio `command`/`args`/`env`; restart required. https://modelcontextprotocol.io/docs/develop/connect-local-servers
- Remote servers are added as Custom Connectors (Settings > Connectors > Add custom connector, URL + optional OAuth), not via the JSON file. https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-remote-servers
- That the JSON file rejects `url` entries: **UNVERIFIED** (docs only show stdio there).
- Linux: MCP docs say Desktop is "available for macOS, Windows, and Linux" https://modelcontextprotocol.io/docs/develop/connect-local-servers but MCPB guide says it "runs on macOS (darwin) and Windows (win32)". https://claude.com/docs/connectors/building/mcpb — **vendor docs disagree**.
- Instructions: no repo instruction file; personal preferences / Project instructions in UI. https://claude.com/docs/skills/how-to
- Skills: same account skills as web (Customize > Skills, ZIP containing `<skill-name>/SKILL.md`). https://claude.com/docs/skills/how-to
- Desktop "Code" sessions can load Claude Code config (`~/.claude.json`, project `.mcp.json`) — documented for 3P deployments. https://claude.com/docs/third-party/claude-desktop/extensions

### 3a. MCPB / desktop extensions (.mcpb) status
- MCPB (MCP Bundle) = zip of local stdio server + `manifest.json`; renamed from DXT (`dxt`→`mcpb` CLI, `.dxt`→`.mcpb`, `@anthropic-ai/dxt`→`@anthropic-ai/mcpb`); repo under `modelcontextprotocol` org. https://github.com/modelcontextprotocol/mcpb
- CLI: `npm i -g @anthropic-ai/mcpb`; `mcpb init`; `mcpb pack`; install by double-click, drag-drop, or Settings > Extensions > Advanced settings > Install Extension…. https://claude.com/docs/connectors/building/mcpb
- Manifest "Current version: `0.3`" (a uv example uses `0.4`); server types `node`, `python`, `binary`, `uv`; `${user_config.KEY}` substitution; required `manifest_version`, `name`, `version`, `description`, `author`, `server`. https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- npm `@anthropic-ai/mcpb` latest `2.1.2`, published 2025-12-04. https://registry.npmjs.org/@anthropic-ai/mcpb
- **Status change:** "Desktop extension listings in the directory are deprecated, and the directory no longer accepts MCPB submissions"; to distribute via the directory, ship a plugin instead. Self-distributed `.mcpb` install still supported. https://claude.com/docs/connectors/building/mcpb
- Node recommended: bundled with Claude Desktop on macOS/Windows. https://claude.com/docs/connectors/building/mcpb
- Orgs can disable/allowlist extensions; `isDesktopExtensionEnabled` defaults `false` in 3P deployments. https://claude.com/docs/third-party/claude-desktop/extensions

## 4. Google Antigravity (IDE, Antigravity 2.0, Antigravity CLI `agy`)
- MCP: global `~/.gemini/config/mcp_config.json`; workspace `.agents/mcp_config.json`; single `mcpServers` object; same paths for CLI and IDE. https://antigravity.google/docs/mcp
- stdio: `command`, `args`, `env`, `cwd`. Remote: `serverUrl` + `headers`; "Legacy fields like `url` or `httpUrl` aren't supported." https://antigravity.google/docs/mcp
- Env-var interpolation (`${...}`) in config: not documented — **UNVERIFIED**. https://antigravity.google/docs/mcp
- No `agy mcp add` documented; CLI uses `/mcp` interactive manager; IDE uses MCP Store / "View raw config". https://antigravity.google/docs/mcp
- `~/.gemini/antigravity/mcp_config.json` (believed to be the earlier IDE path — **UNVERIFIED**, from memory) is not mentioned on the current page; only `~/.gemini/antigravity/mcp_oauth_tokens.json` is. Whether it is still read: **UNVERIFIED**. https://antigravity.google/docs/mcp
- Rules: walks up to workspace root loading `AGENTS.md` or `GEMINI.md`, `.agents/AGENTS.md`/`.agents/GEMINI.md`, `.agents/rules/*.md` (legacy `.agent/rules/*.md`); global `~/.gemini/AGENTS.md`/`GEMINI.md`, `~/.gemini/config/rules/*.md`; CLI adds `~/.gemini/antigravity-cli/rules/*.md`. https://antigravity.google/docs/rules
- Rule frontmatter `trigger: always_on|model_decision|glob|manual`; files in `.agents/rules/` without valid frontmatter are silently discarded; 24,000-byte per-file truncation. https://antigravity.google/docs/rules
- Skills: workspace `.agents/skills/` ("still maintains backward compatibility for `.agent/skills`"); global IDE/2.0 `~/.gemini/config/skills`, CLI `~/.gemini/antigravity-cli/skills`, legacy IDE `~/.gemini/antigravity/skills/`; `~/.agents/skills` not mentioned. https://antigravity.google/docs/skills
- Migration from Gemini CLI: MCP moves from `~/.gemini/settings.json` to `~/.gemini/config/mcp_config.json`/`.agents/mcp_config.json`; `url`/`httpUrl` → `serverUrl`; `.gemini/skills` → `.agents/skills` (manual move); GEMINI.md unchanged; `agy plugin import gemini`. https://antigravity.google/docs/cli/gcli-migration

## 5. VS Code + GitHub Copilot
- Portable workspace `.mcp.json` (top-level `mcpServers`, "works across compatible tools"); portable user `$COPILOT_HOME/mcp-config.json` / `~/.copilot/mcp-config.json`. https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- Add Server flow "lists the deprecated `.vscode/mcp.json` and VS Code user-profile destinations for compatibility. Prefer the portable destinations." https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- `.vscode/mcp.json` uses top-level `servers` (+ `inputs`, `sandbox`); the config reference describes it as current, without deprecation — **inconsistent within vendor docs**. https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- stdio: `type:"stdio"`, `command`, `args`, `env`, `envFile`, `cwd`; http: `type:"http"|"sse"`, `url`, `headers`, `oauth`. https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- Secrets: `"inputs":[{"type":"promptString","id":"k","description":"...","password":true}]` referenced as `${input:k}`; `${workspaceFolder}` supported; `${env:VAR}` not mentioned (**UNVERIFIED**). https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- CLI: `code --add-mcp "{\"name\":\"my-server\",\"command\":\"uvx\",\"args\":[\"mcp-server-fetch\"]}"` (adds to user profile). https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- `chat.mcp.discovery.enabled` reuses configs from Claude Desktop, Copilot CLI, Cursor, Windsurf. https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- Instructions: `.github/copilot-instructions.md`; `.github/instructions/**/*.instructions.md` (`applyTo`); `AGENTS.md` at root (`chat.useAgentsMdFile`), nested AGENTS.md experimental & off by default (`chat.useNestedAgentsMdFiles`); `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md` (`chat.useClaudeMdFile`); `.claude/rules` with `paths`; `~/.copilot/copilot-instructions.md`. https://code.visualstudio.com/docs/agent-customization/custom-instructions
- Skills: project `.github/skills/`, `.claude/skills/`, `.agents/skills/`; personal `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`; `chat.agentSkillsLocations` deprecated. https://code.visualstudio.com/docs/agent-customization/agent-skills
- GitHub Copilot (cloud agent, CLI, code review, JetBrains) uses the same project skill folders; personal `~/.copilot/skills` or `~/.agents/skills`. https://docs.github.com/en/copilot/concepts/agents/about-agent-skills

## 6. Windsurf (renamed **Devin Desktop**, Cascade agent)
- "Devin Desktop is the new name for Windsurf", shipped 2026-06-02 as OTA update; "The existing Cascade agent remains available through July", replacement is Devin Local (same architecture as Devin CLI). Cascade status in Oct 2026: **UNVERIFIED**. https://docs.devin.ai/desktop/devin-desktop-faq
- Cascade MCP page: user-level only, `~/.config/devin/mcp_config.json` (or `$XDG_CONFIG_HOME/devin/…`; Windows `%APPDATA%\devin\mcp_config.json`); key `mcpServers`; remote "requires a `serverUrl` or `url` field" + `headers`; `${env:VAR}` and `${file:/path}` interpolation in `command`, `args`, `env`, `serverUrl`, `url`, `headers`; no project-level file. https://docs.devin.ai/desktop/cascade/mcp
- **Vendor docs disagree:** the FAQ path table lists MCP config as `~/.codeium/mcp_config.json` ("unchanged"). https://docs.devin.ai/desktop/devin-desktop-faq. Historic `~/.codeium/windsurf/mcp_config.json` appears in neither page — **UNVERIFIED** whether still read.
- Devin Local / Devin CLI MCP: project `.devin/mcp_config.json` (+ gitignored `.devin/mcp_config.local.json`), user `~/.config/devin/mcp_config.json`; `mcpServers`; remote `url` + `transport:"http"|"sse"`; `devin mcp add <name> -- <cmd>` / `devin mcp add <name> <URL>`, `-s project|user`. https://docs.devin.ai/cli/extensibility/mcp/configuration
- Devin CLI imports by default: `AGENTS.md`, `.cursor/rules`, `.cursor/mcp.json`, `.windsurf/rules`, `CLAUDE.md`, `.claude/skills`, `.mcp.json`, `.github/skills`, etc. (`read_config_from`). https://docs.devin.ai/cli/reference/configuration/read-config-from
- Rules: `.devin/rules/*.md` preferred, `.windsurf/rules/*.md` fallback, legacy `.windsurfrules` still read; global `~/.codeium/windsurf/memories/global_rules.md` (6,000 chars); workspace rules 12,000 chars/file; `trigger: always_on|model_decision|glob|manual`; `AGENTS.md` root (always on) and nested (auto-glob-scoped). https://docs.devin.ai/desktop/cascade/memories
- Skills: `.devin/skills/` (pref), `.windsurf/skills/`, `.agents/skills/`, `.claude/skills/` (only if Claude Code config reading enabled); global `~/.codeium/windsurf/skills/`, `~/.config/devin/skills/`, `~/.agents/skills/`; cites agentskills.io. https://docs.devin.ai/desktop/cascade/skills

## 7. Gemini CLI
- Status: for Google AI Pro/Ultra and free Code Assist individuals, Gemini CLI stopped serving on 2026-06-18, replaced by Antigravity CLI; remains for Code Assist Standard/Enterprise and paid Gemini API keys. https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- MCP: `~/.gemini/settings.json` (user), `.gemini/settings.json` (project); key `mcpServers`; stdio `command`, `args`, `env`, `cwd`, `timeout`, `trust`; remote `url` = SSE, `httpUrl` = streamable HTTP; `headers`. https://geminicli.com/docs/tools/mcp-server/
- Env: `$VAR` / `${VAR}` (all OS), `%VAR%` (Windows); undefined → empty string. https://geminicli.com/docs/tools/mcp-server/
- CLI: `gemini mcp add [-s user|project] [-t stdio|sse|http] [-e KEY=val] [-H header] <name> <commandOrUrl> [args...]` (default scope project). https://geminicli.com/docs/tools/mcp-server/
- Instructions: `GEMINI.md` (global `~/.gemini/GEMINI.md`, workspace + parents, JIT in subdirs); `AGENTS.md` NOT default — set `{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}`. https://geminicli.com/docs/cli/gemini-md/
- Skills: workspace `.gemini/skills/` or `.agents/skills/` alias; user `~/.gemini/skills/` or `~/.agents/skills/`; `.agents/skills` wins over `.gemini/skills` in same tier; based on agentskills.io. https://geminicli.com/docs/cli/skills/

## 8. OpenAI Codex CLI
- Docs moved: developers.openai.com/codex/* now 302-redirects to learn.chatgpt.com. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- MCP: `~/.codex/config.toml`; project `.codex/config.toml` "trusted projects only"; TOML table `[mcp_servers.<name>]`. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- stdio: `command`, `args`, `env`, `env_vars` (forward named vars), `cwd`; e.g. `[mcp_servers.context7]` `command = "npx"` `args = ["-y","@upstash/context7-mcp"]`. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- HTTP: `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- CLI: `codex mcp add <name> -- <command...> | --url <value>`; `--env KEY=VALUE` for stdio; no scope flag documented (writes user config — **UNVERIFIED**). https://learn.chatgpt.com/docs/developer-commands
- JSON (`.mcp.json`) only inside plugin manifests, not user/project config. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Instructions: `~/.codex/AGENTS.override.md` or `AGENTS.md`, then root→cwd one file per dir (`AGENTS.override.md` > `AGENTS.md` > `project_doc_fallback_filenames`); 32 KiB default cap (`project_doc_max_bytes`). CLAUDE.md only if added as fallback. https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Skills: `$CWD/.agents/skills`, `$CWD/../.agents/skills`, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`, system; optional `agents/openai.yaml`; `~/.codex/skills` not mentioned. https://learn.chatgpt.com/docs/build-skills

## 9. ChatGPT (developer mode / apps / plugins)
- Developer mode: Business, Enterprise/Edu on ChatGPT web (Pro: read/fetch MCP only); enable Settings → Apps → Advanced settings; Apps → Create, give endpoint, auth, Scan Tools; write actions in beta. https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Remote only: "ChatGPT connects to remote MCP servers"; local/private via Secure MCP Tunnel. https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Newer flow: ChatGPT Plugins → + → "Add custom MCP server" → Server URL incl. `/mcp` (streamable HTTP) → "Create as a plugin". https://developers.openai.com/plugins/deploy/connect-chatgpt
- Plugins (shared ChatGPT + Codex directory) can bundle skills and/or an MCP server. https://developers.openai.com/plugins/quickstart
- Skills: standalone skills in ChatGPT desktop app, Codex CLI, IDE ext; plugin skills in Chat/Work on web, desktop, mobile. https://learn.chatgpt.com/docs/build-skills
- Repo instruction files: N/A for ChatGPT chat (Codex reads AGENTS.md, §8).

## 10. claude.ai web
- Custom connector by URL: Customize > Connectors > Add custom connector (Free/Pro/Max; Free = 1 custom connector); Team/Enterprise: Owner adds under Organization settings > Connectors; optional OAuth client ID/secret; `/sse` URL selects legacy SSE; request headers in beta. https://claude.com/docs/connectors/custom/add-unlisted
- No local stdio on web; local servers only via Desktop extensions. https://claude.com/docs/connectors/custom/add-unlisted
- Skills: upload ZIP whose top level is `<skill-name>/SKILL.md` in Customize > Skills; requires code execution enabled; all plans. https://claude.com/docs/skills/how-to , https://support.claude.com/en/articles/12512180-use-skills-in-claude
- Instructions: personal preferences / Project instructions (UI), not repo files. https://claude.com/docs/skills/how-to

## Disagreements & gaps that matter for TestPilot's writers
1. **Remote URL key:** `url` (Cursor, Claude Code, VS Code, Codex, Devin CLI) vs `serverUrl` (Antigravity — `url` rejected; Devin Cascade accepts both) vs `httpUrl` (Gemini CLI streamable HTTP). Sources: §1, §2, §4, §5, §6, §7.
2. **Top-level key:** `servers` only in VS Code `.vscode/mcp.json` (now flagged deprecated in one VS Code page, not in the reference); everyone else `mcpServers`; Codex is TOML. §5, §8.
3. **Shared `.mcp.json`:** read by Claude Code, VS Code (portable), Devin CLI (import); NOT documented for Cursor, Antigravity, Gemini CLI, Codex. §1–§8.
4. **`.agents/skills`:** read by Cursor, VS Code/Copilot, Gemini CLI, Codex (only location), Antigravity, Devin Desktop; **not by Claude Code** → must also write `.claude/skills` (or symlink). §2.
5. **AGENTS.md:** Claude Code reads it only when no CLAUDE.md exists; Gemini CLI needs `context.fileName`; VS Code nested AGENTS.md off by default. §2, §5, §7.
6. Windsurf/Devin MCP path: `~/.config/devin/mcp_config.json` vs `~/.codeium/mcp_config.json` vs historic `~/.codeium/windsurf/mcp_config.json`. §6.
7. Antigravity global skills differ: IDE/2.0 `~/.gemini/config/skills` vs CLI `~/.gemini/antigravity-cli/skills`. §4.
8. Claude Desktop Linux support: MCP docs yes vs MCPB guide macOS/Windows only. §3.
9. Antigravity env interpolation, Cursor `.mcp.json` reading, Codex `mcp add` scope, Claude Desktop remote-in-JSON: **UNVERIFIED**.

---

## Part C · Engines, test-case sources and parsers


Research date: 2026-10-12. Each fact has its source URL after it. "UNVERIFIED" means no official source confirmed it in this session. "npm registry" means `npm view` output from today.

---

## 1. Playwright (latest 1.64.0, released 2026-10-07)

### Runtime and init
- The docs list Node.js support as "latest 22.x, 24.x or 26.x". The docs also require Windows 11+ or Server 2019+ or WSL, macOS 14+, and Debian 12/13 or Ubuntu 22.04/24.04/26.04. https://playwright.dev/docs/intro
- The `@playwright/test@1.64.0` package declares `engines.node: ">=20"`, which is looser than the docs. Validate against the docs (22+). npm registry: https://registry.npmjs.org/@playwright/test
- To start a project, run `npm init playwright@latest`. It prompts for TypeScript or JavaScript (TS is the default), the tests folder (`tests`, or `e2e` if `tests` exists), a GitHub Actions workflow, and browser install. https://playwright.dev/docs/intro
- 1.64 changes:
  - `TestProject.default: false` keeps a project out of the default run. Run every project with `--project="*"`.
  - New `--shuffle [seed]` option.
  - New `Locator.within()`.
  - New `APIRequestContext.addCookies/cookies/clearCookies`.
  - New `Page.webmcp` API, used for testing tools a page registers through WebMCP.
  - Breaking: `--update-snapshots=missing` now passes.
  - https://playwright.dev/docs/release-notes
- 1.63 added named test locks with `test(..., { lock: 'name' })`. https://playwright.dev/docs/release-notes

### Locators
- The recommended built-in locators are `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle` and `getByTestId`. https://playwright.dev/docs/locators
- `getByTestId` uses `data-testid` by default. Change the attribute with `use: { testIdAttribute: 'data-pw' }` or `selectors.setTestIdAttribute()`. https://playwright.dev/docs/locators
- Best practice: "prioritizing user-facing attributes and explicit contracts", and "Prefer user-facing attributes to XPath or CSS selectors". Chain and filter, for example `getByRole('listitem').filter({ hasText })`. https://playwright.dev/docs/best-practices
- `Page.getByRef` (new in 1.64) locates an element by an aria ref such as `e2` from `ariaSnapshot` in `'ai'` mode. This is useful for turning MCP exploration into code. https://playwright.dev/docs/release-notes

### Tags and annotations for traceability
- Tags: pass `test('title', { tag: '@fast' }, ...)` or `tag: ['@slow', '@vrt']`, or put `@tag` in the title. They also work on `test.describe`. Tags must start with `@`. https://playwright.dev/docs/test-annotations
- Filter by tag:
  - `--grep @fast`
  - `--grep-invert @fast`
  - OR: `--grep "@fast|@slow"`
  - AND: `--grep "(?=.*@fast)(?=.*@slow)"`
  - https://playwright.dev/docs/test-annotations
- Annotations: pass `{ annotation: { type: 'issue', description: 'https://...' } }` or an array of them. At runtime, call `test.info().annotations.push({type, description})`. The HTML report hides types that start with `_`. https://playwright.dev/docs/test-annotations
- **The built-in JUnit reporter in 1.64 always writes every annotation as `<property name="{type}" value="{description}">` on the `<testcase>`.** The source comment says this follows "Xray JUnit extensions" but works with any tool. So `annotation: { type: 'test_key', description: 'PROJ-123' }` reaches Xray with no extra reporter. https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright/src/reporters/junit.ts
- For richer Xray mapping, Xray publishes `@xray-app/playwright-junit-reporter@0.14.0`. https://github.com/Xray-App/playwright-junit-reporter
  - It supports these annotation types: `test_key`, `test_id`, `test_summary`, `requirements`, `test_description`, and `tr:*` for Test Run custom fields.
  - It can embed attachments as `testrun_evidence`.

### Reporters
- Built-in reporters: `list` (the local default), `line`, `dot` (the CI default), `html`, `blob`, `json`, `junit`, `github`, and `perfetto` (new in 1.63, writes a Trace Event Format file). https://playwright.dev/docs/test-reporters
- Output paths:
  - `json` and `junit` take `outputFile`, or the env vars `PLAYWRIGHT_{JSON|JUNIT}_OUTPUT_FILE`.
  - `html` takes `outputFolder` (default `playwright-report`) and `open: 'always'|'never'|'on-failure'`, or `PLAYWRIGHT_HTML_OPEN`.
  - `blob` writes `report-<hash>.zip` for `npx playwright merge-reports`.
  - https://playwright.dev/docs/test-reporters
- To use several reporters, pass `reporter: [['list'], ['json', { outputFile: 'test-results.json' }]]`. https://playwright.dev/docs/test-reporters
- For machine-readable result sync, use `json` and/or `junit`, or write a custom reporter. https://playwright.dev/docs/test-reporters

### Trace viewer
- The default config records traces with `trace: 'on-first-retry'`. Force tracing with `--trace on`. https://playwright.dev/docs/trace-viewer-intro
- Open a trace with `npx playwright show-trace path/to/trace.zip` (a URL also works), or at https://trace.playwright.dev. https://playwright.dev/docs/trace-viewer
- Since 1.59, agents can analyze traces from the CLI. https://playwright.dev/docs/release-notes
  - `npx playwright trace open <zip>`
  - `trace actions --grep=...`
  - `trace action N`
  - `trace snapshot N --name after`
- Since 1.59, `npx playwright test --debug=cli` lets an agent attach to a test through `playwright-cli`. https://playwright.dev/docs/release-notes

### Playwright Test Agents (they exist, introduced in 1.56)
- There are three agents. **planner** explores the app and writes a Markdown plan to `specs/*.md`. **generator** turns the plan into tests. **healer** runs the suite and repairs failing tests. https://playwright.dev/docs/test-agents
- To set them up, run `npx playwright init-agents --loop=vscode|claude|codex|opencode`. Regenerate the definitions after every Playwright upgrade. https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/test-agents-js.md
- The agents rely on a seed test, `tests/seed.spec.ts`, that sets up the environment (fixtures, global setup).
- Generated tests start with a header such as `// spec: specs/x.md` and `// seed: tests/seed.spec.ts`. Each plan step becomes a numbered comment. https://playwright.dev/docs/test-agents
- The VS Code loop needs VS Code 1.105 or later. https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/test-agents-js.md

### Electron
- Electron support is still **experimental**: "Playwright has experimental support for Electron automation". https://playwright.dev/docs/api/class-electron
- The docs list supported Electron versions as "v21+". https://playwright.dev/docs/api/class-electron
- Usage: `const { _electron } = require('playwright'); await _electron.launch({ executablePath, args, cwd, env, recordVideo, tracesDir, ... })`. https://playwright.dev/docs/api/class-electron

### API tests (APIRequestContext)
- Tests get a built-in `request` fixture that respects `use.baseURL` and `use.extraHTTPHeaders`. https://playwright.dev/docs/api-testing
- `playwright.request.newContext({...})` creates a manual context, for example in `beforeAll`. Call `dispose()` afterwards. https://playwright.dev/docs/api-testing
- `expect(response).toBeOK()` exists. https://playwright.dev/docs/api/class-apiresponseassertions

### Playwright MCP (`@playwright/mcp` 0.0.83) for exploration
- It works on accessibility snapshots, not pixels. Elements carry refs such as `[ref=e5]` that the LLM uses to act. https://playwright.dev/docs/getting-started-mcp
- To install, run `npx @playwright/mcp@latest`. For Claude Code: `claude mcp add playwright npx @playwright/mcp@latest`. https://playwright.dev/docs/getting-started-mcp
- Since 1.62, Playwright also bundles the server as `npx playwright mcp` and `npx playwright cli`. https://playwright.dev/docs/release-notes
- Core tools:
  - Navigation: `browser_navigate`, `browser_snapshot`
  - Actions: `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`
  - Inspection: `browser_take_screenshot`, `browser_network_requests`, `browser_console_messages`
  - Session: `browser_tabs`, `browser_handle_dialog`
  - Code: `browser_run_code_unsafe`, which is RCE-equivalent
  - https://github.com/microsoft/playwright-mcp
- Opt-in tool groups use `--caps=`. https://github.com/microsoft/playwright-mcp
  - `testing` adds `browser_generate_locator` and `browser_verify_element_visible/list_visible/text_visible/value`.
  - Other groups: `vision` (coordinate actions), `pdf`, `network` (route mocking), `storage` (cookies and storage), `devtools` (tracing and video), `config`.
- `--codegen typescript|python|java|csharp|none` sets the language of the code the server emits. https://github.com/microsoft/playwright-mcp
- Profile options:
  - `--isolated` keeps the profile in memory.
  - `--storage-state` loads saved state.
  - `--extension` attaches to the user's Chrome or Edge.
  - A persistent profile cannot be shared between concurrent clients.
  - https://github.com/microsoft/playwright-mcp
- Pages can expose WebMCP tools, which appear as `webmcp_<tool>` and are on by default. Turn them off with `--no-webmcp`. https://playwright.dev/docs/release-notes
- The README now says coding agents may prefer "CLI+SKILLS" (`playwright-cli`) because it uses fewer tokens. It keeps MCP for exploratory, self-healing and long-running loops. https://github.com/microsoft/playwright-mcp
- Node requirements disagree. The README says "Node.js 18 or newer" and the docs page says "Node.js 20 or newer". https://github.com/microsoft/playwright-mcp ; https://playwright.dev/docs/getting-started-mcp

---

## 2. Appium 3 (latest 3.8.0; 4.0.0-beta.4 is on npm under the `beta` tag)
- Node `^20.19.0 || ^22.12.0 || >=24.0.0`, npm `>=10`. https://appium.io/docs/en/latest/quickstart/requirements/
- Appium 4 is in beta. npm registry dist-tags: https://registry.npmjs.org/appium
- Driver install:
  - `appium driver install <name>` for official drivers, optionally `@version`.
  - `appium driver install --source=npm <pkg>` for third-party drivers.
  - `appium driver list --installed --json` gives machine-readable output.
  - `appium driver doctor <name>` checks prerequisites.
  - https://appium.io/docs/en/latest/reference/cli/extensions/
- `appium setup [mobile|desktop|browser|reset]` installs presets. https://appium.io/docs/en/latest/reference/cli/setup/
  - `mobile` installs uiautomator2, xcuitest (macOS hosts only) and espresso.
  - `desktop` installs mac2 (macOS hosts only) and windows (Windows hosts only).
- The Appium team maintains these official drivers: chromium, espresso, gecko, mac2, safari, uiautomator2, windows, xcuitest. https://appium.io/docs/en/latest/ecosystem/drivers/

### Android: UiAutomator2 (`appium-uiautomator2-driver` 8.7.0)
- Capability: `appium:automationName: 'UiAutomator2'`.
- Prerequisites:
  - Android SDK platform-tools.
  - `ANDROID_HOME` or `ANDROID_SDK_ROOT`.
  - A JDK and `JAVA_HOME`.
  - Android API 26 (8.0) or later, since driver 6.0.0.
- https://github.com/appium/appium-uiautomator2-driver

### iOS: XCUITest (`appium-xcuitest-driver` 12.17.1)
- It requires a macOS host, Xcode and Appium. The driver fully supports the latest two major Xcode/iOS versions. Driver 10.0.0 and later need Appium 3. https://appium.github.io/appium-xcuitest-driver/latest/getting-started/system-requirements/
- **Contrary to the usual assumption, Windows and Linux hosts have limited support.** https://appium.github.io/appium-xcuitest-driver/latest/guides/non-macos-hosts/
  - Only real devices work, and they must run iOS 18 or later.
  - It uses a RemoteXPC tunnel (`appium-ios-remotexpc` 5.1.0 or later).
  - It needs `appium:udid` and `appium:platformVersion`.
  - WebDriverAgent must be pre-installed (`usePreinstalledWDA`) or managed externally (`webDriverAgentUrl`).
  - Simulators work only on macOS.

### macOS: Mac2 (`appium-mac2-driver` 4.4.0)
- It requires macOS 11.3 or later and Xcode 13 or later. Xcode Helper needs Accessibility permission. Driver 3.0.0 and later need Appium 3. Install with `appium driver install mac2`. https://appium.github.io/appium-mac2-driver/latest/getting-started/

### Windows: three options, and the picture has changed
- **`appium-windows-driver` (6.3.1) is now marked DEPRECATED in its README.** https://github.com/appium/appium-windows-driver
  - It proxies to Microsoft's WinAppDriver, which "has not been maintained by Microsoft for years".
  - It needs Windows 10 with Developer Mode enabled.
  - Since 3.0.0 it no longer installs WinAppDriver; you run the `install-wad` script yourself.
  - "not compatible with Appium 4 ... Its official replacement is the Appium WinCore Driver".
- **NovaWindows** (`appium-novawindows-driver` 1.4.5) is community-maintained by Automate The Planet. https://appium.io/docs/en/latest/ecosystem/drivers/ ; https://github.com/AutomateThePlanet/appium-novawindows-driver
  - The Appium docs list it as a "drop-in replacement".
  - It uses a PowerShell/UIA backend with no WinAppDriver and no Developer Mode.
  - Capability: `automationName: 'NovaWindows'`.
  - Install with `appium driver install --source=npm appium-novawindows-driver`.
- **WinCore** (`appium-wincore-driver` 3.1.2, first published 2026-09-02) is the new official replacement. https://github.com/appium/appium-wincore-driver ; npm registry https://registry.npmjs.org/appium-wincore-driver
  - Capability: `appium:automationName: 'Wincore'`.
  - Requires Appium 3 and Windows 10 or later.
  - Covers UWP, WinForms, WPF and Win32 apps, WebView2/Chrome/Edge through CDP, and IE11.
  - Install with `appium driver install --source=npm appium-wincore-driver`.
  - A related MCP server exists, `wincore-mcp`.
  - Its npm `repository` field points to `verisoft-ai/appium-wincore-driver`. It is UNVERIFIED whether the repo moved to the appium org or is mirrored there.

### appium-mcp (1.97.0) is official
- The repo is `github.com/appium/appium-mcp`. The npm maintainers include the Appium core team (jlipps, mokhnach, kazucocoa). It requires Node 22 or later. https://github.com/appium/appium-mcp ; npm registry
- It embeds the UiAutomator2 and XCUITest drivers. With no `remoteServerUrl`, you don't need a global Appium or `appium driver install`. For other platforms, `platform=general` requires a `remoteServerUrl`. https://github.com/appium/appium-mcp
- Tools:
  - Device setup: `select_device` (call it first), `prepare_ios_simulator`, `appium_prepare_ios_real_device`.
  - Sessions and contexts: `appium_session_management`, `appium_context`.
  - Finding elements: `appium_find_element(s)`, `appium_get_page_source`, `generate_locators`. Locator priority is accessibility id, then id, then platform-native, then xpath.
  - Interaction: `appium_gesture`, `appium_set_value`, `appium_screenshot`.
  - Apps: `appium_app_lifecycle`, `appium_mobile_permissions`.
  - Test generation: `appium_generate_tests`, which generates Java/TestNG.
  - https://github.com/appium/appium-mcp
- Opt-in features:
  - `AI_VISION_ENABLED` adds the `appium_ai` vision finder, which needs an OpenAI-compatible endpoint.
  - `APPIUM_MCP_DOCS_ENABLED` adds documentation RAG.
  - `NO_UI=1` cuts the token count.
  - `CAPABILITIES_CONFIG` loads per-platform presets.
  - `REMOTE_SERVER_URL_ALLOW_REGEX` restricts which remote servers it may connect to.
  - https://github.com/appium/appium-mcp

### Appium Inspector
- It ships as a standalone desktop app (macOS/Windows/Linux, from GitHub Releases) and as an Appium plugin. The plugin installs with `appium plugin install inspector`, runs with `appium --use-plugins=inspector`, and serves the UI at `http://127.0.0.1:4723/inspector`. https://github.com/appium/appium-inspector ; https://appium.github.io/appium-inspector/latest/quickstart/installation/
- The old web host `inspector.appiumpro.com` "is no longer related to the Appium team". https://github.com/appium/appium-inspector

---

## 3. BrowserStack
- **App upload:**
  - `POST https://api-cloud.browserstack.com/app-automate/upload` with basic auth `-u USER:ACCESS_KEY`.
  - Send multipart `file` or a public `url`, plus an optional `custom_id` (100 characters max).
  - It returns `{"app_url":"bs://<APP_ID>","custom_id":...}`.
  - `GET /app-automate/recent_apps` lists recent apps. Apps are kept for 30 days.
  - https://www.browserstack.com/docs/app-automate/api-reference/appium/apps
- **Appium hub:** `https://USER:KEY@hub-cloud.browserstack.com/wd/hub`, with `app: 'bs://...'`. https://www.browserstack.com/docs/app-automate/appium/getting-started/java/junit/integrate-your-tests-legacy
- **Appium versions on BrowserStack:** set `bstack:options.appiumVersion`. https://www.browserstack.com/docs/app-automate/appium/set-up-tests/set-appium-version
  - The highest 3.x is 3.5.2, behind the local 3.8.0. Driver versions are fixed for each Appium version.
  - The Android default is 1.22.0 when no version is set.
  - The `wait` plugin is not supported on 3.x.
- **WebdriverIO:** "BrowserStack currently supports WebdriverIO versions 7, 8, and 9". `@wdio/browserstack-service` latest is 9.39.4 and has no v10 tag. However, `webdriverio` latest is 10.0.2 and needs Node >=22.19. **Pin WDIO 9 for BrowserStack runs.** https://www.browserstack.com/docs/app-automate/appium/getting-started/nodejs/webdriverio ; npm registry
- **Playwright on Automate, SDK route:**
  - Install with `npm i -D browserstack-node-sdk@latest` (1.72.3).
  - Run `npx setup --username ... --key ...`.
  - Configure `browserstack.yml` (`userName`, `accessKey`, `framework: playwright`, `platforms`, `buildName`, `projectName`).
  - Run with `npx browserstack-node-sdk <your test command>`.
  - https://www.browserstack.com/docs/automate/playwright/getting-started/nodejs/integrate-your-tests
- **Playwright, CDP route:** `wss://cdp.browserstack.com/playwright?caps=<urlencoded JSON>` with `browser`, `os`, `os_version`, `browserstack.username/accessKey` and `client.playwrightVersion`. https://browserstack.com/docs/automate/playwright/playwright-capabilities
- **Test Management API:**
  - Base URL is `https://test-management.browserstack.com/api/v2`, with basic auth `USER:ACCESS_KEY`. https://www.browserstack.com/docs/test-management/api-reference/test-cases
  - List cases with `GET /projects/{PR-x}/test-cases?p=<page>`. Filter with `?id=TC-1,TC-2`. https://www.browserstack.com/docs/test-management/api-reference/test-cases
  - Create a case with `POST /projects/{id}/folders/{folder_id}/test-cases` and body `{test_case:{name,...}}`. https://www.browserstack.com/docs/test-management/api-reference/test-cases
  - A case has `identifier` (TC-123), `title`, `steps[{step,result}]`, `preconditions`, `custom_fields`, `tags` and `automation_status`. https://www.browserstack.com/docs/test-management/api-reference/test-cases
  - Runs: `POST|GET /projects/{id}/test-runs`. https://www.browserstack.com/docs/test-management/api-reference/test-runs
  - Results:
    - Endpoint: `POST /projects/{id}/test-runs/{TR-x}/results`.
    - Single result body: `{test_result:{status,description,issues,custom_fields}, test_case_id:'TC-13', configuration_id?}`.
    - Bulk results body: `{results:[...]}`.
    - Status is required.
    - https://www.browserstack.com/docs/test-management/api-reference/test-results
  - JUnit upload: `POST https://test-management.browserstack.com/api/v1/import/results/xml/junit` with form fields `project_name`, `file_path=@x.xml` and `test_run_name`. Note that this uses the v1 path. https://browserstack.com/docs/test-management/upload-reports-cli/frameworks/mocha
  - How a JUnit testcase maps to a TC-ID: UNVERIFIED (not stated on the page).

---

## 4. Jira, Xray and Zephyr
- **Jira Cloud basic auth:**
  - Send `Authorization: Basic base64(email:api_token)`, or `curl -u email:token`. Password auth is deprecated. https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
  - API tokens expire after 1–365 days, one year by default. https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
  - **Scoped** tokens must call `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`, not `your-domain.atlassian.net`. Atlassian recommends scoped tokens. https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/ ; https://jira.atlassian.com/browse/CLOUD-12617
- **Jira search:** `/rest/api/3/search` is "deprecated and has been fully removed". Use `/rest/api/3/search/jql`, which paginates with `nextPageToken` instead of `startAt`. https://confluence.atlassian.com/display/JIRAKB/Run+JQL+search+query+using+Jira+Cloud+REST+API
- **Jira descriptions:** v3 uses ADF, not plain text, for rich-text fields. UNVERIFIED in this session; this is well known.
- **Xray Cloud auth:**
  - Call `POST https://xray.cloud.getxray.app/api/v2/authenticate` with `{client_id, client_secret}`. It returns the token as a JSON string. Send it as `Authorization: Bearer <token>`. https://github.com/Xray-App/xray-code-snippets/blob/main/use_cases/import_automation_results/README.md
  - Token lifetime (commonly cited as 24h): UNVERIFIED.
  - Regional hosts (`us.`/`eu.`/`au.xray.cloud.getxray.app`): UNVERIFIED as API bases. `us.xray.cloud.getxray.app` does serve the GraphQL docs.
- **Xray import:** use `/api/v2/import/execution` for Xray JSON. Format-specific endpoints are `/junit`, `/testng`, `/nunit`, `/xunit`, `/robot`, `/cucumber` and `/behave`, and each has a `/multipart` variant for setting custom Test Execution fields. https://getxraydocs.atlassian.net/wiki/spaces/XRAYCLOUD/pages/44577176/Import+Execution+Results+-+REST+v2
  - JUnit takes query params such as `projectKey` and `fixVersion`. https://github.com/Xray-App/xray-code-snippets/blob/main/use_cases/import_automation_results/README.md
  - Cucumber results need scenarios tagged with Test issue keys. https://github.com/Xray-App/xray-code-snippets/blob/main/use_cases/import_automation_results/README.md
- **Xray GraphQL:** `https://xray.cloud.getxray.app/api/v2/graphql`. https://us.xray.cloud.getxray.app/doc/graphql/index.html
  - Queries: `getTests`, `getTest`, `getExpandedTests`, `getTestExecutions`, `getTestRuns`, `getTestRunsById`.
  - Mutations: `createTestExecution`, `addTestsToTestExecution`, `updateTestRunStatus`, `updateTestRunStepStatus`, `updateTestRunComment`.
- **Zephyr naming:** SmartBear renamed **Zephyr Scale to "Zephyr"** and **Zephyr Squad to "Zephyr Essential"**. https://community.smartbear.com/discussions/browseresources/announcement-smartbears-product-rebrand/279529 ; https://support.smartbear.com/zephyr/docs/en/welcome.html
- **Zephyr (formerly Scale) Cloud API:**
  - Base URL `https://api.zephyrscale.smartbear.com/v2/{endpoint}`, not the Jira URL. Auth header is `Authorization: Bearer {token}` (JWT). https://support.smartbear.com/tm4j-cloud/docs/rest-api.html ; https://support.smartbear.com/zephyr/docs/en/rest-api/troubleshoot-rest-api-issues.html
  - Each user creates a token under Jira Settings > Apps > Zephyr API Access Tokens. https://support.smartbear.com/zephyr-scale-cloud/docs/en/rest-api/generating-api-access-tokens.html
  - `POST /testexecutions` (plural; `/testexecution` returns 403) now **requires `spaceKey`**. This follows Atlassian renaming "projects" to "spaces". https://support.smartbear.com/zephyr/docs/en/rest-api/troubleshoot-rest-api-issues.html
  - UNVERIFIED (the API reference is JS-rendered and could not be read):
    - An EU base URL, `eu.api.zephyrscale.smartbear.com`.
    - `GET /testcases`, `GET /testcases/{key}/teststeps`, `GET /testexecutions`, `/testcycles`.
    - `POST /automations/executions/{junit|cucumber|custom}?projectKey=&autoCreateTestCases=`.
    - Pagination with `startAt`/`maxResults`.
    - Reference: https://support.smartbear.com/zephyr-scale-cloud/api-docs/

---

## 5. TestRail, Azure DevOps and qTest
- **TestRail auth:** HTTP basic with username plus password or API key (from My Settings > API Keys). The header `Content-Type: application/json` is required. URLs look like `https://x.testrail.com/index.php?/api/v2/<method>/<arg>`. https://support.testrail.com/hc/en-us/articles/7077039051284-Accessing-the-TestRail-API
- **TestRail `get_cases`:** `GET index.php?/api/v2/get_cases/{project_id}&suite_id=` (`suite_id` only applies in multi-suite mode). https://support.testrail.com/hc/en-us/articles/7077292642580-Cases
  - It paginates with `limit`/`offset` (default 250) and returns `{offset,limit,size,_links:{next,prev},cases:[...]}`.
  - Custom fields appear as `custom_*`, for example `custom_steps_separated`. `refs` holds requirement links.
- **TestRail `add_results_for_cases`:** `POST index.php?/api/v2/add_results_for_cases/{run_id}` with body `{"results":[{case_id,status_id,comment,elapsed,defects,version}]}`. https://support.testrail.com/hc/en-us/articles/7077819312404-Results
  - Status IDs: 1 Passed, 2 Blocked, 3 Untested (not allowed when adding), 4 Retest, 5 Failed. Custom statuses come from `get_statuses`.
- **Azure DevOps auth:** a PAT over basic auth with an empty username (`base64(":PAT")`). https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops
  - **Global PATs stop working on December 1, 2026.** Use organization-scoped PATs, or Microsoft Entra tokens or service principals, which Microsoft recommends for automation.
- **Azure DevOps test cases:**
  - Test cases are "test case work items". https://learn.microsoft.com/en-us/azure/devops/test/create-test-cases?view=azure-devops
  - Steps live in the `Microsoft.VSTS.TCM.Steps` field as an XML document. https://devblogs.microsoft.com/devops/how-to-use-test-step-using-rest-client-helper/
  - Creating plans and suites needs Basic + Test Plans access. https://learn.microsoft.com/en-us/azure/devops/test/create-test-cases?view=azure-devops
- **Azure DevOps result sync flow** (api-version 7.1):
  1. `GET https://dev.azure.com/{org}/{project}/_apis/testplan/Plans/{planId}/Suites/{suiteId}/TestPoint?includePointDetails=true&api-version=7.1` returns points with `testCaseReference.id`, `configuration` and `results.outcome`. https://learn.microsoft.com/en-us/rest/api/azure/devops/testplan/test-point/get-points-list?view=azure-devops-rest-7.1
  2. `POST .../_apis/test/runs?api-version=7.1` with `{name, plan:{id}, pointIds:[...], automated}`. https://learn.microsoft.com/en-us/rest/api/azure/devops/test/runs/create?view=azure-devops-rest-7.1
  3. `POST .../_apis/test/Runs/{runId}/results?api-version=7.1` with an array of `{testCaseTitle, automatedTestName, outcome}`. Outcomes include Passed, Failed, Blocked, NotExecuted and others. https://learn.microsoft.com/en-us/rest/api/azure/devops/test/results/add?view=azure-devops-rest-7.1
  - Updating results created from points with PATCH: UNVERIFIED (not fetched).
- **qTest:** `POST /api/v3/projects/{projectId}/auto-test-logs?type=automation` submits automation logs in batch and can create test cases and runs (qTest 8.4.1 or later). https://docs.tricentis.com/qtest-saas/content/apis/apis/test_log_apis.htm
  - Base URL `https://{site}.qtestnet.com`, `Authorization: Bearer <token>`, and `GET /api/v3/projects/{id}/test-cases`: UNVERIFIED.

---

## 6. File parsing in Node
- **exceljs** 4.4.0 was published 2023-10-19, and the only newer release is `4.4.1-prerelease.0` (2024-12). It is effectively in maintenance, but its read/write API is stable. npm registry https://registry.npmjs.org/exceljs
- **SheetJS:** the npm `xlsx` package is frozen at 0.18.5 (2022-03-24). The docs say "the registry is out of date". The current version is **0.20.3**, installed with `npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. https://docs.sheetjs.com/docs/getting-started/installation/nodejs
  - A tarball dependency complicates lockfiles and audits for a published MCP package.
  - Alternative: `read-excel-file` 9.3.12, Node 18 or later, read-only. npm registry
- **mammoth** 1.13.0 (2026-09-26): `convertToHtml` keeps tables as `<table>` but ignores table formatting. `extractRawText` drops structure. "Markdown support is deprecated." For step tables, convert to HTML and then parse the `<table>`. https://github.com/mwilliamson/mammoth.js
- **docx alternatives:**
  - `officeparser` 8.1.1 parses docx, xlsx, pptx, odt, pdf and other formats into a typed AST with table, row and cell nodes. It needs Node >=22.13. https://github.com/harshankur/officeParser
  - You can also read `word/document.xml` directly with `jszip` 3.10.2 and `fast-xml-parser` 5.11.2 (`w:tbl/w:tr/w:tc`). npm registry
  - The `docx` npm package (9.10.0) is for writing documents, not reading them.
- **Gherkin:** `@cucumber/gherkin` 42.0.1 with `@cucumber/messages` 34.2.1. Usage: `new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher())`, then `parser.parse(text)`, then `compile(doc, uri, newId)` to get pickles. A `GherkinInMarkdownTokenMatcher` also exists. https://github.com/cucumber/gherkin

## 7. Allure
- **allure-playwright** 3.13.0 (2026-09-28) declares the peer dependency `@playwright/test >=1.62.0`. npm registry https://registry.npmjs.org/allure-playwright
  - Config: `reporter: [['line'], ['allure-playwright', { resultsDir? }]]`. It writes `./allure-results`. https://github.com/allure-framework/allure-js/tree/main/packages/allure-playwright
  - The runtime API in `allure-js-commons` provides `epic/feature/story/tags/issue/owner/parameter/step/attachment`, plus a sync facade, `allure-js-commons/sync`. https://github.com/allure-framework/allure-js/tree/main/packages/allure-playwright
- **Allure Report 3:** the npm package `allure` is at 3.20.1. Use `npx allure generate ./allure-results` and `npx allure open`. Allure 2 is still published as `allure-commandline` 2.46.1. https://github.com/allure-framework/allure-js/tree/main/packages/allure-playwright ; npm registry

## Other versions (npm registry, 2026-10-12)
- `@modelcontextprotocol/sdk` 1.32.1 (Node 18 or later)
- `webdriverio` 10.0.2 (Node >=22.19.0)
- `browserstack-node-sdk` 1.72.3
- `@xray-app/playwright-junit-reporter` 0.14.0
