# TestPilot MCP · Decision log

The format is: decision, why, who decided, and the date. Defaults chosen by Claude are marked **default** and still need confirming by Surya. Research links are in [research.md](research.md).

| # | Decision | Why | Who · when |
|---|---|---|---|
| D1 | Product name **TestPilot MCP**, with slash commands `/qa-*` | From the build guide | Surya · 2026-10-12 |
| D2 | Code lives in a **new GitHub repo** (suggested name `testpilot-mcp`, private) | Picked on the decision card. Keeps the server's CI and releases separate | Surya · 2026-10-12 |
| D3 | Server in **TypeScript**, using **Playwright** for web, Electron and API, and **Appium** for mobile and desktop | From the build guide; matches blueprint v0.1 | Surya · 2026-10-12 |
| D4 | **Node ≥ 22.19** | Node 20 reached end of life in April 2026. The Inspector and webdriverio 10 need 22.19, and appium-mcp needs 22 or newer | default · 2026-10-12 |
| D5 | **MCP SDK v2** (`@modelcontextprotocol/server` 2.3.x, `/node` adapter) with **Zod 4** | v1 is maintenance-only and will never support 2026-07-28. v2 serves both protocol eras from one factory | default · 2026-10-12 |
| D6 | Support both protocol eras with the SDK's built-in legacy mode (`serveStdio` default, `createMcpHandler` `legacy: 'stateless'`) | Cursor only speaks 2025-11-25 and earlier | default · 2026-10-12 |
| D7 | Wizard questions use `inputRequired()`, falling back to plain `wizard_next` output | Works in both eras. Clients without elicitation still get the question | default · 2026-10-12 |
| D8 | Consolidate the guide's ~33 tools into **about 15** tools that take an action parameter | Tool caps (Devin Desktop has 100 total), better tool choice, and a static tool list in 2026-07-28 | default · 2026-10-12 |
| D9 | Every tool gets a `title`, `readOnlyHint` or `destructiveHint`, an object-shaped `outputSchema`, and JSON returned as text as well | Anthropic directory rules, ChatGPT confirmation prompts, 2025-era compatibility | default · 2026-10-12 |
| D10 | Project root is passed as a tool parameter, confirmed once, and saved | Roots are deprecated in 2026-07-28 | default · 2026-10-12 |
| D11 | Canonical skills live in `.agents/skills/` and are mirrored to `.claude/skills/`. `CLAUDE.md` is one line: `@AGENTS.md` | Claude Code doesn't read `.agents/skills`, and ignores AGENTS.md when a CLAUDE.md exists | default · 2026-10-12 |
| D12 | The scaffold writes `.mcp.json` (Claude Code, VS Code), `.cursor/mcp.json` and `.agents/mcp_config.json` (Antigravity uses `serverUrl` for remote) | Each tool reads a different file. One mapping file holds all the paths | default · 2026-10-12 |
| D13 | Template engine **Handlebars** | Logic-less, which makes it safe for QA leads to edit org templates | default · 2026-10-12 |
| D14 | Server package manager **npm**; tests with **Vitest**; release via the private npm registry | Simplest for beginners and matches `npx` distribution | default · 2026-10-12 |
| D15 | Phase 2 web slice: Playwright 1.64 TS + POM, Excel import via **exceljs** behind a parser interface | exceljs is stable but in maintenance. The npm `xlsx` package is frozen at 0.18.5 | default · 2026-10-12 |
| D16 | Traceability through Playwright annotations (`test_key`), exported in JUnit, plus a `@<ID>` tag | The built-in JUnit reporter emits an Xray-compatible format | default · 2026-10-12 |
| D17 | Windows desktop default: `appium-wincore-driver`, with NovaWindows as an alternative. Revisit in Phase 6 | `appium-windows-driver` is deprecated (WinAppDriver is unmaintained). WinCore is only weeks old | default · 2026-10-12 |
| D18 | BrowserStack runs pin versions per target (Appium ≤ 3.5.2, WebdriverIO 9) | BrowserStack lags behind upstream | default · 2026-10-12 |
| D19 | npm scope `@yourorg/testpilot-mcp` until the org name is known | Placeholder | open |
