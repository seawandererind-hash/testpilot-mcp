# Never tested before? Start here

You do not need to know anything about testing to use TestPilot. If you can open your app in a browser, you can test it. This page shows the shortest way, in plain words.

## What you need

- TestPilot added to your AI tool (Cursor, Claude Code, VS Code or Antigravity). [install.md](install.md) has the steps.
- The **address of your app**: the link you open in the browser, for example `https://staging.yourcompany.com` or `http://localhost:3000`. A test copy ("staging", "test", "dev") is best. Do not use the live site your customers use.
- An **empty folder** for the tests, opened in your AI tool. (A folder with your app's code works too.)

## Three sentences is all it takes

This quick path is for websites, and TestPilot picks the setup for you (Playwright with TypeScript). To choose the kind of app, the framework and the language yourself, or for a phone or desktop app, say **"Set up test automation"** (or use `/qa-setup`) instead: TestPilot asks those questions first, one at a time.

Type these into the chat, one at a time:

1. **"Test my app at https://staging.yourcompany.com"** (or use the `/qa-start` command)

   TestPilot asks once before it starts. Say yes. It then:
   - creates a small test project in your folder (you see the list first),
   - installs Playwright, the tool that drives the browser (about 150 MB, a few minutes, only the first time),
   - visits your app's pages like a visitor would. It only follows links: it never clicks buttons, types, buys or deletes anything.

   You get a **health report** in plain words: pages or links that are broken, programming errors, failed requests, slow pages, pages too wide for a phone, images without a description for blind visitors. Each problem says what it means for your users and who can fix it. The full report is in `.testpilot/health/report.md`.

   It also writes **starter tests** in plain English in `test-cases/starter-tests.csv`: "each page opens" and "the main links go to the right page". You can open that file in Excel and change it.

2. **"Yes, turn them into automated tests and run them"**

   TestPilot writes the test code, then runs every test twice in a real browser (twice, to make sure the tests are reliable). If one fails, it says why in plain words: a real bug in the app, a renamed button, a slow page, or a mistake in the test.

3. **"Check my app again"**, any time, for example after each release

   TestPilot repeats the health check and tells you what got fixed and what is new since last time.

## Then grow it in your own words

Tell TestPilot what your app should do, the way you would explain it to a new colleague:

> "When I search for shoes, I see a list of shoes."
>
> "If I sign in with a wrong password, I see the message 'Wrong password'."
>
> "Adding a product to the cart makes the cart counter show 1."

TestPilot turns each sentence into a test case and a test. When it needs a test account to sign in, it asks you to put the email and password in a private file called `.env` on your computer. **Never paste passwords into the chat.**

## Words you will hear

Ask "what is a flaky test?" or "what does CI mean?" at any time; TestPilot explains any testing word with an everyday example. The most common ones:

| Word | In plain words |
|---|---|
| Test case | A short recipe: the steps to take and what should happen |
| Automated test | A test case turned into a small program the computer repeats in seconds |
| Playwright | The free tool that drives the browser for your tests |
| Pass / fail | A test passes when every check came out as expected; a failure is a bug or a test to update |
| Flaky test | A test that sometimes passes and sometimes fails without any change |
| Staging | A private test copy of your app, separate from the live site |
| `.env` | A private file on your computer for passwords the tests need; never shared |
| CI | A service that runs your tests automatically whenever the code changes |

## Running the tests yourself

In the terminal of your test folder (in Cursor: **Terminal → New Terminal**):

| To | Type |
|---|---|
| Run every test | `npx playwright test` |
| Watch the tests run step by step in a window | `npx playwright test --ui` |
| See the last report in your browser | `npx playwright show-report` |

## If you get stuck

- **"I could not open your address"**: check for typos, check that the test copy of the app is running, and connect to your company VPN if the app is internal.
- **"Looks like the live site"**: TestPilot protects your live site. Use the test copy's address, or say clearly that you want to check the live site (the first check only reads pages).
- **The install failed**: usually no internet or a company proxy. Say "check what's missing on my computer" and TestPilot lists what to install and how.
- **Your app is a phone or desktop app, not a website**: say "set up testing for my Android app" (or iPhone, Windows…). TestPilot asks a few questions; each one comes with a plain-words explanation, and "not sure" always picks the recommended answer.
- **Not sure what happened?** Say "where are we?" and TestPilot sums up what is done and what comes next.
