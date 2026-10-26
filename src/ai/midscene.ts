import YAML from 'yaml';

import { type EnvKey, INTEGRATION_KEYS } from '../catalog/env-keys.js';
import type { Config, TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { CREATED_HEADER, inTestRoot } from '../scaffold/engine.js';

/**
 * AI steps: plain-English tests that a vision model carries out by looking at the screen,
 * powered by Midscene.js (https://midscenejs.com, MIT). Pinned to the latest release that was
 * at least two weeks old when checked (npm registry, 2026-10-26).
 */
export const MIDSCENE_VERSION = '1.15.0';
/**
 * tsx 4.23.14 and later cannot load midscene.config.ts through Midscene Test's loader
 * (it looks for dist/esm/api/esm/index.mjs, checked 2026-10-26), so the AI folder pins the last good one.
 */
export const TSX_OVERRIDE = '4.23.13';
/** Same Playwright as TestPilot's web templates, so both share one downloaded browser. */
export const AI_PLAYWRIGHT_VERSION = '1.64.0';

export const AI_PLATFORMS = ['web', 'android', 'ios', 'harmony', 'computer'] as const;
export type AiPlatform = (typeof AI_PLATFORMS)[number];

export const AI_FOLDER = 'ai-tests';

export const PLATFORM_LABEL: Record<AiPlatform, string> = {
    web: 'website (Chromium browser)',
    android: 'Android phone or emulator (over ADB)',
    ios: 'iPhone or iOS simulator (over WebDriverAgent, Mac only)',
    harmony: 'HarmonyOS phone (over HDC)',
    computer: 'desktop: the real screen, mouse and keyboard of this computer (Windows, macOS or Linux)'
};

const PACKAGE: Record<AiPlatform, string> = { web: '@midscene/web', android: '@midscene/android', ios: '@midscene/ios', harmony: '@midscene/harmony', computer: '@midscene/computer' };
/** The live command-line driver each platform package ships (connect, act, assert, take_screenshot). */
export const LIVE_CLI: Record<AiPlatform, string> = { web: 'midscene-web', android: 'midscene-android', ios: 'midscene-ios', harmony: 'midscene-harmony', computer: 'midscene-computer' };

/** The model keys Midscene reads. Values stay in .env; TestPilot only checks they are there. */
export const MODEL_KEYS: EnvKey[] = INTEGRATION_KEYS['ai-model'];

export interface ModelPreset {
    id: string;
    provider: string;
    baseUrl: string;
    name: string;
    family: string;
    keyFrom: string;
    note: string;
}

/** Models Midscene documents (midscenejs.com/model-api-setup, checked 2026-10-26). They must be vision models that return screen positions. */
export const MODEL_PRESETS: ModelPreset[] = [
    { id: 'gemini', provider: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', name: 'gemini-3.5-flash', family: 'gemini', keyFrom: 'https://aistudio.google.com/apikey (Google AI Studio → Get API key)', note: 'Easiest to start with from most countries; fast and inexpensive.' },
    { id: 'qwen', provider: 'Alibaba Cloud Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', name: 'qwen3.7-plus', family: 'qwen3', keyFrom: 'Alibaba Cloud Model Studio → API keys (international accounts use https://dashscope-intl.aliyuncs.com/compatible-mode/v1)', note: 'Strong at finding things on screen; used in Midscene\'s Reddit showcase.' },
    { id: 'doubao', provider: 'ByteDance Doubao Seed (Volcano Engine)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', name: 'doubao-seed-2-1-turbo-260628', family: 'doubao-seed', keyFrom: 'Volcano Engine Ark console → API keys', note: 'Used in Midscene\'s Android showcase (about 5 US cents per test case there).' },
    { id: 'openai', provider: 'OpenAI GPT', baseUrl: 'https://api.openai.com/v1', name: 'gpt-6-sol', family: 'gpt-6', keyFrom: 'https://platform.openai.com/api-keys', note: 'GPT-5.4 or later is required for finding things on screen.' },
    { id: 'glm', provider: 'Zhipu GLM-V', baseUrl: 'https://api.z.ai/api/paas/v4', name: 'glm-5v-turbo', family: 'glm-v', keyFrom: 'Z.AI console → API keys (mainland China: https://open.bigmodel.cn/api/paas/v4)', note: '' },
    { id: 'kimi', provider: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', name: 'kimi-k3', family: 'kimi3', keyFrom: 'Moonshot AI platform → API keys', note: '' }
];

export function describePresets(): string {
    return MODEL_PRESETS.map(
        p =>
            `${p.provider}${p.note ? `: ${p.note}` : ''}\n  MIDSCENE_MODEL_BASE_URL=${p.baseUrl}\n  MIDSCENE_MODEL_NAME=${p.name}\n  MIDSCENE_MODEL_FAMILY=${p.family}\n  MIDSCENE_MODEL_API_KEY=<your key, from ${p.keyFrom}>`
    ).join('\n\n');
}

/** The AI test folder inside the test root. */
export function aiRoot(config: Config): string {
    return inTestRoot(config, AI_FOLDER);
}

/** Which screens the AI steps drive for this app, or why there are none. */
export function platformsFor(config: Config, requested?: AiPlatform[]): AiPlatform[] | { error: string } {
    if (requested?.length) return [...new Set(requested)];
    switch (config.appType) {
        case 'web':
            return ['web'];
        case 'android':
        case 'hybrid':
            return ['android'];
        case 'ios':
            return ['ios'];
        case 'android-ios':
            return ['android', 'ios'];
        case 'windows':
        case 'macos':
        case 'electron':
            return ['computer'];
        case 'api':
            return { error: 'AI steps look at a screen, and an API has none. For API tests use add_capability "openapi" or the API test generator. If the API also has a website or app, pass platforms (for example ["web"]).' };
        default:
            return { error: 'Run the wizard first (step APP_TYPE) so TestPilot knows which screens the AI should drive, or pass platforms.' };
    }
}

/** Platforms already set up, read from the AI folder's package.json. */
export function installedPlatforms(store: ProjectStore, config: Config): AiPlatform[] {
    const pkg = store.read(`${aiRoot(config)}/package.json`);
    if (!pkg) return [];
    try {
        const deps = { ...(JSON.parse(pkg).devDependencies ?? {}), ...(JSON.parse(pkg).dependencies ?? {}) } as Record<string, string>;
        return AI_PLATFORMS.filter(p => deps[PACKAGE[p]]);
    } catch {
        return [];
    }
}

const SETUP: Record<AiPlatform, { imports: string; context: string; agent: string; setup: string; variables: string }> = {
    web: {
        imports: "import { PlaywrightAgent } from '@midscene/web/playwright/agent';\nimport { chromium, type Page } from 'playwright';",
        context: '{ page: Page; agent?: PlaywrightAgent }',
        agent: 'PlaywrightAgent',
        setup: `async setup({ env, onTeardown }) {
            const browser = await chromium.launch({ headless: env.HEADLESS !== 'false' });
            onTeardown(() => browser.close());
            // gotoUrl: / opens APP_BASE_URL; full addresses work too.
            const page = await browser.newPage({ baseURL: env.APP_BASE_URL || undefined });
            const context: WebContext = { page };
            onTeardown(async () => {
                await context.agent?.destroy();
            });
            return context;
        }`,
        variables: "{ baseUrl: process.env.APP_BASE_URL ?? '' }"
    },
    android: {
        imports: "import { AndroidAgent, agentFromAdbDevice } from '@midscene/android';",
        context: '{ agent: AndroidAgent }',
        agent: 'AndroidAgent',
        setup: `async setup({ env, onTeardown }) {
            // ANDROID_DEVICE_ID picks a device from \`adb devices\`; empty uses the first one.
            const agent = await agentFromAdbDevice(env.ANDROID_DEVICE_ID || undefined);
            onTeardown(() => agent.destroy());
            return { agent };
        }`,
        variables: "{ appId: process.env.APP_ID ?? '' }"
    },
    ios: {
        imports: "import { IOSAgent, agentFromWebDriverAgent } from '@midscene/ios';",
        context: '{ agent: IOSAgent }',
        agent: 'IOSAgent',
        setup: `async setup({ env, onTeardown }) {
            // WebDriverAgent must be running on the iPhone or simulator (see README.md).
            const agent = await agentFromWebDriverAgent(env.WDA_BASE_URL ? { wdaBaseUrl: env.WDA_BASE_URL } : { wdaHost: env.WDA_HOST || 'localhost', wdaPort: Number(env.WDA_PORT || 8100) });
            onTeardown(() => agent.destroy());
            return { agent };
        }`,
        variables: "{ appId: process.env.APP_ID ?? '' }"
    },
    harmony: {
        imports: "import { HarmonyAgent, agentFromHdcDevice } from '@midscene/harmony';",
        context: '{ agent: HarmonyAgent }',
        agent: 'HarmonyAgent',
        setup: `async setup({ env, onTeardown }) {
            const agent = await agentFromHdcDevice(env.HARMONY_DEVICE_ID || undefined);
            onTeardown(() => agent.destroy());
            return { agent };
        }`,
        variables: "{ appId: process.env.APP_ID ?? '' }"
    },
    computer: {
        imports: "import { ComputerAgent, agentForComputer } from '@midscene/computer';",
        context: '{ agent: ComputerAgent }',
        agent: 'ComputerAgent',
        setup: `async setup({ env, onTeardown }) {
            // Drives the real mouse and keyboard: do not touch the computer while it runs.
            const agent = await agentForComputer({ displayId: env.COMPUTER_DISPLAY_ID || undefined });
            onTeardown(() => agent.destroy());
            return { agent };
        }`,
        variables: '{}'
    }
};

const CONTEXT_NAME: Record<AiPlatform, string> = { web: 'WebContext', android: 'AndroidContext', ios: 'IosContext', harmony: 'HarmonyContext', computer: 'ComputerContext' };

/** midscene.config.ts: one Midscene Test project per platform, each reading cases/<platform>/. */
export function midsceneConfig(platforms: AiPlatform[]): string {
    const imports = platforms.map(p => SETUP[p].imports).join('\n');
    const types = platforms.map(p => `type ${CONTEXT_NAME[p]} = ${SETUP[p].context};`).join('\n');
    const projects = platforms
        .map(p => {
            const ctx = CONTEXT_NAME[p];
            const getAgent = p === 'web' ? `({ context }: NodeExecutionContext<unknown, ${ctx}>) => (context.agent ??= new PlaywrightAgent(context.page))` : `({ context }: NodeExecutionContext<unknown, ${ctx}>) => context.agent`;
            return `        {
            name: '${p}',
            setup: defineProjectSetup<${ctx}>({
                name: '${p}',
                ${SETUP[p].setup}
            }),
            files: { include: ['cases/${p}/**/*.{yaml,yml}'] },
            // Use these in cases as \${name}, e.g. gotoUrl: \${baseUrl} or launch: { uri: \${appId} }.
            variables: ${SETUP[p].variables},
            nodes: createMidsceneNodes<${ctx}>({ agentClass: ${SETUP[p].agent}, getAgent: ${getAgent} })
        }`;
        })
        .join(',\n');
    return `// ${CREATED_HEADER}
// Plain-English AI tests run by Midscene Test: https://midscenejs.com/midscene-test/overview
import { fileURLToPath } from 'node:url';

import type { NodeExecutionContext } from '@midscene/test';
import { defineProjectSetup, defineTestProject } from '@midscene/test/config';
import { createMidsceneNodes } from '@midscene/test/midscene';
${imports}
import { config as loadEnv } from 'dotenv';

// The model keys and app settings live in the project's .env (never committed); ai-tests/.env can override them.
loadEnv({ path: ['.env', '../.env', '../.env.example'].map(f => fileURLToPath(new URL(f, import.meta.url))), quiet: true });

${types}

${platforms.length > 1 ? '// Each project has its own device context, so the shared definition is typed loosely.\n' : ''}export default defineTestProject<${platforms.length > 1 ? 'any' : CONTEXT_NAME[platforms[0]]}>({
    projects: [
${projects}
    ]
});
`;
}

export function aiPackageJson(store: ProjectStore, config: Config, platforms: AiPlatform[]): string {
    const current = store.read(`${aiRoot(config)}/package.json`);
    let pkg: Record<string, any> = { name: `${(config.project.name ?? 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-ai-tests`, private: true, type: 'module' };
    if (current) {
        try {
            pkg = JSON.parse(current);
        } catch {
            /* rewritten below */
        }
    }
    pkg.scripts = { test: 'midscene-test', verify: 'midscene-test model verify', nodes: 'midscene-test nodes', postinstall: 'midscene-test nodes', ...(pkg.scripts ?? {}) };
    const deps: Record<string, string> = { '@midscene/test': MIDSCENE_VERSION, dotenv: '^17.2.0', typescript: '^5.9.0', '@types/node': '^22.20.0' };
    for (const p of platforms) deps[PACKAGE[p]] = MIDSCENE_VERSION;
    if (platforms.includes('web')) deps.playwright = mainPlaywrightVersion(store, config) ?? AI_PLAYWRIGHT_VERSION;
    pkg.devDependencies = { ...deps, ...(pkg.devDependencies ?? {}) };
    for (const p of platforms) pkg.devDependencies[PACKAGE[p]] ??= MIDSCENE_VERSION;
    pkg.overrides = { tsx: TSX_OVERRIDE, ...(pkg.overrides ?? {}) };
    return JSON.stringify(pkg, null, 2) + '\n';
}

/** The project's own Playwright version, so the AI folder reuses its downloaded browser. */
function mainPlaywrightVersion(store: ProjectStore, config: Config): string | undefined {
    const pkg = store.read(inTestRoot(config, 'package.json'));
    if (!pkg) return undefined;
    try {
        const all = { ...(JSON.parse(pkg).dependencies ?? {}), ...(JSON.parse(pkg).devDependencies ?? {}) } as Record<string, string>;
        const v = all['@playwright/test'] ?? all.playwright;
        return v && /^\^?~?\d+\.\d+\.\d+$/.test(v) ? v.replace(/^[\^~]/, '') : undefined;
    } catch {
        return undefined;
    }
}

export const AI_TSCONFIG = `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] }, include: ['midscene.config.ts'] }, null, 2)}\n`;

export const AI_GITIGNORE = `node_modules/\n.env\nmidscene_run/\nresults/\nmidscene-node-spec.*.md\n`;

/** One step in TestPilot's plain step format, turned into a Midscene Test node. */
export interface AiStep {
    kind: 'open' | 'do' | 'tap' | 'type' | 'check' | 'waitFor' | 'extract' | 'ask' | 'wait' | 'back' | 'home' | 'note';
    text?: string;
    value?: string;
    seconds?: number;
}

export const STEP_KINDS = ['open', 'do', 'tap', 'type', 'check', 'waitFor', 'extract', 'ask', 'wait', 'back', 'home', 'note'] as const;

export function stepNode(step: AiStep, platform: AiPlatform): Record<string, unknown> | { error: string } {
    const text = step.text?.trim() ?? '';
    const need = (what: string) => ({ error: `A "${step.kind}" step needs ${what}.` });
    switch (step.kind) {
        case 'open':
            if (platform === 'web') return text ? { gotoUrl: text } : { gotoUrl: '/' };
            if (platform === 'computer') return text ? { aiAct: `Open ${text}` } : need('what to open');
            return { launch: { uri: text || '${appId}' } };
        case 'do':
            return text ? { aiAct: text } : need('the action in plain words');
        case 'tap':
            return text ? { aiTap: text } : need('what to tap, in plain words');
        case 'type':
            return text && step.value !== undefined ? { aiInput: { prompt: text, value: step.value } } : need('text (which field) and value (what to type)');
        case 'check':
            return text ? { aiAssert: text } : need('what should be true on screen');
        case 'waitFor':
            return text ? { aiWaitFor: text } : need('what to wait for');
        case 'extract':
            return text ? { aiQuery: text } : need('what data to read from the screen, and its shape');
        case 'ask':
            return text ? { aiAsk: text } : need('the question');
        case 'wait':
            return { wait: { duration: step.seconds ?? 1, unit: 's' } };
        case 'back':
            return platform === 'android' || platform === 'harmony' ? { back: {} } : { aiAct: 'Go back to the previous screen' };
        case 'home':
            return platform === 'web' || platform === 'computer' ? { error: '"home" is a phone button; use "open" on websites and desktops.' } : { home: {} };
        case 'note':
            return text ? { recordToReport: text } : need('the note text');
    }
}

export interface AiCase {
    name: string;
    steps: AiStep[];
    /** Lines written as YAML comments above the case (preconditions, source link). */
    comments?: string[];
}

/** A cases file in Midscene Test's YAML format. */
export function casesYaml(cases: AiCase[], platform: AiPlatform, header: string[] = []): string | { error: string } {
    const doc = new YAML.Document({ cases: [] as unknown[] });
    const list = doc.get('cases') as YAML.YAMLSeq;
    for (const c of cases) {
        if (!c.steps.length) return { error: `"${c.name}" has no steps.` };
        const steps: unknown[] = [];
        for (const s of c.steps) {
            const node = stepNode(s, platform);
            if ('error' in node) return { error: `${c.name}: ${node.error}` };
            steps.push(node);
        }
        const item = doc.createNode({ name: c.name, steps }) as YAML.YAMLMap;
        if (c.comments?.length) item.commentBefore = c.comments.map(l => ` ${l.replace(/\r?\n/g, ' ')}`).join('\n');
        list.items.push(item);
    }
    const body = doc.toString({ lineWidth: 0 });
    return `${[`# ${CREATED_HEADER}`, '# Plain-English test steps. An AI model reads the screen and carries out each step.', ...header.map(h => `# ${h}`)].join('\n')}\n${body}`;
}

/** Turns an imported test case into AI steps: each action becomes "do", each expected result a "check". */
export function caseToAi(tc: TestCase, platform: AiPlatform): AiCase {
    const steps: AiStep[] = [{ kind: 'open' }];
    for (const s of tc.steps) {
        if (s.action.trim()) steps.push({ kind: 'do', text: s.data ? `${s.action.trim()} (use: ${s.data.trim()})` : s.action.trim() });
        if (s.expected?.trim()) steps.push({ kind: 'check', text: s.expected.trim() });
    }
    if (tc.expected?.trim() && !tc.steps.some(s => s.expected?.trim() === tc.expected?.trim())) steps.push({ kind: 'check', text: tc.expected.trim() });
    const comments = [
        ...(tc.preconditions.length ? [`Before this test: ${tc.preconditions.join('; ')}`] : []),
        ...(tc.source.link ? [`Source: ${tc.source.link}`] : [`Source: ${tc.source.type}${tc.source.ref ? ` ${tc.source.ref}` : ''}`])
    ];
    if (platform !== 'web' && platform !== 'computer' && steps[0].kind === 'open') steps[0] = { kind: 'open', text: '${appId}' };
    if (platform === 'computer') steps.shift();
    return { name: `${tc.id} ${tc.title}`, steps, comments };
}

export function slugify(s: string): string {
    return (
        s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'case'
    );
}

/** Starter cases per platform, modelled on Midscene's showcases. */
export function starterCases(platform: AiPlatform, config: Config): Array<{ file: string; content: string }> {
    const out: Array<{ file: string; content: string }> = [];
    const add = (file: string, cases: AiCase[], header: string[]) => {
        const yaml = casesYaml(cases, platform, header);
        if (typeof yaml === 'string') out.push({ file: `cases/${platform}/${file}`, content: yaml });
    };
    if (platform === 'web') {
        add(
            'smoke.yaml',
            [
                {
                    name: 'AI-1 home page looks right',
                    steps: [
                        { kind: 'open', text: '/' },
                        { kind: 'check', text: 'The page has loaded: there is visible content and no error message, blank page or "not found" text' },
                        { kind: 'extract', text: 'Return the visible main navigation links as an array of strings' }
                    ]
                }
            ],
            ['Opens APP_BASE_URL (from .env) and checks the page looks healthy. Run: npm test (in this folder) or ask your AI tool to "run the AI tests".']
        );
        add(
            'form.yaml',
            [
                {
                    name: 'AI-2 fill a form without sending it',
                    steps: [
                        { kind: 'open', text: '/' },
                        { kind: 'do', text: 'Find a sign-up, contact or search form on this site and fill every field with realistic test data. Do NOT press the final submit or send button.' },
                        { kind: 'check', text: 'The form fields are filled in and no validation error is shown' }
                    ]
                }
            ],
            ['Like Midscene\'s "GitHub sign-up" showcase: the AI fills a whole form from one sentence and stops before sending.', 'Edit the sentence to name your real form, e.g. "Fill the registration form on /signup".']
        );
    } else if (platform === 'computer') {
        add(
            'desktop.yaml',
            [
                {
                    name: 'AI-1 app window is ready',
                    steps: [
                        { kind: 'do', text: `Open ${config.project.name ?? 'the app under test'} and wait until its main window is shown` },
                        { kind: 'check', text: 'The main window of the app is visible with no error dialog' },
                        { kind: 'ask', text: 'Describe the main window in one sentence' }
                    ]
                }
            ],
            ['Drives the real mouse and keyboard, like Midscene\'s macOS, Windows and Linux showcases. Do not use the computer while it runs.']
        );
    } else {
        add(
            'smoke.yaml',
            [
                {
                    name: 'AI-1 app opens to its first screen',
                    steps: [
                        { kind: 'open', text: '${appId}' },
                        { kind: 'waitFor', text: 'The app has finished loading and its first screen is visible' },
                        { kind: 'check', text: 'No crash message, error dialog or blank screen is shown' },
                        { kind: 'ask', text: 'Describe the current screen in one sentence' }
                    ]
                }
            ],
            ['Launches APP_ID (the package name or bundle id in .env) and checks the first screen, like Midscene\'s Android, iOS and HarmonyOS showcases.']
        );
    }
    return out;
}

export function aiReadme(platforms: AiPlatform[]): string {
    const prep: Record<AiPlatform, string> = {
        web: '- Website: nothing extra if your Playwright tests already run. Otherwise run `npx playwright install chromium` here once. The address comes from APP_BASE_URL in .env.',
        android: '- Android: install Android platform tools (adb), connect a phone with USB debugging on (or start an emulator), and check `adb devices` lists it. Put the app\'s package name in APP_ID in .env, e.g. com.example.shop.',
        ios: '- iPhone/iOS simulator (Mac only): install Xcode and start WebDriverAgent on the device (https://midscenejs.com/ios-getting-started.html). Put the bundle id in APP_ID in .env.',
        harmony: '- HarmonyOS: install DevEco Studio command-line tools (hdc) and check `hdc list targets` lists the phone.',
        computer: '- Desktop: on macOS allow your terminal under System Settings → Privacy & Security → Accessibility and Screen Recording. While it runs, the AI moves the real mouse, so leave the computer alone.'
    };
    return `<!-- ${CREATED_HEADER} -->
# AI tests (plain English)

Each test here is a list of plain-English steps such as "fill the sign-up form but do not send it" or
"the basket shows 2 items". An AI vision model looks at the screen and carries them out. Powered by
[Midscene.js](https://midscenejs.com). Your normal tests keep running as before; these sit beside them.

## One-time setup

1. Pick an AI model and put its four values in the project's \`.env\` file (never in chat):
   MIDSCENE_MODEL_BASE_URL, MIDSCENE_MODEL_API_KEY, MIDSCENE_MODEL_NAME, MIDSCENE_MODEL_FAMILY.
   The list of models with copy-ready values is in docs/ai-steps.md of TestPilot, or ask your AI tool
   "which AI models can TestPilot's AI tests use?". Claude cannot be used here: Midscene needs a model
   that can point at screen positions (Gemini, Qwen, Doubao, GPT-5.4 or later, GLM-V, Kimi).
2. In this folder run \`npm install\`.
3. Check the model works: \`npm run verify\`.
${platforms.map(p => prep[p]).join('\n')}

## Run

- All AI tests: \`npm test\`
- One file: \`npx midscene-test cases/${platforms[0]}/smoke.yaml\`
- Watch the browser: set HEADLESS=false in .env

Each run prints the path of a visual report (\`midscene_run/report/…/index.html\`). Open it in a
browser to replay every step with screenshots, what the AI saw and what it decided.

## Writing tests

Cases live in \`cases/<platform>/\`. Every step is one line:

\`\`\`yaml
cases:
  - name: SHOP-12 add a mug to the basket
    steps:
      - gotoUrl: /                      # open the app (APP_BASE_URL)
      - aiAct: Search for "mug" and add the first result to the basket
      - aiWaitFor: The basket icon shows 1
      - aiAssert: The basket contains one mug
      - aiQuery: Return the basket total as a number
\`\`\`

\`npm install\` also writes \`midscene-node-spec.<platform>.md\`, the full list of steps you can use.
Each AI step sends a screenshot to your model provider: use test accounts and test data only.
`;
}

export interface AiRunCase {
    name: string;
    file: string;
    status: string;
    steps: number;
    failedStep?: string;
    error?: string;
}

export interface AiRunSummary {
    runId: string;
    status: string;
    total: number;
    passed: number;
    failed: number;
    notRun: number;
    durationMs: number;
    report?: string;
    cases: AiRunCase[];
    setupErrors: string[];
}

/** Reads Midscene Test's results/<run>/summary.json (schema 3) and the per-case result files. */
export function readAiSummary(store: ProjectStore, resultsDir: string, runDir: string): AiRunSummary | undefined {
    const raw = store.read(`${resultsDir}/${runDir}/summary.json`);
    if (!raw) return undefined;
    let data: any;
    try {
        data = JSON.parse(raw);
    } catch {
        return undefined;
    }
    const report = typeof data.report === 'string' ? normalise(`${resultsDir}/${runDir}/${data.report}`) : undefined;
    const cases: AiRunCase[] = [];
    const setupErrors: string[] = [];
    for (const project of data.projects ?? []) {
        if (project.lifecycle?.setupError?.message) setupErrors.push(`${project.name}: ${String(project.lifecycle.setupError.message).split('\n')[0]}`);
        for (const c of project.cases ?? []) {
            const attempt = (c.attempts ?? []).at(-1);
            let detail: any;
            if (attempt?.resultFile) {
                try {
                    detail = JSON.parse(store.read(`${resultsDir}/${runDir}/${attempt.resultFile}`) ?? 'null');
                } catch {
                    detail = undefined;
                }
            }
            const steps: any[] = detail?.steps ?? [];
            const bad = steps.find(s => s.status && s.status !== 'success' && !s.continuedAfterError);
            cases.push({
                name: c.name,
                file: c.sourcePath,
                status: c.status,
                steps: steps.length,
                failedStep: bad ? `${bad.node}${bad.input?.prompt ? `: ${bad.input.prompt}` : ''}` : undefined,
                error: bad?.error?.message ? String(bad.error.message).split('\n')[0].slice(0, 400) : c.notRunReason
            });
        }
    }
    return {
        runId: data.runId,
        status: data.status,
        total: data.summary?.total ?? cases.length,
        passed: data.summary?.passed ?? 0,
        failed: data.summary?.failed ?? 0,
        notRun: data.summary?.notRun ?? 0,
        durationMs: data.durationMs ?? 0,
        report,
        cases,
        setupErrors
    };
}

function normalise(p: string): string {
    const out: string[] = [];
    for (const part of p.split('/')) {
        if (part === '..') out.pop();
        else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
}

export function describeAiRun(run: AiRunSummary): string {
    const lines = [`AI tests: ${run.passed} passed, ${run.failed} failed${run.notRun ? `, ${run.notRun} not run` : ''} in ${Math.round(run.durationMs / 1000)}s.`];
    for (const e of run.setupErrors) lines.push(`Could not start ${e}`);
    for (const c of run.cases.filter(c => c.status !== 'success').slice(0, 15)) {
        lines.push('', `${c.status === 'not-run' ? 'Not run' : 'Failed'}: ${c.name} (${c.file})`);
        if (c.failedStep) lines.push(`Step: ${c.failedStep}`);
        if (c.error) lines.push(`Why: ${c.error}`);
    }
    if (run.report) lines.push('', `Visual report (replay every step with screenshots): ${run.report}`);
    lines.push('Token use and cost per step are in that report.');
    if (run.failed) lines.push('Open the report to see what the AI saw. If the app is wrong, it is a bug to report; if the step is vague, make the sentence more specific. Never weaken a check without the user agreeing.');
    return lines.join('\n');
}
