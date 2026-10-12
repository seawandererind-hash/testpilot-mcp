# TestPilot plugin

TestPilot guides test automation from the first question to tests running in CI, for web, API, mobile and desktop apps.

This plugin adds:

- **The TestPilot MCP server**, started with `npx` from the matching [GitHub release](https://github.com/seawandererind-hash/testpilot-mcp/releases). It needs Node.js 22.19 or newer.
- **The `testpilot` skill**, which tells the agent how to use TestPilot's tools.
- **A Cursor rule** that points test-automation requests at TestPilot.

## Install

- **Claude Code**: `/plugin install testpilot --marketplace seawandererind-hash/testpilot-mcp`, or in a shell `claude plugin marketplace add seawandererind-hash/testpilot-mcp` then `claude plugin install testpilot@testpilot-mcp`.
- **Cursor**: open **Customize**, find **testpilot** and click **Install** (from the Cursor Marketplace, or from your team marketplace once an admin imports `https://github.com/seawandererind-hash/testpilot-mcp`).

## Use it

Open a repository and say **"Set up test automation for this repo"**. TestPilot asks about the app, the framework and where your test cases live, then writes the framework, imports and reviews the test cases, plans the work, writes the tests and runs them. Every answer is saved in `.testpilot/` in the repository.

TestPilot never asks for passwords or tokens in chat: you put them in `.env` yourself, and it only checks that each one is there.

## Configuration

Nothing is required. Credentials for Jira, TestRail, BrowserStack and similar go in the repository's `.env`; TestPilot writes `.env.example` with every key it needs and where to find it.

Full documentation: https://github.com/seawandererind-hash/testpilot-mcp
