import path from 'node:path';

import type { Config, TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { type ExploredElement, type ExploredPage, quote } from '../explore/web.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot, type PlannedFile } from '../scaffold/engine.js';
import { clean } from '../testcases/normalize.js';
import { type ActionIntent, type CheckIntent, normaliseStep, parseAction, parseCheck, type ValueSource } from './intents.js';

/**
 * Generates Playwright + TypeScript tests in the Page Object Model from test cases.
 * Each case becomes one spec named after its id; elements go into one page object per
 * area (or per page the steps open), registered as fixtures. Steps TestPilot cannot
 * translate confidently become TODO(testpilot) comments and the test is marked fixme,
 * so nothing passes by accident; the AI in the client finishes them with the skills.
 */

export interface GeneratedCase {
    id: string;
    spec: string;
    todos: number;
    skipped?: string;
}

export interface GenerationPlan {
    files: PlannedFile[];
    cases: GeneratedCase[];
    pageObjects: string[];
    notes: string[];
}

interface PageObjectDraft {
    className: string;
    fixture: string;
    file: string;
    path: string;
    pathKnown: boolean;
    locators: Map<string, string>;
    methods: Map<string, string>;
    usesUsers: boolean;
}

const HOME_WORDS = /^(home|homepage|application|app|site|website|web ?site|url|browser|portal|landing|start|main|base url|the application)$/i;
const SETUP_ONLY = /\b(browser is (open|launched|running)|application is (open|running|launched|installed|available)|app is installed|internet|network connection|test environment is (up|available)|user has access to the (app|application|site))\b/i;
const LOGGED_IN = /\b(user is |already |is )?(logged|signed) ?in\b/i;
const VERIFY = /^(verify|check that|check if|ensure|confirm|validate|assert|observe|see that|should|expect)\b/i;

function words(s: string): string[] {
    return s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

export function pascal(s: string): string {
    const w = words(s);
    const out = w.map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join('');
    return /^[0-9]/.test(out) ? `P${out}` : out || 'App';
}

export function camel(s: string): string {
    const p = pascal(s);
    return p.charAt(0).toLowerCase() + p.slice(1);
}

export function slug(s: string): string {
    return words(s).join('-').toLowerCase().slice(0, 60) || 'general';
}

/** One line of untrusted text, safe inside a // comment. */
function comment(s: string): string {
    return clean(s).text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').slice(0, 200);
}

const ROLE_SUFFIX: Record<string, string> = { button: 'Button', link: 'Link', textbox: 'Field', searchbox: 'Field', combobox: 'Dropdown', listbox: 'List', checkbox: 'Checkbox', radio: 'Option', option: 'Option', tab: 'Tab', menuitem: 'MenuItem', switch: 'Switch', heading: 'Heading', spinbutton: 'Field', slider: 'Slider' };

export class PlaywrightGenerator {
    private pages = new Map<string, PageObjectDraft>();
    private readonly elements: Array<ExploredElement & { page: ExploredPage }>;
    private readonly existingPageFiles = new Set<string>();

    constructor(
        private readonly store: ProjectStore,
        private readonly config: Config,
        private readonly exploration: ExploredPage[]
    ) {
        this.elements = exploration.flatMap(p => p.elements.map(e => ({ ...e, page: p })));
        for (const f of store.list(inTestRoot(config, 'src/pages'), n => n.endsWith('.ts'))) this.existingPageFiles.add(path.posix.basename(f, '.ts'));
    }

    private find(name: string, roles: string[]): (ExploredElement & { page: ExploredPage }) | undefined {
        const n = name.toLowerCase();
        const candidates = this.elements.filter(e => roles.includes(e.role));
        return candidates.find(e => e.name.toLowerCase() === n) ?? candidates.find(e => e.name.toLowerCase().includes(n) && n.length >= 3) ?? candidates.find(e => n.includes(e.name.toLowerCase()) && e.name.length >= 3);
    }

    private explorePathFor(name: string): string | undefined {
        const n = name.toLowerCase();
        const page = this.exploration.find(p => !p.error && (p.title.toLowerCase().includes(n) || p.headings.some(h => h.toLowerCase().includes(n)) || p.path.toLowerCase().includes(slug(n))));
        return page?.path;
    }

    pageObject(name: string): PageObjectDraft {
        const className = `${pascal(name.replace(/\s*page$/i, ''))}Page`;
        let draft = this.pages.get(className);
        if (!draft) {
            const explored = this.explorePathFor(name);
            draft = {
                className,
                fixture: camel(className),
                file: inTestRoot(this.config, `src/pages/${className}.ts`),
                path: explored ?? (/^login|sign ?in/i.test(name) ? '/login' : `/${slug(name)}`),
                pathKnown: Boolean(explored),
                locators: new Map(),
                methods: new Map(),
                usesUsers: false
            };
            this.pages.set(className, draft);
        }
        return draft;
    }

    private addLocator(po: PageObjectDraft, prop: string, expr: string): string {
        let name = prop;
        let i = 2;
        while (po.locators.has(name) && po.locators.get(name) !== expr) name = `${prop}${i++}`;
        po.locators.set(name, expr);
        return name;
    }

    /** Locator for something to click, preferring what exploration actually saw. */
    private clickable(po: PageObjectDraft, name: string, role?: string): string {
        const roles = role ? [role] : ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch'];
        const seen = this.find(name, roles);
        const r = seen?.role ?? role;
        const label = seen?.name ?? name;
        const expr = r ? `this.page.getByRole(${quote(r)}, { name: ${quote(label)} })` : `this.page.getByRole('button', { name: ${quote(label)} }).or(this.page.getByRole('link', { name: ${quote(label)} }))`;
        return this.addLocator(po, camel(label) + (ROLE_SUFFIX[r ?? 'button'] ?? 'Button'), expr);
    }

    private field(po: PageObjectDraft, name: string): string {
        const seen = this.find(name, ['textbox', 'searchbox', 'combobox', 'spinbutton']);
        const expr = seen ? `this.page.getByRole(${quote(seen.role)}, { name: ${quote(seen.name)} })` : `this.page.getByLabel(${quote(name)})`;
        return this.addLocator(po, camel(seen?.name ?? name) + (seen?.role === 'combobox' ? 'Dropdown' : 'Field'), expr);
    }

    private loginPage(): PageObjectDraft {
        const po = this.pageObject('Login');
        const pwd = this.elements.find(e => e.role === 'textbox' && /pass ?word/i.test(e.name));
        if (pwd && !po.pathKnown) {
            po.path = pwd.page.path;
            po.pathKnown = true;
        }
        if (!po.methods.has('login')) {
            const user = this.elements.find(e => e.role === 'textbox' && /e-?mail|user ?name|login/i.test(e.name));
            const submit = this.elements.find(e => e.role === 'button' && /sign ?in|log ?in|continue|submit/i.test(e.name));
            // Reuse the same members the fill/click steps would create, so a page object never has two names for one element.
            const userProp = user ? this.field(po, user.name) : this.addLocator(po, 'usernameField', `this.page.getByLabel(/e-?mail|user ?name/i)`);
            const pwdProp = pwd ? this.field(po, pwd.name) : this.addLocator(po, 'passwordField', `this.page.getByLabel(/password/i)`);
            const submitProp = submit ? this.clickable(po, submit.name, 'button') : this.addLocator(po, 'signInButton', `this.page.getByRole('button', { name: /sign in|log ?in/i })`);
            po.methods.set(
                'login',
                `    async login(username: string, password: string): Promise<void> {
        await this.${userProp}.fill(username);
        await this.${pwdProp}.fill(password);
        await this.${submitProp}.click();
    }`
            );
            po.methods.set(
                'loginAs',
                `    /** Opens the login page and signs in as a role from test-data/users.json (credentials come from .env). */
    async loginAs(role = 'standard'): Promise<void> {
        const user = testUser(role);
        await this.open();
        await this.login(user.username, user.password);
    }`
            );
            po.usesUsers = true;
        }
        return po;
    }

    private value(v: ValueSource, imports: Set<string>, todos: string[], field: string): string {
        if (v.kind === 'literal') return quote(v.value);
        if (v.kind === 'env') {
            imports.add('requireEnv');
            return `requireEnv(${quote(v.name)})`;
        }
        todos.push(`choose the ${field} value`);
        return `'' /* TODO(testpilot): ${comment(v.hint)} */`;
    }

    private action(intent: ActionIntent, ctx: SpecContext): string[] {
        const po = ctx.current;
        switch (intent.kind) {
            case 'open': {
                const electron = this.config.appType === 'electron';
                if (electron && (intent.path || !intent.target || HOME_WORDS.test(intent.target))) {
                    if (!intent.path) return ['// The electronApp fixture has already opened the app window.'];
                    ctx.todos.push(`reach ${intent.path} through the app's menus`);
                    return [`// TODO(testpilot): reach ${comment(intent.path)} through the app's menus or buttons (Electron windows have no address bar).`];
                }
                if (intent.path) return [`await page.goto(${quote(intent.path.replace(/^https?:\/\/[^/]+/i, '') || '/')});`];
                if (!intent.target || HOME_WORDS.test(intent.target)) return [`await page.goto('/');`];
                const target = this.pageObject(intent.target);
                ctx.current = target;
                ctx.fixtures.add(target.fixture);
                return [`await ${target.fixture}.open();`];
            }
            case 'login': {
                const login = this.loginPage();
                ctx.fixtures.add(login.fixture);
                return [`await ${login.fixture}.loginAs(${quote(intent.role)});`];
            }
            case 'logout': {
                const prop = this.clickable(po, 'Log out');
                ctx.fixtures.add(po.fixture);
                return [`await ${po.fixture}.${prop}.click();`];
            }
            case 'fill': {
                const prop = this.field(po, intent.field);
                ctx.fixtures.add(po.fixture);
                return [`await ${po.fixture}.${prop}.fill(${this.value(intent.value, ctx.imports, ctx.todos, intent.field)});`];
            }
            case 'clear': {
                const prop = this.field(po, intent.field);
                ctx.fixtures.add(po.fixture);
                return [`await ${po.fixture}.${prop}.clear();`];
            }
            case 'select': {
                const seen = this.find(intent.field, ['combobox', 'listbox']);
                const prop = this.addLocator(po, `${camel(seen?.name ?? intent.field)}Dropdown`, seen ? `this.page.getByRole(${quote(seen.role)}, { name: ${quote(seen.name)} })` : `this.page.getByLabel(${quote(intent.field)})`);
                ctx.fixtures.add(po.fixture);
                return [`await ${po.fixture}.${prop}.selectOption(${quote(intent.option)});`];
            }
            case 'check': {
                const seen = this.find(intent.name, ['checkbox', 'switch', 'radio']);
                const prop = this.addLocator(po, `${camel(seen?.name ?? intent.name)}Checkbox`, `this.page.getByRole(${quote(seen?.role ?? 'checkbox')}, { name: ${quote(seen?.name ?? intent.name)} })`);
                ctx.fixtures.add(po.fixture);
                return [`await ${po.fixture}.${prop}.${intent.checked ? 'check' : 'uncheck'}();`];
            }
            case 'click': {
                ctx.fixtures.add(po.fixture);
                if (intent.within) {
                    const method = `${camel(intent.name)}${ROLE_SUFFIX[intent.role ?? 'button'] ?? 'Button'}For`;
                    if (!po.methods.has(method)) {
                        const seen = this.find(intent.name, intent.role ? [intent.role] : ['button', 'link']);
                        po.methods.set(
                            method,
                            `    /** The "${comment(intent.name)}" ${seen?.role ?? intent.role ?? 'button'} inside the list item or row that contains \`text\`. */
    ${method}(text: string): Locator {
        return this.page
            .getByRole('listitem')
            .or(this.page.getByRole('row'))
            .or(this.page.getByRole('article'))
            .filter({ hasText: text })
            .getByRole(${quote(seen?.role ?? intent.role ?? 'button')}, { name: ${quote(seen?.name ?? intent.name)} });
    }`
                        );
                    }
                    return [`await ${po.fixture}.${method}(${quote(intent.within)}).click();`];
                }
                const prop = this.clickable(po, intent.name, intent.role);
                return [`await ${po.fixture}.${prop}.click();`];
            }
            case 'press':
                return [`await page.keyboard.press(${quote(intent.key)});`];
            case 'hover': {
                const prop = this.clickable(po, intent.name);
                ctx.fixtures.add(po.fixture);
                return [`await ${po.fixture}.${prop}.hover();`];
            }
            case 'search': {
                const prop = this.addLocator(po, 'searchField', `this.page.getByRole('searchbox').or(this.page.getByPlaceholder(/search/i))`);
                ctx.fixtures.add(po.fixture);
                return [`await ${po.fixture}.${prop}.fill(${quote(intent.text)});`, `await ${po.fixture}.${prop}.press('Enter');`];
            }
            case 'reload':
                return ['await page.reload();'];
            case 'back':
                return ['await page.goBack();'];
            case 'wait':
                return ['// No fixed wait: the next step or assertion waits for its own condition.'];
            case 'unknown':
                ctx.todos.push(intent.text);
                return [`// TODO(testpilot): ${comment(intent.text)}`];
        }
    }

    private check(intent: CheckIntent, ctx: SpecContext): string[] {
        switch (intent.kind) {
            case 'text':
                return [`await expect(page.getByText(${quote(intent.text)})).${intent.visible ? 'toBeVisible' : 'toBeHidden'}();`];
            case 'heading': {
                if (HOME_WORDS.test(intent.name)) return [`await expect(page).toHaveURL(/\\/$/);`];
                const seen = this.elements.find(e => e.role === 'heading' && e.name.toLowerCase().includes(intent.name.toLowerCase()));
                return [`await expect(page.getByRole('heading', { name: ${quote(seen?.name ?? intent.name)} })).toBeVisible();`];
            }
            case 'title':
                return [intent.exact ? `await expect(page).toHaveTitle(${quote(intent.text)});` : `await expect(page).toHaveTitle(new RegExp(${quote(escapeRegExp(intent.text))}));`];
            case 'url':
                return [`await expect(page).toHaveURL(new RegExp(${quote(escapeRegExp(intent.part))}));`];
            case 'count': {
                const want = slug(intent.name).split('-');
                const testId = this.exploration.flatMap(p => p.testIds).find(t => want.every(w => t.value.toLowerCase().includes(w)) || (want.length && t.value.toLowerCase().includes(want[0]) && /count|badge|total|qty|quantity/.test(t.value)));
                if (testId) return [`await expect(page.getByTestId(${quote(testId.value)})).toHaveText(${quote(intent.value)});`];
                ctx.todos.push(`check that the ${intent.name} shows ${intent.value}`);
                return [`// TODO(testpilot): check that the ${comment(intent.name)} shows ${comment(intent.value)} (no element with that name was found during exploration)`];
            }
            case 'state': {
                const po = ctx.current;
                ctx.fixtures.add(po.fixture);
                const prop = intent.role === 'field' ? this.field(po, intent.name) : this.clickable(po, intent.name, intent.role === 'link' || intent.role === 'checkbox' ? intent.role : intent.role === 'button' ? 'button' : undefined);
                const matcher = { enabled: 'toBeEnabled', disabled: 'toBeDisabled', visible: 'toBeVisible', hidden: 'toBeHidden', checked: 'toBeChecked', unchecked: 'not.toBeChecked' }[intent.state];
                return [`await expect(${po.fixture}.${prop}).${matcher}();`];
            }
            case 'unknown':
                ctx.todos.push(`check: ${intent.text}`);
                return [`// TODO(testpilot): check that ${comment(intent.text)}`];
        }
    }

    /** Builds the spec for one case and records what it needs in page objects. */
    spec(tc: TestCase): { file: string; content: string; todos: number } {
        const area = tc.area ?? 'General';
        const home = this.pageObject(/^(general|home|smoke)$/i.test(area) ? 'Home' : area);
        const ctx: SpecContext = { current: home, fixtures: new Set(), imports: new Set(), todos: [] };
        const body: string[] = [];
        for (const pre of tc.preconditions) {
            body.push(`// Precondition: ${comment(pre)}`);
            if (LOGGED_IN.test(pre) && !/not (logged|signed)/i.test(pre)) body.push(...this.action({ kind: 'login', role: /admin/i.test(pre) ? 'admin' : 'standard' }, ctx));
            else if (!SETUP_ONLY.test(pre)) {
                ctx.todos.push(`set up: ${pre}`);
                body.push('// TODO(testpilot): set this up in the test (through the API or a fixture), not by hand.');
            }
        }
        tc.steps.forEach((step, i) => {
            if (body.length) body.push('');
            body.push(`// Step ${i + 1}: ${comment(step.action)}${step.data ? ` (data: ${comment(step.data)})` : ''}`);
            const normalised = normaliseStep(step.action);
            if (VERIFY.test(normalised)) body.push(...parseCheck(step.action).flatMap(c => this.check(c, ctx)));
            else body.push(...parseAction(step.action, step.data ?? tc.testData).flatMap(a => this.action(a, ctx)));
            if (step.expected) {
                body.push(`// Expected: ${comment(step.expected)}`);
                body.push(...parseCheck(step.expected).flatMap(c => this.check(c, ctx)));
            }
        });
        if (tc.expected) {
            body.push('', `// Expected: ${comment(tc.expected)}`);
            for (const line of tc.expected.split(/\n+/).filter(Boolean)) body.push(...parseCheck(line).flatMap(c => this.check(c, ctx)));
        }
        if (!tc.steps.length && !tc.expected) {
            ctx.todos.push('write the steps');
            body.push('// TODO(testpilot): this case has no steps yet.');
        }

        const file = inTestRoot(this.config, `tests/${slug(area)}/${slugId(tc.id)}.spec.ts`);
        const fixturesImport = relativeImport(file, inTestRoot(this.config, 'src/fixtures/test'));
        const usesExpect = body.some(l => l.includes('expect('));
        const usesPage = body.some(l => /\bpage\./.test(l) || /\(page\)/.test(l));
        const fixtures = [...(usesPage ? ['page'] : []), ...[...ctx.fixtures].sort()];
        const tags = [`@${tc.id}`, ...(tc.area ? [`@${slug(tc.area)}`] : []), ...(tc.priority ? [`@${tc.priority.toLowerCase()}`] : []), ...tc.tags.map(t => `@${slug(t)}`)].filter((t, i, all) => all.indexOf(t) === i && t.length > 1);
        const title = `${tc.id} ${clean(tc.title).text.replace(/\s+/g, ' ')}`;
        const todos = ctx.todos.length;
        const lines = [
            `// ${CREATED_HEADER}`,
            `// Generated from test case ${comment(tc.id)} (${comment(tc.source.type)}${tc.source.ref ? `: ${comment(tc.source.ref)}` : ''}).${todos ? ` ${todos} TODO(testpilot) item(s) to finish; the test is marked fixme until then.` : ''}`,
            `import { ${usesExpect ? 'expect, ' : ''}test } from ${quote(fixturesImport)};`,
            ...(ctx.imports.has('requireEnv') ? [`import { requireEnv } from ${quote(relativeImport(file, inTestRoot(this.config, 'src/utils/env')))};`] : []),
            '',
            `test${todos ? '.fixme' : ''}(`,
            `    ${quote(title)},`,
            `    { tag: [${tags.map(quote).join(', ')}], annotation: { type: 'test_key', description: ${quote(tc.id)} } },`,
            `    async ({ ${fixtures.join(', ')} }) => {`,
            ...body.map(l => (l ? `        ${l}` : '')),
            '    }',
            ');',
            ''
        ];
        return { file, content: lines.join('\n'), todos };
    }

    /** Page objects, the users helper and fixture registrations needed by the specs built so far. */
    supportFiles(): { files: PlannedFile[]; notes: string[] } {
        const files: PlannedFile[] = [];
        const notes: string[] = [];
        const used = [...this.pages.values()].filter(po => po.locators.size || po.methods.size || this.specFixtures.has(po.fixture));
        for (const po of used) files.push(this.pageObjectFile(po, notes));
        if (used.some(po => po.usesUsers)) files.push(compareWithDisk(this.store, inTestRoot(this.config, 'src/utils/users.ts'), USERS_HELPER, true));
        files.push(this.fixturesFile(used, notes));
        return { files, notes };
    }

    readonly specFixtures = new Set<string>();

    private pageObjectFile(po: PageObjectDraft, notes: string[]): PlannedFile {
        const current = this.store.read(po.file);
        const locatorLines = [...po.locators.entries()].map(([name, expr]) => `    readonly ${name}: Locator = ${expr};`);
        const methodBlocks = [...po.methods.values()];
        if (current === undefined) {
            const needsLocator = locatorLines.length > 0 || methodBlocks.some(m => m.includes('Locator'));
            const content = [
                `// ${CREATED_HEADER}`,
                ...(needsLocator ? [`import type { Locator } from '@playwright/test';`, ''] : []),
                `import { BasePage } from './BasePage';`,
                ...(po.usesUsers ? [`import { testUser } from '../utils/users';`] : []),
                '',
                `/** Page object for ${comment(po.className.replace(/Page$/, ''))}. TestPilot adds locators and actions above the markers when it generates new tests. */`,
                `export class ${po.className} extends BasePage {`,
                `    protected readonly path = ${quote(po.path)};${po.pathKnown ? '' : ' // TODO(testpilot): check this path; exploration did not find the page.'}`,
                '',
                ...locatorLines,
                '    // testpilot:locators',
                ...(methodBlocks.length ? ['', methodBlocks.join('\n\n')] : []),
                '    // testpilot:actions',
                '}',
                ''
            ].join('\n');
            return { path: po.file, status: 'new', content };
        }
        // Existing page object: add only what is missing, above the markers.
        const missingLocators = [...po.locators.entries()].filter(([name]) => !new RegExp(`\\b${name}\\b`).test(current)).map(([name, expr]) => `    readonly ${name}: Locator = ${expr};`);
        const missingMethods = [...po.methods.entries()].filter(([name]) => !new RegExp(`\\b${name}\\s*\\(`).test(current)).map(([, block]) => block);
        if (!missingLocators.length && !missingMethods.length) return { path: po.file, status: 'unchanged', content: current };
        if ((missingLocators.length && !current.includes('// testpilot:locators')) || (missingMethods.length && !current.includes('// testpilot:actions'))) {
            notes.push(`${po.file} has no TestPilot markers, so it was left alone. Add these members yourself:\n${[...missingLocators, ...missingMethods].join('\n')}`);
            return { path: po.file, status: 'skip', content: current, note: 'No // testpilot: markers; add the listed members by hand.' };
        }
        let content = current;
        if (missingLocators.length) content = content.replace(/^([ \t]*)\/\/ testpilot:locators/m, `${missingLocators.join('\n')}\n$1// testpilot:locators`);
        if (missingMethods.length) content = content.replace(/^([ \t]*)\/\/ testpilot:actions/m, `\n${missingMethods.join('\n\n')}\n$1// testpilot:actions`);
        if (po.usesUsers && !content.includes('testUser')) content = content.replace(/(import \{ BasePage \} from '\.\/BasePage';)/, `$1\nimport { testUser } from '../utils/users';`);
        if ((missingLocators.length || missingMethods.some(m => m.includes('Locator'))) && !/import (type )?\{[^}]*\bLocator\b/.test(content)) {
            content = content.replace(/^(\/\/[^\n]*\n)?/, m => `${m}import type { Locator } from '@playwright/test';\n`);
        }
        return { path: po.file, status: 'merge', content, note: `Adds ${[...missingLocators, ...missingMethods].length} member(s) above the TestPilot markers.` };
    }

    private fixturesFile(pages: PageObjectDraft[], notes: string[]): PlannedFile {
        const file = inTestRoot(this.config, 'src/fixtures/test.ts');
        const current = this.store.read(file);
        if (current === undefined) {
            notes.push(`${file} is missing. Run scaffold_project first.`);
            return { path: file, status: 'skip', content: '', note: 'Missing; scaffold the framework first.' };
        }
        const missing = pages.filter(po => !new RegExp(`\\b${po.fixture}\\s*:`).test(current));
        if (!missing.length) return { path: file, status: 'unchanged', content: current };
        if (!current.includes('// testpilot:fixture-types') || !current.includes('// testpilot:fixtures')) {
            notes.push(`${file} has no TestPilot markers. Register these page objects as fixtures yourself: ${missing.map(po => po.className).join(', ')}.`);
            return { path: file, status: 'skip', content: current, note: 'No // testpilot: markers.' };
        }
        let content = current;
        const imports = missing.filter(po => !content.includes(`{ ${po.className} }`)).map(po => `import { ${po.className} } from '${relativeImport(file, po.file.replace(/\.ts$/, ''))}';`);
        if (imports.length) {
            const lastImport = [...content.matchAll(/^import .+;$/gm)].pop();
            content = lastImport ? content.slice(0, lastImport.index! + lastImport[0].length) + '\n' + imports.join('\n') + content.slice(lastImport.index! + lastImport[0].length) : `${imports.join('\n')}\n${content}`;
        }
        content = content.replace(/^([ \t]*)\/\/ testpilot:fixture-types/m, `${missing.map(po => `$1${po.fixture}: ${po.className};`).join('\n')}\n$1// testpilot:fixture-types`);
        content = content.replace(
            /^([ \t]*)\/\/ testpilot:fixtures/m,
            `${missing.map(po => `$1${po.fixture}: async ({ page }, use) => {\n$1    await use(new ${po.className}(page));\n$1},`).join('\n')}\n$1// testpilot:fixtures`
        );
        return { path: file, status: 'merge', content, note: `Registers ${missing.map(po => po.className).join(', ')} as fixtures.` };
    }
}

interface SpecContext {
    current: PageObjectDraft;
    fixtures: Set<string>;
    imports: Set<string>;
    todos: string[];
}

function slugId(id: string): string {
    return id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function relativeImport(fromFile: string, toModule: string): string {
    const rel = path.posix.relative(path.posix.dirname(fromFile), toModule);
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const USERS_HELPER = `// ${CREATED_HEADER}
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { test } from '@playwright/test';

import { requireEnv } from './env';

interface UserEntry {
    usernameEnv?: string;
    emailEnv?: string;
    passwordEnv: string;
    description?: string;
}

/**
 * Credentials for a role in test-data/users.json. The file holds only the names of
 * .env keys; the values come from .env locally and from CI secrets in pipelines.
 */
export function testUser(role: string): { username: string; password: string } {
    const root = test.info().config.configFile ? path.dirname(test.info().config.configFile!) : process.cwd();
    const users = JSON.parse(readFileSync(path.join(root, 'test-data', 'users.json'), 'utf8')) as Record<string, UserEntry>;
    const entry = users[role];
    if (!entry) throw new Error(\`No user with role "\${role}" in test-data/users.json. Add it with the names of its .env keys.\`);
    return { username: requireEnv(entry.usernameEnv ?? entry.emailEnv ?? 'TEST_USER_EMAIL'), password: requireEnv(entry.passwordEnv) };
}
`;

/** Plans every file for a batch of cases. Cases containing text written as instructions to an AI are left for a person. */
export function planPlaywrightTests(store: ProjectStore, config: Config, cases: TestCase[], exploration: ExploredPage[]): GenerationPlan {
    const gen = new PlaywrightGenerator(store, config, exploration);
    const files: PlannedFile[] = [];
    const out: GeneratedCase[] = [];
    for (const tc of cases) {
        const text = [tc.title, ...tc.preconditions, ...tc.steps.flatMap(s => [s.action, s.data ?? '', s.expected ?? '']), tc.expected ?? ''].join('\n');
        if (clean(text).suspicious) {
            out.push({ id: tc.id, spec: '', todos: 0, skipped: 'Contains text written as instructions to an AI. A person should check the case first.' });
            continue;
        }
        const spec = gen.spec(tc);
        for (const fx of spec.content.match(/async \(\{ ([^}]+) \}\)/)?.[1].split(', ') ?? []) gen.specFixtures.add(fx);
        files.push(compareWithDisk(store, spec.file, spec.content));
        out.push({ id: tc.id, spec: spec.file, todos: spec.todos });
    }
    const support = gen.supportFiles();
    return { files: [...support.files, ...files], cases: out, pageObjects: support.files.filter(f => f.path.includes('/pages/') || f.path.startsWith('src/pages/')).map(f => f.path), notes: support.notes };
}
