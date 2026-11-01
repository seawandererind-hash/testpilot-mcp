# The TestPilot app: click instead of chat

The TestPilot app is a page in your web browser that does what the chat does, with buttons: the guided setup, importing and reviewing test cases, the automation plan, writing and running tests, reports, coverage and quality checks. It is handy for people who would rather click than type, and for showing TestPilot to a team.

It runs **on your own computer**, uses the same TestPilot tools as Cursor and Claude, and saves everything in the same `.testpilot/` folder in your project. So you can start in the app and carry on in the chat, or the other way round, at any time.

## Open it from Cursor (the easiest way)

1. Open your project folder in Cursor (the folder where TestPilot is set up, or an empty folder for a new project).
2. Open the chat (Ctrl+L on Windows) and type: **open the TestPilot app** (or use the `/qa-app` command).
3. A browser tab opens with the app. If no tab appears, the chat shows an address like `http://127.0.0.1:53817/?key=…`: copy it into your browser.

The app keeps working while Cursor is open. Closing Cursor closes the app too; just ask again next time. The same words work in Claude Code, VS Code and Antigravity.

## Open it from a terminal

On Windows, open **PowerShell** in your project folder (in File Explorer, click the address bar, type `powershell` and press Enter), then run:

```powershell
npx -y https://github.com/seawandererind-hash/testpilot-mcp/releases/download/v0.1.11/testpilot-mcp-0.1.11.tgz ui
```

It prints the address and opens your browser. Leave the PowerShell window open while you use the app, and press **Ctrl+C** in it to stop. Add `--root "C:\path\to\project"` to open another folder, or `--no-open` to only print the address.

## What is in the app

| Section | What you do there |
|---|---|
| **Home** | See how far the setup is, and jump to the next step. On a new project there is also a one-click quick check for a website (it picks website, Playwright and TypeScript for you, and says so). |
| **Guided setup** | The setup questions as buttons, one at a time: always the kind of app first, then the framework, then the language. "Not sure" picks the recommended answer. The list on the right shows every step; **Change** goes back to one. |
| **Test cases** | Pick an Excel, CSV, Word, Markdown or Gherkin file from your computer (a copy goes into the project's `test-cases` folder), or import from Jira, Xray, TestRail, BrowserStack, Azure DevOps and more. Then get a review of each case, search the list, or add a case by hand. |
| **Plan, write & run** | Make and approve the automation plan, see which files will be written, write the tests, run them in a real browser, and get failures explained in plain words. |
| **Reports & coverage** | Make the shareable report and the CI pipeline file, and see the coverage map, team dashboard and time saved (the same view Claude and VS Code show in the chat). |
| **Quality checks** | Website health check, accessibility check, a review of your test code, and "Is this computer ready?". |
| **AI features** | Which features need an AI and how to start them in the chat. |
| **All tools** | Every TestPilot tool with a form, for people who know what they want. |
| **Testing words** | Plain-language meaning of every testing word TestPilot uses. |

## Chat inside the app

The **Chat** page lets you ask in your own words ("set up test automation for my website", "run my tests", "why did the login test fail?"). The app has no AI of its own and needs **no extra key**: it hands each message to an AI you already have on this computer, signed in with your own account, and that AI uses TestPilot in this project just like the Cursor chat does.

| Who answers | What it uses | How to add it (once) |
|---|---|---|
| **Cursor** (recommended for Cursor users) | Your Cursor plan, through the Cursor command-line tool (`agent`) | In PowerShell: `irm 'https://cursor.com/install?win32=true' \| iex`, then close and reopen PowerShell and run `agent login` (a browser opens to sign in to Cursor) |
| **Claude Code** | Your Claude plan, through `claude` | In PowerShell: `irm https://claude.ai/install.ps1 \| iex`, then run `claude` once and type `/login` |
| **Simple helper (no AI)** | Nothing | Always there. It understands short requests ("import test cases", "run my tests", "what is a locator?") and opens the right page. |

Then open the Chat page and press **Check again**. If you pick Cursor and the project does not have TestPilot in `.cursor/mcp.json` yet, press **Let the Cursor chat use TestPilot** (it adds TestPilot to that file and keeps everything else in it).

Good to know:

- The chat remembers the conversation until you press **New chat**. Each answer can take a few seconds to a minute.
- Approvals work like in Cursor: when TestPilot needs your OK, the AI asks in the chat and waits for you to type "yes".
- With Claude Code the chat can use TestPilot and read or edit files in the project, but not run other commands. With Cursor it follows Cursor's own rules for the command-line tool.
- Never type passwords or keys in the chat. They go in `.env`.

## What still happens in the chat

The app's pages have no AI. Everything that needs an AI to look at your app or write code by itself happens in a chat: the app's **Chat** page (with Cursor or Claude on this computer) or Cursor or Claude themselves. The **AI features** page lists them and has a button to copy the right request:

- finishing test steps TestPilot could not write on its own (marked `TODO`),
- plain-English AI tests (`/qa-ai`): websites with the chat's own AI, phones and desktop apps with a model key in `.env`,
- live testing and exploring the app, and applying self-healing fixes.

## Safety

- **Your OK first.** Every step that writes files, runs programs or changes test results asks you in a "TestPilot needs your OK" box, exactly like the chat does. Your name is saved with the approval in `.testpilot/decisions.md`.
- **No passwords in the app.** Passwords and keys go only in the `.env` file, which you edit yourself. The app only checks that each one is filled in.
- **Only on your computer.** The app listens on `127.0.0.1` (your own computer), needs the secret key that is in the address it opened with, and refuses requests that come from other websites. Uploaded files can only go into the project's `test-cases` folder and never replace an existing file.
- The hosted TestPilot for ChatGPT and claude.ai has no app; it runs only on your own computer.
