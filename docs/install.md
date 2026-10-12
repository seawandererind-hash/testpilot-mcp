# Installing TestPilot in your AI tool

TestPilot runs in one of two ways:

- **On your computer** (Cursor, Claude Code, Claude Desktop, VS Code, Antigravity, Codex, Gemini CLI, Devin Desktop). The AI tool starts TestPilot for you, and TestPilot writes straight into your repository.
- **Hosted** (ChatGPT, claude.ai, or any tool when your company prefers a central server). You add a URL your platform team gives you. See [hosting.md](hosting.md) for running it.

## Before you start

1. Install **Node.js 22.19 or newer** from https://nodejs.org (the LTS installer is fine). Check with `node --version`.
2. Open the repository you want to automate tests for in your AI tool.
3. Pick the package source:
   - **Published package** (once your platform team has published it): `@yourorg/testpilot-mcp`. Replace `@yourorg` with your organisation's npm scope in every snippet below.
   - **From source** (until then):
     ```bash
     git clone https://github.com/SuryaBhise/testpilot-mcp.git
     cd testpilot-mcp
     npm ci
     npm run build
     ```
     Then use `"command": "node"` and `"args": ["/full/path/to/testpilot-mcp/dist/index.js"]` instead of `npx` in the snippets.

TestPilot needs to know which repository to work in. Most tools start it inside the open project, and the AI passes the project folder on every call. If a tool starts it somewhere else, add `"--root", "/path/to/your/repo"` to `args`, or set `TESTPILOT_ROOT`.

After setup, ask: **"Set up test automation for this repo"**, or pick the `/qa-setup` prompt. TestPilot also writes these config files into the repository when it scaffolds, so teammates who clone it get TestPilot without doing anything.

## Cursor

Create `.cursor/mcp.json` in the repository (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "testpilot": {
      "command": "npx",
      "args": ["-y", "@yourorg/testpilot-mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

Open **Cursor Settings → MCP** and check that `testpilot` shows a green dot and its tools. Cursor reads `AGENTS.md`, `.cursor/rules/testpilot.mdc` and `.agents/skills/`, which TestPilot writes for you.

## Claude Code

From the repository folder:

```bash
claude mcp add --scope project testpilot -- npx -y @yourorg/testpilot-mcp
```

This writes `.mcp.json`, which teammates get with the repository (Claude Code asks each person once before starting a project server). Check with `claude mcp list`, or `/mcp` inside Claude Code. Claude Code reads `CLAUDE.md` (which imports `AGENTS.md`) and `.claude/skills/`; TestPilot writes both.

## Claude Desktop

Open **Settings → Developer → Edit Config** and add TestPilot to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "testpilot": {
      "command": "npx",
      "args": ["-y", "@yourorg/testpilot-mcp", "--root", "/Users/you/code/shop-web"]
    }
  }
}
```

Claude Desktop has no open project, so `--root` is needed (on Windows write the path as `"C:\\Users\\you\\code\\shop-web"`). Quit and restart Claude Desktop. Skills for Claude Desktop and claude.ai are uploaded as ZIP files under **Customize → Skills**; zip any folder from `.claude/skills/` in your repository to add it.

## VS Code with GitHub Copilot

Create `.mcp.json` in the repository (the portable format that also works for Claude Code):

```json
{
  "mcpServers": {
    "testpilot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@yourorg/testpilot-mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

Or run **MCP: Add Server** from the command palette. Use Copilot Chat in **Agent** mode to see TestPilot's tools. Copilot reads `.github/copilot-instructions.md`, `AGENTS.md` and `.agents/skills/`.

## Google Antigravity

Create `.agents/mcp_config.json` in the repository (or `~/.gemini/config/mcp_config.json` for all projects):

```json
{
  "mcpServers": {
    "testpilot": {
      "command": "npx",
      "args": ["-y", "@yourorg/testpilot-mcp"]
    }
  }
}
```

Antigravity reads `AGENTS.md`, `.agents/rules/testpilot.md` and `.agents/skills/`. For a hosted TestPilot, Antigravity uses `serverUrl`, not `url`:

```json
{ "mcpServers": { "testpilot": { "serverUrl": "https://testpilot.example.com/mcp" } } }
```

## OpenAI Codex CLI

```bash
codex mcp add testpilot -- npx -y @yourorg/testpilot-mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.testpilot]
command = "npx"
args = ["-y", "@yourorg/testpilot-mcp"]
```

Codex reads `AGENTS.md` and `.agents/skills/`.

## Gemini CLI

```bash
gemini mcp add testpilot npx -y @yourorg/testpilot-mcp
```

Gemini CLI reads `GEMINI.md` by default. To make it read TestPilot's `AGENTS.md`, add to `.gemini/settings.json`: `{"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}}`.

## Devin Desktop (formerly Windsurf)

Add the same `mcpServers` entry as Cursor to the user-level `mcp_config.json` (Cascade: `~/.config/devin/mcp_config.json`, Windows `%APPDATA%\devin\mcp_config.json`). Devin reads `AGENTS.md` and `.agents/skills/`.

## ChatGPT

ChatGPT connects only to servers on the internet, so it needs a hosted TestPilot ([hosting.md](hosting.md)).

1. In ChatGPT, open **Settings → Apps → Advanced settings** and turn on **Developer mode** (Business, Enterprise and Edu workspaces; an admin may need to allow it).
2. Go to **Apps → Create**, give it the name TestPilot and the URL your platform team gave you, for example `https://testpilot.example.com/mcp`, and choose **OAuth** if your server uses company sign-in.
3. Sign in when asked, then start a chat with TestPilot enabled and say "Set up test automation".

In hosted mode TestPilot works in a named workspace on the server. Share test cases by pasting them or attaching a CSV, Excel or Word file, and at the end ask for a zip download or a pull request.

## claude.ai

1. Open **Customize → Connectors → Add custom connector** (on Team and Enterprise plans an owner adds it under **Organization settings → Connectors**).
2. Enter the URL from your platform team, for example `https://testpilot.example.com/mcp`. If your company sign-in needs a client ID, the platform team gives it to you.
3. Enable TestPilot in a chat and say "Set up test automation".

## Windows notes

- If a tool says it cannot find `npx`, use `"command": "cmd"` and put `"/c", "npx"` in front of the arguments: `"args": ["/c", "npx", "-y", "@yourorg/testpilot-mcp"]`.
- In JSON, write paths with double backslashes (`"C:\\code\\shop-web"`) or forward slashes (`"C:/code/shop-web"`).
- Behind a company proxy, set `HTTPS_PROXY` and, if your company uses its own certificates, `NODE_EXTRA_CA_CERTS=C:\path\to\company-ca.pem` in the server's `env` block.
- Playwright installs browsers into your user profile; if that is blocked, set `PLAYWRIGHT_BROWSERS_PATH` to a folder you can write to.

## Checking it works

Ask your AI tool: **"What is the TestPilot status of this repo?"** It should answer with the current step (for a new repository, "What kind of application are you testing?"). If the tool does not see TestPilot:

1. Run `npx -y @yourorg/testpilot-mcp --version` in a terminal. It should print the version.
2. Look at the tool's MCP logs (Cursor: Output → MCP; Claude Code: `claude --debug`; VS Code: Output → MCP).
3. Make sure Node.js is 22.19 or newer: `node --version`.
