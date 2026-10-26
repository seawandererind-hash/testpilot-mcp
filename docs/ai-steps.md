# Plain-English AI tests (Midscene)

Write a test the way you would explain it to a colleague: "fill in the sign-up form but do not send it",
"search for a hotel in Tokyo for four adults", "the basket shows 2 items". An AI model that can **see the
screen** carries out each step, reads data off the screen and checks the results. Every run makes a
**visual report** that replays each step with screenshots and what the AI decided.

TestPilot adds this with [Midscene.js](https://midscenejs.com) (MIT licence, by ByteDance's web-infra
team), pinned to version 1.15.0. It works for **websites, Android, iPhone/iOS, HarmonyOS and desktop
apps (Windows, macOS, Linux)**, whatever language your normal tests use: the AI tests live in their own
folder, `ai-tests/`, and your existing tests are not changed.

## Two ways to run them: with a model key, or with the AI in your chat

You can run plain-English tests in two ways. Both read the same test files in `ai-tests/cases/`.

| | **A. Use the AI in your chat (no key)** | **B. Use a separate AI model key (Midscene)** |
|---|---|---|
| What thinks | The AI you are already chatting with in Cursor, Claude Code or Antigravity, on your normal subscription | A vision model such as Google Gemini, with its own API key in `.env` |
| Extra cost | Nothing extra (it uses your chat's normal usage) | A few cents per test, paid to the model provider |
| Works on | **Websites only** for now | Websites, Android, iPhone, HarmonyOS, desktop apps |
| You need to | Keep the chat open while it runs (a few minutes per test) | Nothing: it runs by itself, also in CI at night |
| What you get | A **normal test in your project's style** (Page Objects, BDD or Selenium Java) that then runs fast, free and without any AI | Midscene's visual replay report for every run; the AI runs every time |

**Why can't Midscene just use my Cursor key?** Cursor does not give its key to other programs; it only
lets the AI in its own chat use it. So TestPilot turns it around: in way A, the chat's AI is the brain
and TestPilot is its hands and eyes in the browser.

### Way A, step by step (Cursor on Windows; Claude Code and Antigravity work the same)

1. Make sure TestPilot is set up for a website and the plain-English tests are added (say **"add
   plain-English AI tests"** and say yes to the preview). You do **not** need to install anything else
   or add a key. If your Playwright tests already run, the browser is ready; otherwise run
   `npx playwright install chromium` once in the terminal.
2. Write a test in your own words, for example: *"Write an AI test: sign in, check the Products page
   shows, and tell me how many products there are."* Say yes when it shows you the steps.
3. Say: **"Run that AI test with your own AI, no key."** (or: *"drive the AI test login"*).
4. A browser window opens on your test website. Watch: the chat's AI reads the page, does each step and
   tells you what it did. Simple steps ("click Sign in", "type qa@example.com into Email") TestPilot does
   by itself; for longer sentences ("fill in the password and press sign in") the chat's AI works out the
   single actions. If a step looks like paying, ordering, deleting or sending, it asks you first.
5. At the end it shows you the test it wrote, **in your project's own style**: in a Page Object project
   the buttons and fields go into your page objects (`src/pages/…`) and the test into `tests/…`; in a BDD
   project you get a `.feature` file plus step definitions; in a Selenium Java project a TestNG test and Java
   page objects. Your own code in those files is kept. Say yes to save it. It is also saved as a test case,
   so it shows up in the plan and coverage like your imported ones.
6. Say **"run that test"**. From now on it is a normal test: fast, free, and it runs in CI without any AI.

Good to know:

- Questions like "how many products are there?" are answered in the chat; to keep one as a check, ask the AI
  to "keep that as a check" and it records the text it saw.
- Passwords: write `${TEST_USER_PASSWORD}` in the test (or let the AI use the `.env` key). The value is
  never shown in the chat or saved in the test.
- Under the hood this is `ai_tests` action `drive`, then `live_test` with `aiFile`. The chat's AI can also
  look at a screenshot (`image: true`) when the list of buttons and fields is not enough.
- Cursor tip: Cursor's Agent mode (not Ask mode) is needed, because the AI has to call TestPilot's tools.

## When to use it (and when not)

| Good for | Better with normal tests |
|---|---|
| Quick tests you can write in minutes without knowing the code | Tests that run hundreds of times a day (each AI step costs a little) |
| Screens that are hard to automate: canvas, maps, games, third-party apps, in-app web views | Checks that must be exact to the pixel or the cent |
| Reading data off a screen ("return the prices as a list of numbers") | Very fast suites (each AI step takes a second or two) |
| Exploring an app before writing proper tests | Anything with real customer data (screenshots go to the model provider) |

They work well together: Playwright projects also get `aiAct`, `aiQuery` and `aiAssert` **inside**
normal tests, so a page-object test can use one AI step where a locator is painful.

## Step by step

### 1. Add it

Say **"add plain-English AI tests"** (or use `/qa-ai`). Your AI tool calls `add_capability` with
`ai-steps` and shows you a preview of every file first:

- `ai-tests/`: its own `package.json`, `midscene.config.ts`, a README and starter tests in
  `ai-tests/cases/<platform>/`.
- For Playwright projects (TypeScript or JavaScript): `src/fixtures/ai.ts` (or `.js`) and an example
  `tests/ai/ai-steps.spec.ts`, skipped until the model keys are in `.env`.
- A skill (`.agents/skills/ai-steps/`, `.claude/skills/ai-steps/`) so your AI tool knows how to write and run them.
- The four key names in `.env.example` (names only, never values).

Say yes, and say yes again to installing the packages (or run `npm install` inside `ai-tests/`).
The platform comes from your app type; add another later with `platforms`, for example `["ios"]`.

### 2. Pick an AI model and put its settings in `.env` (way B only)

Using way A (the AI in your chat)? Skip this step and step 5; see "Way A, step by step" above.


The AI must be a **vision model that can point at things on the screen**. Claude (and the ChatGPT app)
cannot be used for this part; these can. Pick one, create an API key on the provider's site, and add
these four lines to the `.env` file in your project yourself (never paste a key into the chat):

| Provider | MIDSCENE_MODEL_BASE_URL | MIDSCENE_MODEL_NAME | MIDSCENE_MODEL_FAMILY | Where to get the key |
|---|---|---|---|---|
| **Google Gemini** (easiest start) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-3.5-flash` | `gemini` | aistudio.google.com/apikey |
| Alibaba Cloud Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` (international: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`) | `qwen3.7-plus` | `qwen3` | Model Studio → API keys |
| ByteDance Doubao Seed | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-1-turbo-260628` | `doubao-seed` | Volcano Engine Ark → API keys |
| OpenAI GPT (5.4 or later) | `https://api.openai.com/v1` | `gpt-6-sol` | `gpt-6` | platform.openai.com/api-keys |
| Zhipu GLM-V | `https://api.z.ai/api/paas/v4` | `glm-5v-turbo` | `glm-v` | Z.AI console |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `kimi-k3` | `kimi3` | Moonshot platform |

Example `.env` lines for Gemini:

```
MIDSCENE_MODEL_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
MIDSCENE_MODEL_API_KEY=paste-your-key-here
MIDSCENE_MODEL_NAME=gemini-3.5-flash
MIDSCENE_MODEL_FAMILY=gemini
```

Then ask **"check the AI model works"** (`ai_tests` action `verify`). Values come from Midscene's
[model setup page](https://midscenejs.com/model-api-setup.html), checked on 2026-10-26; providers rename
models often, so if a name stops working, take the current one from that page.

**Cost.** Each AI step sends a screenshot to the provider. Midscene's own Android test cases cost
about 4 to 5 US cents each (12 to 29 model calls per case). Use a key with a spending limit.

### 3. Prepare the device

- **Website:** nothing extra if your Playwright tests already run. Otherwise run
  `npx playwright install chromium` inside `ai-tests/` once. The address comes from `APP_BASE_URL`.
- **Android:** install Android platform tools, connect a phone with USB debugging on (or start an
  emulator), check `adb devices` lists it, and put the app's package name in `APP_ID` in `.env`.
- **iPhone / iOS simulator:** a Mac with Xcode and WebDriverAgent running
  ([Midscene's iOS guide](https://midscenejs.com/ios-getting-started.html)); the bundle id goes in `APP_ID`.
- **HarmonyOS:** `hdc list targets` must list the phone.
- **Desktop:** the AI moves the real mouse and types on the real keyboard, so leave the computer
  alone while it runs. On macOS, allow your terminal under Privacy & Security → Accessibility and
  Screen Recording.

### 4. Write tests in your own words

Tell your AI tool what to test: *"Write an AI test: open the shop, search for mug, add the first one to
the basket, check the basket shows 1 and read the total price."* It turns that into steps
(`ai_tests` action `write`), shows them, and saves them after your yes:

```yaml
cases:
  - name: SHOP-12 add a mug to the basket
    steps:
      - gotoUrl: /
      - aiAct: Search for "mug" and add the first result to the basket
      - aiWaitFor: The basket icon shows 1
      - aiAssert: The basket contains one mug
      - aiQuery: Return the basket total as a number
```

| Say | Step | What it does |
|---|---|---|
| open | `gotoUrl` (web) / `launch` (phones) | Opens a page or starts the app |
| do | `aiAct` | Plans and carries out one or more actions from a sentence |
| tap / type | `aiTap` / `aiInput` | One precise click or one field |
| check | `aiAssert` | Fails the test if the sentence is not true on screen |
| wait for | `aiWaitFor` | Waits until something is true (default up to 30 s) |
| extract | `aiQuery` | Reads data off the screen in the shape you describe |
| ask | `aiAsk` | Asks a question about the screen and keeps the answer in the report |

Already imported test cases from Jira, Excel and the rest? Say **"turn my test cases into AI tests"**
(`ai_tests` action `from-cases`): every action becomes a "do" step and every expected result a "check".
Review them before running: the AI follows the steps literally.

### 5. Run and read the report

Say **"run the AI tests"** (`ai_tests` action `run`). It asks first, then reports each test as passed or
failed with the failing step and the reason, plus the path of the visual report
(`ai-tests/midscene_run/report/…`). Open that file in a browser: you can replay every step, see the
screenshot the AI looked at, what it found and why it decided as it did, and the token use per step.

From a terminal: `npm test` inside `ai-tests/`, or `npx midscene-test cases/web/smoke.yaml` for one file.
In CI, add the four keys as secrets and run `npm ci && npm test` in `ai-tests/`.

### 6. Drive the app live (exploring)

Your AI tool can also control the app step by step while you watch, using Midscene's command-line
drivers inside `ai-tests/` (the generated `ai-steps` skill explains this to it):
`npx midscene-web connect --url <address>`, `npx midscene-web act --prompt "add a mug to the basket"`,
`npx midscene-web assert --prompt "the basket shows 1"`. Android, iOS, HarmonyOS and desktop have the
same commands (`midscene-android`, `midscene-ios`, `midscene-harmony`, `midscene-computer`).

## Midscene's showcases, mapped to TestPilot

From [midscenejs.com/showcases](https://midscenejs.com/showcases.html):

| Showcase | Platform | In TestPilot |
|---|---|---|
| Fill the GitHub sign-up form and pass validation, without submitting | Web | Yes: starter test `cases/web/form.yaml`, or one "do" step on your own form |
| Open Twitter and like the first post of an account | iOS | Yes, with `platforms: ["ios"]` on a Mac with WebDriverAgent. Only on test accounts: automating real social accounts can break the site's rules |
| Booking app: hotel in Tokyo, four adults, Christmas, score 8+ | Android | Yes: Android AI tests over adb |
| Settings → scroll to About phone → read device info | HarmonyOS | Yes, with `platforms: ["harmony"]` (not tried on a real HarmonyOS phone yet) |
| Post a tweet with a video from Downloads in Safari | macOS desktop | Yes, with the desktop platform; uploads need the file in a folder you allow |
| Google search for tomorrow's weather | macOS desktop | Yes (desktop) |
| Sauce Demo: log in and add items to the cart | Windows desktop | Yes (desktop), or as a website test, which is faster and more reliable |
| TodoMVC: add tasks and filter | Linux desktop | Yes (desktop or website) |
| In-car screen tested with a robotic arm | Custom hardware | **No.** It needs your own hardware and a custom Midscene interface written for it; TestPilot does not ship one |
| Dongchedi and Reddit Android test cases with steps, tokens and cost per case | Android | Yes: imported cases become AI tests (`from-cases`); each run reports steps per case, and the visual report shows tokens and cost |

What was checked before release: TestPilot installed Midscene from npm and ran AI tests in a real
browser (TypeScript and JavaScript projects, both the `ai-tests/` folder and an AI step inside a
Playwright test), with a stand-in model so the run did not depend on a paid key. The model settings
above come from Midscene's documentation and were not each tried with a paid key; Android, iOS,
HarmonyOS and desktop configs type-check against Midscene 1.15.0 but were not run on real devices yet.

## Safety

- Keys live only in `.env` (and CI secrets). TestPilot reports whether each one is present, never the value.
- Runs and installs always ask first; writing test files shows a preview first.
- A run against an address that looks like production is refused unless you explicitly allow it.
- Every AI step sends a screenshot to the provider you chose: use test accounts and test data.
- Text on screens and in imported test cases is treated as data, never as instructions to TestPilot.
