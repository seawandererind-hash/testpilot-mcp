import path from 'node:path';

import type { Config, TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import type { ExploredScreen, MobileElement } from '../explore/mobile.js';
import { quote } from '../explore/web.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot, type PlannedFile, renderContext, renderTemplate } from '../scaffold/engine.js';
import { clean } from '../testcases/normalize.js';
import { type ActionIntent, type CheckIntent, normaliseStep, parseAction, parseCheck, type ValueSource } from './intents.js';
import { camel, type GeneratedCase, type GenerationPlan, pascal, slug } from './playwright.js';

/**
 * Generates Appium tests (WebdriverIO 9 + Mocha, TypeScript) in the screen-object pattern from
 * test cases. Each case becomes one spec named after its id, with the id at the start of the
 * title and as an @tag. Elements go into one screen object per area (or per screen a step
 * names). Selectors come from exploration when it saw the element: accessibility id first,
 * then resource-id / name, then visible text; never XPath by position. Steps TestPilot cannot
 * translate become TODO(testpilot) comments and the test is marked pending, so nothing passes
 * by accident.
 */

interface Getter {
    expr: string;
    note?: string;
}

interface ScreenDraft {
    className: string;
    instance: string;
    title: string;
    file: string;
    getters: Map<string, Getter>;
    methods: Map<string, string>;
    /** Expression for the anchor of a new screen (what waitForScreen waits for). */
    anchor?: Getter;
    usesUsers: boolean;
}

interface SpecContext {
    current: ScreenDraft;
    screens: Set<ScreenDraft>;
    imports: Set<'requireEnv' | 'driver' | 'Key'>;
    todos: string[];
}

const HOME_WORDS = /^(home|homepage|home screen|application|app|mobile app|site|website|start|main|landing|launcher|the application)$/i;
const SETUP_ONLY = /\b(app(lication)? is (installed|open|running|launched|available)|device is (connected|unlocked|online)|emulator is (running|started)|internet|network connection|test environment is (up|available)|user has access to the (app|application))\b/i;
const LOGGED_IN = /\b(user is |already |is )?(logged|signed) ?in\b/i;
const VERIFY = /^(verify|check that|check if|ensure|confirm|validate|assert|observe|see that|should|expect)\b/i;
const GUESSED = 'Not seen during exploration: confirm it with explore_app or Appium Inspector.';

const SUFFIX: Record<string, string> = { button: 'Button', link: 'Link', textbox: 'Field', searchbox: 'Field', combobox: 'Dropdown', checkbox: 'Checkbox', switch: 'Switch', radio: 'Option', tab: 'Tab', menuitem: 'MenuItem', slider: 'Slider', cell: 'Item', text: 'Text', heading: 'Title' };
const CLICKABLE = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'switch', 'radio', 'cell', 'image', 'text'];
const FIELDS = ['textbox', 'searchbox', 'combobox'];
const KEYS: Record<string, string> = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };

/** One line of untrusted text, safe inside a // comment. */
function comment(s: string): string {
    return clean(s).text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').slice(0, 200);
}

function slugId(id: string): string {
    return id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function relativeImport(fromFile: string, toModule: string): string {
    const rel = path.posix.relative(path.posix.dirname(fromFile), toModule);
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export class AppiumGenerator {
    private screens = new Map<string, ScreenDraft>();
    private readonly elements: MobileElement[];
    /** android-ios suites share screens, so only accessibility ids and visible text are portable. */
    private readonly crossPlatform: boolean;
    private readonly desktop: boolean;

    constructor(
        private readonly store: ProjectStore,
        private readonly config: Config,
        private readonly exploration: ExploredScreen[]
    ) {
        this.elements = exploration.flatMap(s => s.elements);
        this.crossPlatform = config.appType === 'android-ios';
        this.desktop = config.appType === 'windows' || config.appType === 'macos';
    }

    private find(name: string, roles: string[]): MobileElement | undefined {
        const n = name.toLowerCase().trim();
        if (!n) return undefined;
        const keys = (e: MobileElement) => [e.label, e.text ?? '', e.accessibilityId ?? '', (e.resourceId ?? '').split('/').pop() ?? ''].map(k => k.toLowerCase().replace(/[_-]+/g, ' ').trim()).filter(Boolean);
        const candidates = this.elements.filter(e => roles.includes(e.role) && e.count === 1);
        return (
            candidates.find(e => keys(e).some(k => k === n)) ??
            candidates.find(e => n.length >= 3 && keys(e).some(k => k.includes(n))) ??
            candidates.find(e => keys(e).some(k => k.length >= 3 && n.includes(k)))
        );
    }

    /** Selector expression for an element exploration saw: accessibility id, then resource-id / name, then text. */
    private seenExpr(e: MobileElement, field = false): string {
        if (e.strategy === 'accessibility id') return `$(${quote(e.selector)})`;
        if (e.strategy === 'id' && !this.crossPlatform) return `$(${quote(e.selector)})`;
        if (e.strategy === 'name') return `$(${quote(e.selector)})`;
        return field ? `this.byField(${quote(e.label)})` : `this.byText(${quote(e.label)})`;
    }

    screen(name: string): ScreenDraft {
        const base = name.replace(/\s*(page|screen)$/i, '').trim() || 'Home';
        const className = `${pascal(HOME_WORDS.test(base) ? 'Home' : base)}Screen`;
        let draft = this.screens.get(className);
        if (!draft) {
            draft = {
                className,
                instance: camel(className),
                title: HOME_WORDS.test(base) ? 'Home' : capitalise(base),
                file: inTestRoot(this.config, `src/screens/${className}.ts`),
                getters: new Map(),
                methods: new Map(),
                usesUsers: false
            };
            this.screens.set(className, draft);
        }
        return draft;
    }

    private addGetter(screen: ScreenDraft, prop: string, getter: Getter): string {
        let name = prop || 'element';
        let i = 2;
        while (screen.getters.has(name) && screen.getters.get(name)!.expr !== getter.expr) name = `${prop}${i++}`;
        screen.getters.set(name, getter);
        return name;
    }

    private clickable(screen: ScreenDraft, name: string, role?: string): string {
        const seen = this.find(name, role ? [role] : CLICKABLE);
        const r = seen?.role ?? role ?? 'button';
        const label = seen?.label || name;
        const getter: Getter = seen ? { expr: this.seenExpr(seen) } : { expr: `this.byText(${quote(name)})`, note: GUESSED };
        return this.addGetter(screen, camel(label) + (SUFFIX[r] ?? 'Button'), getter);
    }

    private field(screen: ScreenDraft, name: string): string {
        const seen = this.find(name, FIELDS);
        const getter: Getter = seen ? { expr: this.seenExpr(seen, true) } : { expr: `this.byField(${quote(name)})`, note: GUESSED };
        return this.addGetter(screen, camel(seen?.label || name) + (seen?.role === 'combobox' ? 'Dropdown' : 'Field'), getter);
    }

    private loginScreen(): ScreenDraft {
        const login = this.screen('Login');
        if (!login.methods.has('login')) {
            const user = this.elements.find(e => FIELDS.includes(e.role) && !e.secure && /e-?mail|user ?name|login|phone/i.test(`${e.label} ${e.accessibilityId ?? ''} ${e.resourceId ?? ''}`));
            const pwd = this.elements.find(e => FIELDS.includes(e.role) && (e.secure || /pass ?word/i.test(`${e.label} ${e.accessibilityId ?? ''} ${e.resourceId ?? ''}`)));
            const submit = this.elements.find(e => e.role === 'button' && /sign ?in|log ?in|continue|submit/i.test(`${e.label} ${e.accessibilityId ?? ''}`));
            const userProp = user ? this.field(login, user.label) : this.addGetter(login, 'emailField', { expr: `this.byField('Email')`, note: GUESSED });
            const pwdProp = pwd ? this.addGetter(login, 'passwordField', { expr: this.seenExpr(pwd, true) }) : this.addGetter(login, 'passwordField', { expr: `this.byField('Password')`, note: GUESSED });
            const submitProp = submit ? this.clickable(login, submit.label, 'button') : this.addGetter(login, 'signInButton', { expr: `this.byText('Sign in')`, note: GUESSED });
            login.anchor ??= { expr: `this.${pwdProp}` };
            login.methods.set(
                'login',
                `    /** Signs in with the given credentials. */
    async login(username: string, password: string): Promise<void> {
        await this.type(this.${userProp}, username);
        await this.type(this.${pwdProp}, password);
        await this.tap(this.${submitProp});
    }`
            );
            login.methods.set(
                'loginAs',
                `    /** Waits for the login screen and signs in as a role from test-data/users.json (credentials come from .env). */
    async loginAs(role = 'standard'): Promise<void> {
        const user = testUser(role);
        await this.waitForScreen();
        await this.login(user.username, user.password);
    }`
            );
            login.usesUsers = true;
        }
        return login;
    }

    /** A screen whose anchor is its title text, for "the Products screen is displayed". */
    private titledScreen(name: string): ScreenDraft {
        const screen = this.screen(name);
        if (!screen.anchor && screen.className !== 'HomeScreen') {
            const n = name.toLowerCase();
            const seen = this.elements.find(e => (e.role === 'heading' || e.role === 'text') && e.count === 1 && e.label.toLowerCase().includes(n));
            screen.anchor = seen ? { expr: this.seenExpr(seen) } : { expr: `this.byText(${quote(capitalise(name))})`, note: GUESSED };
        }
        return screen;
    }

    private value(v: ValueSource, ctx: SpecContext, field: string): string {
        if (v.kind === 'literal') return quote(v.value);
        if (v.kind === 'env') {
            ctx.imports.add('requireEnv');
            return `requireEnv(${quote(v.name)})`;
        }
        ctx.todos.push(`choose the ${field} value`);
        return `'' /* TODO(testpilot): ${comment(v.hint)} */`;
    }

    private use(ctx: SpecContext, screen: ScreenDraft): string {
        ctx.screens.add(screen);
        return screen.instance;
    }

    private todo(ctx: SpecContext, text: string, why?: string): string[] {
        ctx.todos.push(text);
        return [`// TODO(testpilot): ${comment(text)}${why ? ` (${why})` : ''}`];
    }

    private action(intent: ActionIntent, ctx: SpecContext): string[] {
        const s = ctx.current;
        switch (intent.kind) {
            case 'open': {
                if (intent.path) return this.todo(ctx, `open ${intent.path}`, 'apps have no URLs; navigate there through the app or a deep link');
                if (!intent.target || HOME_WORDS.test(intent.target)) return ['// The app opens when the session starts (see wdio.conf.ts).'];
                const target = this.titledScreen(intent.target);
                ctx.current = target;
                return [`await ${this.use(ctx, target)}.waitForScreen();`];
            }
            case 'login': {
                const login = this.loginScreen();
                return [`await ${this.use(ctx, login)}.loginAs(${quote(intent.role)});`];
            }
            case 'logout': {
                const prop = this.clickable(s, 'Log out');
                const v = this.use(ctx, s);
                return [`await ${v}.tap(${v}.${prop});`];
            }
            case 'fill': {
                const prop = this.field(s, intent.field);
                const v = this.use(ctx, s);
                return [`await ${v}.type(${v}.${prop}, ${this.value(intent.value, ctx, intent.field)});`];
            }
            case 'clear': {
                const prop = this.field(s, intent.field);
                const v = this.use(ctx, s);
                return [`await ${v}.clear(${v}.${prop});`];
            }
            case 'select': {
                const seen = this.find(intent.field, ['combobox']);
                const prop = this.addGetter(s, `${camel(seen?.label || intent.field)}Dropdown`, seen ? { expr: this.seenExpr(seen) } : { expr: `this.byField(${quote(intent.field)})`, note: GUESSED });
                const v = this.use(ctx, s);
                return [`await ${v}.choose(${v}.${prop}, ${quote(intent.option)});`];
            }
            case 'check': {
                const seen = this.find(intent.name, ['checkbox', 'switch', 'radio']);
                const prop = this.addGetter(s, `${camel(seen?.label || intent.name)}${seen?.role === 'switch' ? 'Switch' : 'Checkbox'}`, seen ? { expr: this.seenExpr(seen) } : { expr: `this.byText(${quote(intent.name)})`, note: GUESSED });
                const v = this.use(ctx, s);
                return [`await ${v}.setChecked(${v}.${prop}, ${intent.checked});`];
            }
            case 'click': {
                const v = this.use(ctx, s);
                if (intent.within) {
                    const method = `${camel(intent.name)}${SUFFIX[intent.role ?? 'button'] ?? 'Button'}For`;
                    if (!s.methods.has(method)) {
                        s.methods.set(
                            method,
                            `    /** The "${comment(intent.name)}" ${intent.role ?? 'button'} in the list item or card that shows \`text\`. */
    ${method}(text: string) {
        return this.inItem(text, ${quote(intent.name)});
    }`
                        );
                    }
                    return [`await ${v}.tap(${v}.${method}(${quote(intent.within)}));`];
                }
                const prop = this.clickable(s, intent.name, intent.role === 'option' ? undefined : intent.role);
                return [`await ${v}.tap(${v}.${prop});`];
            }
            case 'press': {
                const key = KEYS[intent.key];
                if (!key) return this.todo(ctx, `press ${intent.key}`);
                ctx.imports.add('driver');
                ctx.imports.add('Key');
                return [`await driver.keys([Key.${key}]);`];
            }
            case 'hover': {
                if (!this.desktop) return this.todo(ctx, `hover over ${intent.name}`, 'touch screens have no hover; use a long press if the app has one');
                const prop = this.clickable(s, intent.name);
                const v = this.use(ctx, s);
                return [`await ${v}.${prop}.moveTo();`];
            }
            case 'search': {
                const seen = this.elements.find(e => e.role === 'searchbox' && e.count === 1) ?? this.find('search', FIELDS);
                const prop = this.addGetter(s, 'searchField', seen ? { expr: this.seenExpr(seen, true) } : { expr: `this.byField('Search')`, note: GUESSED });
                const v = this.use(ctx, s);
                ctx.imports.add('driver');
                ctx.imports.add('Key');
                return [`await ${v}.type(${v}.${prop}, ${quote(intent.text)});`, 'await driver.keys([Key.Enter]);'];
            }
            case 'reload':
                return this.todo(ctx, 'refresh the screen', 'apps have no reload; pull to refresh or reopen the screen');
            case 'back': {
                if (this.desktop) {
                    // Desktop apps have no system Back: use the app's own Back button.
                    const prop = this.clickable(s, 'Back');
                    const v = this.use(ctx, s);
                    return [`await ${v}.tap(${v}.${prop});`];
                }
                ctx.imports.add('driver');
                return ['await driver.back();'];
            }
            case 'wait':
                return ['// No fixed wait: the next step or assertion waits for its own condition.'];
            case 'unknown':
                return this.todo(ctx, intent.text);
        }
    }

    private check(intent: CheckIntent, ctx: SpecContext): string[] {
        const s = ctx.current;
        switch (intent.kind) {
            case 'text':
            case 'title': {
                const v = this.use(ctx, s);
                const visible = intent.kind === 'title' || intent.visible;
                return [`await expect(${v}.byText(${quote(intent.text)})).${visible ? 'toBeDisplayed' : 'not.toBeDisplayed'}();`];
            }
            case 'heading': {
                const target = HOME_WORDS.test(intent.name) ? this.screen('Home') : this.titledScreen(intent.name);
                ctx.current = target;
                return [`await ${this.use(ctx, target)}.waitForScreen();`];
            }
            case 'url':
                return this.todo(ctx, `check that the screen shows ${intent.part}`, 'apps have no URL to check');
            case 'count': {
                const want = slug(intent.name).split('-');
                const seen = this.elements.find(e => e.count === 1 && (e.accessibilityId || e.resourceId) && want.every(w => `${e.accessibilityId ?? ''} ${e.resourceId ?? ''} ${e.label}`.toLowerCase().includes(w)) && /count|badge|total|qty|quantity/i.test(`${e.accessibilityId ?? ''} ${e.resourceId ?? ''}`));
                if (!seen) return this.todo(ctx, `check that the ${intent.name} shows ${intent.value}`, 'no element with that name was found during exploration');
                const prop = this.addGetter(s, `${camel(intent.name)}Count`, { expr: this.seenExpr(seen) });
                const v = this.use(ctx, s);
                return [`await expect(${v}.${prop}).toHaveText(${quote(intent.value)});`];
            }
            case 'state': {
                const prop = intent.role === 'field' ? this.field(s, intent.name) : this.clickable(s, intent.name, intent.role === 'link' || intent.role === 'checkbox' || intent.role === 'button' ? intent.role : undefined);
                const v = this.use(ctx, s);
                switch (intent.state) {
                    case 'checked':
                    case 'unchecked':
                        return [`await expect(await ${v}.isChecked(${v}.${prop})).toBe(${intent.state === 'checked'});`];
                    case 'hidden':
                        return [`await expect(${v}.${prop}).not.toBeDisplayed();`];
                    case 'visible':
                        return [`await expect(${v}.${prop}).toBeDisplayed();`];
                    default:
                        return [`await expect(${v}.${prop}).${intent.state === 'enabled' ? 'toBeEnabled' : 'toBeDisabled'}();`];
                }
            }
            case 'unknown':
                return this.todo(ctx, `check that ${intent.text}`);
        }
    }

    /** Builds the spec for one case and records what it needs in screen objects. */
    spec(tc: TestCase): { file: string; content: string; todos: number; screens: ScreenDraft[] } {
        const area = tc.area ?? 'General';
        const start = this.screen(/^(general|home|smoke)$/i.test(area) ? 'Home' : area);
        const ctx: SpecContext = { current: start, screens: new Set(), imports: new Set(), todos: [] };
        const body: string[] = [];
        for (const pre of tc.preconditions) {
            body.push(`// Precondition: ${comment(pre)}`);
            if (LOGGED_IN.test(pre) && !/not (logged|signed)/i.test(pre)) body.push(...this.action({ kind: 'login', role: /admin/i.test(pre) ? 'admin' : 'standard' }, ctx));
            else if (!SETUP_ONLY.test(pre)) body.push(...this.todo(ctx, `set up: ${pre}`, 'do it in the test, through the API or app state, not by hand'));
        }
        tc.steps.forEach((step, i) => {
            if (body.length) body.push('');
            body.push(`// Step ${i + 1}: ${comment(step.action)}${step.data ? ` (data: ${comment(step.data)})` : ''}`);
            if (VERIFY.test(normaliseStep(step.action))) body.push(...parseCheck(step.action).flatMap(c => this.check(c, ctx)));
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
        if (!tc.steps.length && !tc.expected) body.push(...this.todo(ctx, 'write the steps', 'this case has no steps yet'));

        const file = inTestRoot(this.config, `test/specs/${slug(area)}/${slugId(tc.id)}.spec.ts`);
        const todos = ctx.todos.length;
        const tags = [`@${tc.id}`, ...(tc.area ? [`@${slug(tc.area)}`] : []), ...(tc.priority ? [`@${slug(tc.priority)}`] : []), ...tc.tags.map(t => `@${slug(t)}`)].filter((t, i, all) => all.indexOf(t) === i && t.length > 1);
        const title = `${tc.id} ${clean(tc.title).text.replace(/\s+/g, ' ').trim()} ${tags.join(' ')}`;
        const globals = [...(ctx.imports.has('driver') ? ['driver'] : []), ...(body.some(l => l.includes('expect(')) ? ['expect'] : [])];
        const screens = [...ctx.screens].sort((a, b) => a.className.localeCompare(b.className));
        const reason = `${todos} step(s) still need code: ${ctx.todos.slice(0, 3).map(comment).join('; ')}${todos > 3 ? '; …' : ''}`;
        const lines = [
            `// ${CREATED_HEADER}`,
            `// Generated from test case ${comment(tc.id)} (${comment(tc.source.type)}${tc.source.ref ? `: ${comment(tc.source.ref)}` : ''}).${todos ? ` ${todos} TODO(testpilot) item(s) to finish; the test stays pending until then.` : ''}`,
            ...(globals.length ? [`import { ${globals.join(', ')} } from '@wdio/globals';`] : []),
            ...(ctx.imports.has('Key') ? [`import { Key } from 'webdriverio';`] : []),
            ...(globals.length || ctx.imports.has('Key') ? [''] : []),
            ...screens.map(sc => `import { ${sc.instance} } from ${quote(relativeImport(file, sc.file.replace(/\.ts$/, '')))};`),
            ...(ctx.imports.has('requireEnv') ? [`import { requireEnv } from ${quote(relativeImport(file, inTestRoot(this.config, 'src/utils/env')))};`] : []),
            ...(todos ? [`import { pendingUntilDone } from ${quote(relativeImport(file, inTestRoot(this.config, 'src/utils/pending')))};`] : []),
            '',
            `describe(${quote(clean(area).text.replace(/\s+/g, ' ').trim() || 'General')}, () => {`,
            `    it(${quote(title)}, ${todos ? 'async function () {' : 'async () => {'}`,
            ...(todos ? [`        // Delete the next line once every TODO(testpilot) below has real code.`, `        pendingUntilDone(this, ${quote(reason)});`, ''] : []),
            ...body.map(l => (l ? `        ${l}` : '')),
            '    });',
            '});',
            ''
        ];
        return { file, content: lines.join('\n'), todos, screens };
    }

    /** Screen objects needed by the specs built so far. */
    supportFiles(used: Set<ScreenDraft>): { files: PlannedFile[]; notes: string[] } {
        const files: PlannedFile[] = [];
        const notes: string[] = [];
        for (const screen of this.screens.values()) {
            if (!used.has(screen) && !screen.getters.size && !screen.methods.size) continue;
            files.push(this.screenFile(screen, notes));
        }
        // The scaffold creates the users helper; recreate it only if it was deleted.
        if ([...this.screens.values()].some(s => s.usesUsers)) files.push(compareWithDisk(this.store, inTestRoot(this.config, 'src/utils/users.ts'), renderTemplate('appium-ts', 'src/utils/users.ts.hbs', renderContext(this.config)), true));
        return { files, notes };
    }

    private getterBlock(name: string, g: Getter): string {
        return `${g.note ? `    /** ${g.note} */\n` : ''}    get ${name}() {\n        return ${g.expr};\n    }`;
    }

    private screenFile(screen: ScreenDraft, notes: string[]): PlannedFile {
        const current = this.store.read(screen.file);
        const getterBlocks = [...screen.getters.entries()].map(([name, g]) => this.getterBlock(name, g));
        const methodBlocks = [...screen.methods.values()];
        if (current === undefined) {
            const anchor = screen.anchor ?? (screen.getters.size ? { expr: `this.${[...screen.getters.keys()][0]}` } : { expr: `this.byText(${quote(screen.title)})`, note: GUESSED });
            const usesDollar = [...getterBlocks, anchor.expr].some(b => b.includes('$('));
            const content = [
                `// ${CREATED_HEADER}`,
                ...(usesDollar ? [`import { $ } from '@wdio/globals';`, ''] : []),
                `import { BaseScreen } from './BaseScreen';`,
                ...(screen.usesUsers ? [`import { testUser } from '../utils/users';`] : []),
                '',
                `/** Screen object for ${comment(screen.title)}. TestPilot adds getters and actions above the markers when it generates new tests. */`,
                `export class ${screen.className} extends BaseScreen {`,
                ...(anchor.note ? [`    /** What waitForScreen() waits for. ${anchor.note} */`] : [`    /** What waitForScreen() waits for: an element only this screen shows. */`]),
                `    protected get anchor() {`,
                `        return ${anchor.expr};`,
                `    }`,
                '',
                ...(getterBlocks.length ? [getterBlocks.join('\n\n')] : []),
                '    // testpilot:locators',
                ...(methodBlocks.length ? ['', methodBlocks.join('\n\n')] : []),
                '    // testpilot:actions',
                '}',
                '',
                `export const ${screen.instance} = new ${screen.className}();`,
                ''
            ].join('\n');
            return { path: screen.file, status: 'new', content };
        }
        // Existing screen: add only what is missing, above the markers.
        const missingGetters = [...screen.getters.entries()].filter(([name]) => !new RegExp(`\\bget ${name}\\s*\\(`).test(current)).map(([name, g]) => this.getterBlock(name, g));
        const missingMethods = [...screen.methods.entries()].filter(([name]) => !new RegExp(`\\b${name}\\s*\\(`).test(current)).map(([, block]) => block);
        const needsInstance = !new RegExp(`export const ${screen.instance}\\b`).test(current);
        if (!missingGetters.length && !missingMethods.length && !needsInstance) return { path: screen.file, status: 'unchanged', content: current };
        if ((missingGetters.length && !current.includes('// testpilot:locators')) || (missingMethods.length && !current.includes('// testpilot:actions'))) {
            notes.push(`${screen.file} has no TestPilot markers, so it was left alone. Add these members yourself:\n${[...missingGetters, ...missingMethods].join('\n')}`);
            return { path: screen.file, status: 'skip', content: current, note: 'No // testpilot: markers; add the listed members by hand.' };
        }
        let content = current;
        if (missingGetters.length) content = content.replace(/^([ \t]*)\/\/ testpilot:locators/m, `${missingGetters.join('\n\n')}\n$1// testpilot:locators`);
        if (missingMethods.length) content = content.replace(/^([ \t]*)\/\/ testpilot:actions/m, `\n${missingMethods.join('\n\n')}\n$1// testpilot:actions`);
        if (screen.usesUsers && !content.includes('testUser')) content = content.replace(/(import \{ BaseScreen \} from '\.\/BaseScreen';)/, `$1\nimport { testUser } from '../utils/users';`);
        if (missingGetters.some(g => g.includes('$(')) && !/import \{[^}]*\$[^}]*\} from '@wdio\/globals'/.test(content)) {
            content = content.replace(/^(\/\/[^\n]*\n)?/, m => `${m}import { $ } from '@wdio/globals';\n`);
        }
        if (needsInstance && new RegExp(`export class ${screen.className}\\b`).test(content)) content = `${content.replace(/\s*$/, '\n')}\nexport const ${screen.instance} = new ${screen.className}();\n`;
        const added = missingGetters.length + missingMethods.length;
        return { path: screen.file, status: 'merge', content, note: `Adds ${added} member(s) above the TestPilot markers${needsInstance ? ` and exports ${screen.instance}` : ''}.` };
    }
}

/** Plans every file for a batch of cases. Cases containing text written as instructions to an AI are left for a person. */
export function planAppiumTests(store: ProjectStore, config: Config, cases: TestCase[], exploration: ExploredScreen[]): GenerationPlan {
    const gen = new AppiumGenerator(store, config, exploration);
    const specs: PlannedFile[] = [];
    const out: GeneratedCase[] = [];
    const used = new Set<ScreenDraft>();
    for (const tc of cases) {
        const text = [tc.title, ...tc.preconditions, ...tc.steps.flatMap(s => [s.action, s.data ?? '', s.expected ?? '']), tc.expected ?? ''].join('\n');
        if (clean(text).suspicious) {
            out.push({ id: tc.id, spec: '', todos: 0, skipped: 'Contains text written as instructions to an AI. A person should check the case first.' });
            continue;
        }
        const spec = gen.spec(tc);
        for (const sc of spec.screens) used.add(sc);
        specs.push(compareWithDisk(store, spec.file, spec.content));
        out.push({ id: tc.id, spec: spec.file, todos: spec.todos });
    }
    const support = gen.supportFiles(used);
    return { files: [...support.files, ...specs], cases: out, pageObjects: support.files.filter(f => f.path.includes('src/screens/')).map(f => f.path), notes: support.notes };
}
