import path from 'node:path';

import type { Config, TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import type { ExploredElement, ExploredPage } from '../explore/web.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot, javaPackageFor, type PlannedFile } from '../scaffold/engine.js';
import { clean } from '../testcases/normalize.js';
import { type ActionIntent, type CheckIntent, normaliseStep, parseAction, parseCheck, type ValueSource } from './intents.js';
import { camel, cucumberExpression, type GeneratedCase, type GenerationPlan, pascal, type Segment, slug, stepText } from './playwright.js';

/**
 * Generates Selenium 4 + Java tests (TestNG, Page Object Model) from test cases, the same way the
 * Playwright generator does: one test class per case tagged with its id, one page object per area
 * or page with `By` locators built from what exploration saw, TODO(testpilot) for anything it cannot
 * translate (the test is skipped until finished). With the BDD pattern each case becomes a Cucumber
 * scenario under src/test/resources/features and the code lands in GeneratedSteps.java.
 */

interface PageDraft {
    className: string;
    varName: string;
    file: string;
    path: string;
    pathKnown: boolean;
    locators: Map<string, string>;
    methods: Map<string, string>;
    usesUsers: boolean;
}

interface StepDef {
    keyword: Segment['keyword'];
    text: string;
    lines: string[];
    pages: Set<string>;
    usesDriver: boolean;
    usesExpect: boolean;
    usesEnv: boolean;
    usesKeys: boolean;
}

interface Ctx {
    current: PageDraft;
    pages: Set<string>;
    todos: string[];
    usesDriver: boolean;
    usesExpect: boolean;
    usesEnv: boolean;
    usesKeys: boolean;
}

const HOME_WORDS = /^(home|homepage|application|app|site|website|web ?site|url|browser|portal|landing|start|main|base url|the application)$/i;
const SETUP_ONLY = /\b(browser is (open|launched|running)|application is (open|running|launched|installed|available)|app is installed|internet|network connection|test environment is (up|available)|user has access to the (app|application|site))\b/i;
const LOGGED_IN = /\b(user is |already |is )?(logged|signed) ?in\b/i;
const VERIFY = /^(verify|check that|check if|ensure|confirm|validate|assert|observe|see that|should|expect)\b/i;
const ROLE_SUFFIX: Record<string, string> = { button: 'Button', link: 'Link', textbox: 'Field', searchbox: 'Field', combobox: 'Dropdown', listbox: 'List', checkbox: 'Checkbox', radio: 'Option', option: 'Option', tab: 'Tab', menuitem: 'MenuItem', switch: 'Switch', heading: 'Heading', spinbutton: 'Field', slider: 'Slider' };
const KEYS: Record<string, string> = { Enter: 'ENTER', Tab: 'TAB', Escape: 'ESCAPE', Space: 'SPACE', Backspace: 'BACK_SPACE', Delete: 'DELETE', ArrowUp: 'ARROW_UP', ArrowDown: 'ARROW_DOWN', ArrowLeft: 'ARROW_LEFT', ArrowRight: 'ARROW_RIGHT' };

/** A Java string literal for any text. */
export function jstr(s: string): string {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

function comment(s: string): string {
    return clean(s).text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').slice(0, 200);
}

/** A Java identifier from free text (class names start upper, members lower). */
function javaName(s: string, upper: boolean): string {
    const base = (upper ? pascal(s) : camel(s)).replace(/[^A-Za-z0-9_]/g, '');
    const safe = /^[0-9]/.test(base) ? `_${base}` : base || (upper ? 'Generated' : 'step');
    return RESERVED.has(safe) ? `${safe}_` : safe;
}

const RESERVED = new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'record', 'var', 'yield']);

export class SeleniumGenerator {
    private readonly pages = new Map<string, PageDraft>();
    private readonly elements: Array<ExploredElement & { page: ExploredPage }>;
    private readonly stepDefs = new Map<string, StepDef>();
    private readonly duplicateSteps: string[] = [];
    readonly bdd: boolean;
    readonly pkg: string;
    private readonly mainDir: string;
    private readonly testDir: string;

    constructor(
        private readonly store: ProjectStore,
        private readonly config: Config,
        private readonly exploration: ExploredPage[]
    ) {
        this.bdd = config.stack.pattern === 'bdd';
        this.pkg = javaPackageFor(config);
        const pkgPath = this.pkg.replace(/\./g, '/');
        this.mainDir = inTestRoot(config, `src/main/java/${pkgPath}`);
        this.testDir = inTestRoot(config, `src/test/java/${pkgPath}`);
        this.elements = exploration.flatMap(p => p.elements.map(e => ({ ...e, page: p })));
    }

    private find(name: string, roles: string[]): (ExploredElement & { page: ExploredPage }) | undefined {
        const n = name.toLowerCase();
        const candidates = this.elements.filter(e => roles.includes(e.role));
        return candidates.find(e => e.name.toLowerCase() === n) ?? candidates.find(e => e.name.toLowerCase().includes(n) && n.length >= 3) ?? candidates.find(e => n.includes(e.name.toLowerCase()) && e.name.length >= 3);
    }

    private explorePathFor(name: string): string | undefined {
        const n = name.toLowerCase();
        return this.exploration.find(p => !p.error && (p.title.toLowerCase().includes(n) || p.headings.some(h => h.toLowerCase().includes(n)) || p.path.toLowerCase().includes(slug(n))))?.path;
    }

    pageObject(name: string): PageDraft {
        const className = `${javaName(name.replace(/\s*page$/i, ''), true)}Page`;
        let draft = this.pages.get(className);
        if (!draft) {
            const explored = this.explorePathFor(name);
            draft = {
                className,
                varName: javaName(className, false),
                file: `${this.mainDir}/pages/${className}.java`,
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

    private addLocator(po: PageDraft, prop: string, expr: string): string {
        let name = javaName(prop, false);
        let i = 2;
        while (po.locators.has(name) && po.locators.get(name) !== expr) name = `${javaName(prop, false)}${i++}`;
        po.locators.set(name, expr);
        return name;
    }

    private clickable(po: PageDraft, name: string, role?: string): string {
        const roles = role ? [role] : ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch'];
        const seen = this.find(name, roles);
        const r = seen?.role ?? role ?? 'button';
        const label = seen?.name ?? name;
        const expr = seen || role ? `byRole(${jstr(r)}, ${jstr(label)})` : `By.xpath(byRole("button", ${jstr(label)}).toString().replaceFirst("^By.xpath: ", "") + " | " + byRole("link", ${jstr(label)}).toString().replaceFirst("^By.xpath: ", ""))`;
        return this.addLocator(po, `${label} ${ROLE_SUFFIX[r] ?? 'Button'}`, expr);
    }

    private field(po: PageDraft, name: string): string {
        const seen = this.find(name, ['textbox', 'searchbox', 'combobox', 'spinbutton']);
        return this.addLocator(po, `${seen?.name ?? name} ${seen?.role === 'combobox' ? 'Dropdown' : 'Field'}`, `byLabel(${jstr(seen?.name ?? name)})`);
    }

    private loginPage(): PageDraft {
        const po = this.pageObject('Login');
        const pwd = this.elements.find(e => e.role === 'textbox' && /pass ?word/i.test(e.name));
        if (pwd && !po.pathKnown) {
            po.path = pwd.page.path;
            po.pathKnown = true;
        }
        if (!po.methods.has('login')) {
            const user = this.elements.find(e => e.role === 'textbox' && /e-?mail|user ?name|login/i.test(e.name));
            const submit = this.elements.find(e => e.role === 'button' && /sign ?in|log ?in|continue|submit/i.test(e.name));
            const userProp = user ? this.field(po, user.name) : this.addLocator(po, 'usernameField', `By.xpath("//input[@type='email' or @name='email' or @name='username' or @id='email' or @id='username' or contains(translate(@placeholder,'EMAIL','email'),'email')]")`);
            const pwdProp = pwd ? this.field(po, pwd.name) : this.addLocator(po, 'passwordField', `By.cssSelector("input[type='password']")`);
            const submitProp = submit ? this.clickable(po, submit.name, 'button') : this.addLocator(po, 'signInButton', `By.xpath("//button[@type='submit'] | //input[@type='submit'] | //button[contains(normalize-space(.), 'Sign in') or contains(normalize-space(.), 'Log in') or contains(normalize-space(.), 'Login')]")`);
            po.methods.set(
                'login',
                `    public void login(String username, String password) {
        type(${userProp}, username);
        type(${pwdProp}, password);
        click(${submitProp});
    }`
            );
            po.methods.set(
                'loginAs',
                `    /** Opens the login page and signs in as a role from test-data/users.json (credentials come from .env). */
    public void loginAs(String role) {
        TestUsers.User user = TestUsers.forRole(role);
        open();
        login(user.username(), user.password());
    }`
            );
            po.usesUsers = true;
        }
        return po;
    }

    private value(v: ValueSource, ctx: Ctx, field: string): string {
        if (v.kind === 'literal') return jstr(v.value);
        if (v.kind === 'env') {
            ctx.usesEnv = true;
            return `Env.require(${jstr(v.name)})`;
        }
        ctx.todos.push(`choose the ${field} value`);
        return `"" /* TODO(testpilot): ${comment(v.hint)} */`;
    }

    private use(ctx: Ctx, po: PageDraft): string {
        ctx.pages.add(po.className);
        return po.varName;
    }

    private action(intent: ActionIntent, ctx: Ctx): string[] {
        const po = ctx.current;
        switch (intent.kind) {
            case 'open': {
                if (intent.path) {
                    ctx.usesDriver = true;
                    ctx.usesEnv = true;
                    return [`driver.get(Env.require("APP_BASE_URL").replaceAll("/+$", "") + ${jstr(intent.path.replace(/^https?:\/\/[^/]+/i, '') || '/')});`];
                }
                if (!intent.target || HOME_WORDS.test(intent.target)) {
                    const home = this.pageObject('Home');
                    return [`${this.use(ctx, home)}.open();`];
                }
                const target = this.pageObject(intent.target);
                ctx.current = target;
                return [`${this.use(ctx, target)}.open();`];
            }
            case 'login':
                return [`${this.use(ctx, this.loginPage())}.loginAs(${jstr(intent.role)});`];
            case 'logout': {
                const prop = this.clickable(po, 'Log out');
                return [`${this.use(ctx, po)}.click(${po.varName}.${prop});`];
            }
            case 'fill': {
                const prop = this.field(po, intent.field);
                return [`${this.use(ctx, po)}.type(${po.varName}.${prop}, ${this.value(intent.value, ctx, intent.field)});`];
            }
            case 'clear': {
                const prop = this.field(po, intent.field);
                return [`${this.use(ctx, po)}.clear(${po.varName}.${prop});`];
            }
            case 'select': {
                const seen = this.find(intent.field, ['combobox', 'listbox']);
                const prop = this.addLocator(po, `${seen?.name ?? intent.field} Dropdown`, `byLabel(${jstr(seen?.name ?? intent.field)})`);
                return [`${this.use(ctx, po)}.select(${po.varName}.${prop}, ${jstr(intent.option)});`];
            }
            case 'check': {
                const seen = this.find(intent.name, ['checkbox', 'switch', 'radio']);
                const prop = this.addLocator(po, `${seen?.name ?? intent.name} Checkbox`, `byRole(${jstr(seen?.role ?? 'checkbox')}, ${jstr(seen?.name ?? intent.name)})`);
                return [`${this.use(ctx, po)}.setChecked(${po.varName}.${prop}, ${intent.checked});`];
            }
            case 'click': {
                if (intent.within) {
                    const method = javaName(`${intent.name} ${ROLE_SUFFIX[intent.role ?? 'button'] ?? 'Button'} For`, false);
                    if (!po.methods.has(method)) {
                        const seen = this.find(intent.name, intent.role ? [intent.role] : ['button', 'link']);
                        po.methods.set(
                            method,
                            `    /** The "${comment(intent.name)}" ${seen?.role ?? intent.role ?? 'button'} inside the list item, row or card that contains {@code text}. */
    public By ${method}(String text) {
        return within(text, byRole(${jstr(seen?.role ?? intent.role ?? 'button')}, ${jstr(seen?.name ?? intent.name)}));
    }`
                        );
                    }
                    return [`${this.use(ctx, po)}.click(${po.varName}.${method}(${jstr(intent.within)}));`];
                }
                const prop = this.clickable(po, intent.name, intent.role);
                return [`${this.use(ctx, po)}.click(${po.varName}.${prop});`];
            }
            case 'press': {
                ctx.usesKeys = true;
                return [`${this.use(ctx, po)}.press(Keys.${KEYS[intent.key] ?? intent.key.toUpperCase()});`];
            }
            case 'hover': {
                const prop = this.clickable(po, intent.name);
                return [`${this.use(ctx, po)}.hover(${po.varName}.${prop});`];
            }
            case 'search': {
                const prop = this.addLocator(po, 'searchField', `By.cssSelector("input[type='search'], [role='searchbox'], input[placeholder*='earch'], input[name*='search'], input[name='q']")`);
                ctx.usesKeys = true;
                return [`${this.use(ctx, po)}.type(${po.varName}.${prop}, ${jstr(intent.text)});`, `${po.varName}.press(Keys.ENTER);`];
            }
            case 'reload':
                ctx.usesDriver = true;
                return ['driver.navigate().refresh();'];
            case 'back':
                ctx.usesDriver = true;
                return ['driver.navigate().back();'];
            case 'wait':
                return ['// No fixed wait: the next step or expectation waits for its own condition.'];
            case 'unknown':
                ctx.todos.push(intent.text);
                return [`// TODO(testpilot): ${comment(intent.text)}`];
        }
    }

    private check(intent: CheckIntent, ctx: Ctx): string[] {
        ctx.usesExpect = true;
        switch (intent.kind) {
            case 'text':
                return [`expect.${intent.visible ? 'text' : 'noText'}(${jstr(intent.text)});`];
            case 'heading': {
                if (HOME_WORDS.test(intent.name)) return [`expect.urlContains("/");`];
                const seen = this.elements.find(e => e.role === 'heading' && e.name.toLowerCase().includes(intent.name.toLowerCase()));
                return [`expect.heading(${jstr(seen?.name ?? intent.name)});`];
            }
            case 'title':
                return [intent.exact ? `expect.title(${jstr(intent.text)});` : `expect.titleContains(${jstr(intent.text)});`];
            case 'url':
                return [`expect.urlContains(${jstr(intent.part)});`];
            case 'count': {
                const want = slug(intent.name).split('-');
                const testId = this.exploration.flatMap(p => p.testIds).find(t => want.every(w => t.value.toLowerCase().includes(w)) || (want.length && t.value.toLowerCase().includes(want[0]) && /count|badge|total|qty|quantity/.test(t.value)));
                if (testId) return [`expect.textOf(BasePage.byTestId(${jstr(testId.value)}), ${jstr(intent.value)}, ${jstr(intent.name)});`];
                ctx.usesExpect = false;
                ctx.todos.push(`check that the ${intent.name} shows ${intent.value}`);
                return [`// TODO(testpilot): check that the ${comment(intent.name)} shows ${comment(intent.value)} (no element with that name was found during exploration)`];
            }
            case 'state': {
                const po = ctx.current;
                const prop = intent.role === 'field' ? this.field(po, intent.name) : this.clickable(po, intent.name, intent.role === 'link' || intent.role === 'checkbox' ? intent.role : intent.role === 'button' ? 'button' : undefined);
                const what = jstr(intent.name);
                const target = `${this.use(ctx, po)}.${prop}`;
                switch (intent.state) {
                    case 'visible':
                        return [`expect.visible(${target}, ${what});`];
                    case 'hidden':
                        return [`expect.hidden(${target}, ${what});`];
                    case 'enabled':
                    case 'disabled':
                        return [`expect.enabled(${target}, ${intent.state === 'enabled'}, ${what});`];
                    default:
                        return [`expect.checked(${target}, ${intent.state === 'checked'}, ${what});`];
                }
            }
            case 'unknown':
                ctx.usesExpect = false;
                ctx.todos.push(`check: ${intent.text}`);
                return [`// TODO(testpilot): check that ${comment(intent.text)}`];
        }
    }

    segments(tc: TestCase, ctx: Ctx): Segment[] {
        const out: Segment[] = [];
        for (const pre of tc.preconditions) {
            const lines = [`// Precondition: ${comment(pre)}`];
            if (LOGGED_IN.test(pre) && !/not (logged|signed)/i.test(pre)) lines.push(...this.action({ kind: 'login', role: /admin/i.test(pre) ? 'admin' : 'standard' }, ctx));
            else if (!SETUP_ONLY.test(pre)) {
                ctx.todos.push(`set up: ${pre}`);
                lines.push('// TODO(testpilot): set this up in the test (through the API or test data), not by hand.');
            }
            out.push({ keyword: 'Given', text: stepText(pre), lines });
        }
        tc.steps.forEach((step, i) => {
            const lines = [`// Step ${i + 1}: ${comment(step.action)}${step.data ? ` (data: ${comment(step.data)})` : ''}`];
            const isCheck = VERIFY.test(normaliseStep(step.action));
            if (isCheck) lines.push(...parseCheck(step.action).flatMap(c => this.check(c, ctx)));
            else lines.push(...parseAction(step.action, step.data ?? tc.testData).flatMap(a => this.action(a, ctx)));
            out.push({ keyword: isCheck ? 'Then' : 'When', text: stepText(step.action), lines });
            if (step.expected) out.push({ keyword: 'Then', text: stepText(step.expected), lines: [`// Expected: ${comment(step.expected)}`, ...parseCheck(step.expected).flatMap(c => this.check(c, ctx))] });
        });
        if (tc.expected) {
            for (const line of tc.expected.split(/\n+/).filter(Boolean)) out.push({ keyword: 'Then', text: stepText(line), lines: [`// Expected: ${comment(line)}`, ...parseCheck(line).flatMap(c => this.check(c, ctx))] });
        }
        if (!tc.steps.length && !tc.expected) {
            ctx.todos.push('write the steps');
            out.push({ keyword: 'When', text: 'the steps are written', lines: ['// TODO(testpilot): this case has no steps yet.'] });
        }
        return out;
    }

    private newCtx(area: string): Ctx {
        return { current: this.pageObject(/^(general|home|smoke)$/i.test(area) ? 'Home' : area), pages: new Set(), todos: [], usesDriver: false, usesExpect: false, usesEnv: false, usesKeys: false };
    }

    /** The TestNG test class (or the feature file) for one case. */
    spec(tc: TestCase): { file: string; content: string; todos: number } {
        const area = tc.area ?? 'General';
        const ctx = this.newCtx(area);
        const title = `${tc.id} ${clean(tc.title).text.replace(/\s+/g, ' ')}`;
        const groups = [tc.id, ...(tc.area ? [slug(tc.area)] : []), ...(tc.priority ? [tc.priority.toLowerCase()] : []), ...tc.tags.map(t => slug(t))].filter((t, i, all) => all.indexOf(t) === i && t.length > 1);
        if (this.bdd) return this.feature(tc, area, title, groups, ctx);

        const body: string[] = [];
        for (const seg of this.segments(tc, ctx)) {
            if (body.length) body.push('');
            body.push(...seg.lines);
        }
        const todos = ctx.todos.length;
        const areaPkg = slug(area).replace(/[^a-z0-9]/g, '') || 'general';
        const className = `${tc.id.replace(/[^A-Za-z0-9]+/g, '_')}Test`;
        const file = `${this.testDir}/tests/${areaPkg}/${className}.java`;
        const pages = [...ctx.pages].sort();
        const imports = [
            ...(ctx.usesKeys ? ['import org.openqa.selenium.Keys;'] : []),
            'import org.testng.annotations.Test;',
            '',
            `import ${this.pkg}.BaseTest;`,
            ...(ctx.usesEnv ? [`import ${this.pkg}.config.Env;`] : []),
            ...(body.some(l => l.includes('BasePage.')) ? [`import ${this.pkg}.pages.BasePage;`] : []),
            ...pages.map(p => `import ${this.pkg}.pages.${p};`)
        ];
        const lines = [
            `// ${CREATED_HEADER}`,
            `// Generated from test case ${comment(tc.id)} (${comment(tc.source.type)}${tc.source.ref ? `: ${comment(tc.source.ref)}` : ''}).${todos ? ` ${todos} TODO(testpilot) item(s) to finish; the test is skipped until then.` : ''}`,
            `package ${this.pkg}.tests.${areaPkg};`,
            '',
            ...imports,
            '',
            `public class ${className} extends BaseTest {`,
            `    @Test(description = ${jstr(title)}, groups = {${groups.map(jstr).join(', ')}})`,
            `    public void ${javaName(clean(tc.title).text, false).slice(0, 60) || 'run'}() {`,
            ...(todos ? [`        skipUntilDone(${jstr(`${todos} TODO(testpilot) step(s) in this test`)});`] : []),
            ...pages.map(p => `        ${p} ${this.pages.get(p)!.varName} = new ${p}(driver);`),
            ...(pages.length ? [''] : []),
            ...body.map(l => (l ? `        ${l}` : '')),
            '    }',
            '}',
            ''
        ];
        return { file, content: lines.join('\n'), todos };
    }

    private feature(tc: TestCase, area: string, title: string, tags: string[], ctx: Ctx): { file: string; content: string; todos: number } {
        const steps: string[] = [];
        let last: Segment['keyword'] | undefined;
        for (const seg of this.segments(tc, ctx)) {
            const key = seg.text.toLowerCase();
            const existing = this.stepDefs.get(key);
            const pages = new Set([...ctx.pages].filter(p => seg.lines.some(l => l.includes(`${this.pages.get(p)!.varName}.`))));
            if (!existing) {
                this.stepDefs.set(key, {
                    keyword: seg.keyword,
                    text: seg.text,
                    lines: seg.lines,
                    pages,
                    usesDriver: seg.lines.some(l => /\bdriver\./.test(l)),
                    usesExpect: seg.lines.some(l => /\bexpect\./.test(l)),
                    usesEnv: seg.lines.some(l => /\bEnv\./.test(l)),
                    usesKeys: seg.lines.some(l => /\bKeys\./.test(l))
                });
            } else if (existing.lines.join('\n') !== seg.lines.join('\n')) this.duplicateSteps.push(`"${seg.text}" (${tc.id}) reuses the step definition first generated for another case; check it does the same thing there.`);
            steps.push(`    ${seg.keyword === last ? 'And' : seg.keyword} ${seg.text}`);
            last = seg.keyword;
        }
        const todos = ctx.todos.length;
        const file = inTestRoot(this.config, `src/test/resources/features/${slug(area)}/${tc.id.replace(/[^A-Za-z0-9._-]+/g, '_')}.feature`);
        const content = [
            `# ${CREATED_HEADER}`,
            `# Generated from test case ${comment(tc.id)} (${comment(tc.source.type)}${tc.source.ref ? `: ${comment(tc.source.ref)}` : ''}).${todos ? ` ${todos} TODO(testpilot) item(s) to finish in GeneratedSteps.java; the scenario is tagged @testpilot-todo (skipped) until then.` : ''}`,
            `Feature: ${clean(area).text.replace(/\s+/g, ' ')}`,
            '',
            `  ${[...tags.map(t => `@${t}`), ...(todos ? ['@testpilot-todo'] : [])].join(' ')}`,
            `  Scenario: ${title}`,
            ...steps,
            ''
        ].join('\n');
        return { file, content, todos };
    }

    private stepsFile(notes: string[]): PlannedFile | undefined {
        if (!this.stepDefs.size) return undefined;
        const file = `${this.testDir}/bdd/steps/GeneratedSteps.java`;
        const current = this.store.read(file);
        const defs = [...this.stepDefs.values()];
        const used = new Set<string>();
        const render = (d: StepDef) => {
            let name = javaName(d.text, false).slice(0, 50) || 'step';
            let i = 2;
            while (used.has(name) || (current && new RegExp(`\\b${name}\\s*\\(`).test(current))) name = `${javaName(d.text, false).slice(0, 50)}${i++}`;
            used.add(name);
            const locals = [
                ...[...d.pages].sort().map(p => `        ${p} ${this.pages.get(p)!.varName} = context.page(${p}.class);`),
                ...(d.usesDriver ? ['        WebDriver driver = context.driver();'] : []),
                ...(d.usesExpect ? ['        Expect expect = context.expect();'] : [])
            ];
            return [`    @${d.keyword}(${jstr(cucumberExpression(d.text))})`, `    public void ${name}() {`, ...locals, ...d.lines.map(l => (l ? `        ${l}` : '')), '    }'].join('\n');
        };
        const allPages = [...new Set(defs.flatMap(d => [...d.pages]))].sort();
        const imports = [
            ...(defs.some(d => d.usesDriver) ? ['import org.openqa.selenium.WebDriver;'] : []),
            ...(defs.some(d => d.usesKeys) ? ['import org.openqa.selenium.Keys;'] : []),
            '',
            'import io.cucumber.java.en.Given;',
            'import io.cucumber.java.en.Then;',
            'import io.cucumber.java.en.When;',
            '',
            ...(defs.some(d => d.usesExpect) ? [`import ${this.pkg}.Expect;`] : []),
            `import ${this.pkg}.bdd.TestContext;`,
            ...(defs.some(d => d.usesEnv) ? [`import ${this.pkg}.config.Env;`] : []),
            ...(defs.some(d => d.lines.some(l => l.includes('BasePage.'))) ? [`import ${this.pkg}.pages.BasePage;`] : []),
            ...allPages.map(p => `import ${this.pkg}.pages.${p};`)
        ];
        if (current === undefined) {
            const content = [
                `// ${CREATED_HEADER}`,
                '// Step definitions generated by TestPilot from test cases. Each step text in the features maps to one method here.',
                `package ${this.pkg}.bdd.steps;`,
                '',
                ...imports,
                '',
                'public class GeneratedSteps {',
                '    private final TestContext context;',
                '',
                '    public GeneratedSteps(TestContext context) {',
                '        this.context = context;',
                '    }',
                '',
                defs.map(render).join('\n\n'),
                '',
                '    // testpilot:steps',
                '}',
                ''
            ].join('\n');
            return { path: file, status: 'new', content };
        }
        const missing = defs.filter(d => !current.includes(`(${jstr(cucumberExpression(d.text))})`));
        if (!missing.length) return { path: file, status: 'unchanged', content: current };
        if (!current.includes('// testpilot:steps')) {
            notes.push(`${file} has no // testpilot:steps marker, so it was left alone. Add these step definitions yourself:\n${missing.map(render).join('\n\n')}`);
            return { path: file, status: 'skip', content: current, note: 'No // testpilot:steps marker; add the listed step definitions by hand.' };
        }
        let content = current.replace(/^([ \t]*)\/\/ testpilot:steps/m, `${missing.map(render).join('\n\n')}\n\n$1// testpilot:steps`);
        for (const imp of imports.filter(Boolean)) {
            if (content.includes(imp)) continue;
            const lastImport = [...content.matchAll(/^import [^\n]+;$/gm)].pop();
            content = lastImport ? content.slice(0, lastImport.index! + lastImport[0].length) + `\n${imp}` + content.slice(lastImport.index! + lastImport[0].length) : content.replace(/^(package [^\n]+\n)/m, `$1\n${imp}`);
        }
        return { path: file, status: 'merge', content, note: `Adds ${missing.length} step definition(s) above the TestPilot marker.` };
    }

    private pageObjectFile(po: PageDraft, notes: string[]): PlannedFile {
        const current = this.store.read(po.file);
        const fieldLines = [...po.locators.entries()].map(([name, expr]) => `    public final By ${name} = ${expr};`);
        const methodBlocks = [...po.methods.values()];
        if (current === undefined) {
            const content = [
                `// ${CREATED_HEADER}`,
                `package ${this.pkg}.pages;`,
                '',
                'import org.openqa.selenium.By;',
                'import org.openqa.selenium.WebDriver;',
                ...(po.usesUsers ? ['', `import ${this.pkg}.data.TestUsers;`] : []),
                '',
                `/** Page object for ${comment(po.className.replace(/Page$/, ''))}. TestPilot adds locators and actions above the markers when it generates new tests. */`,
                `public class ${po.className} extends BasePage {`,
                `    public ${po.className}(WebDriver driver) {`,
                `        super(driver, ${jstr(po.path)});${po.pathKnown ? '' : ' // TODO(testpilot): check this path; exploration did not find the page.'}`,
                '    }',
                '',
                ...fieldLines,
                '    // testpilot:locators',
                ...(methodBlocks.length ? ['', methodBlocks.join('\n\n')] : []),
                '    // testpilot:actions',
                '}',
                ''
            ].join('\n');
            return { path: po.file, status: 'new', content };
        }
        const missingLocators = [...po.locators.entries()].filter(([name]) => !new RegExp(`\\b${name}\\b`).test(current)).map(([name, expr]) => `    public final By ${name} = ${expr};`);
        const missingMethods = [...po.methods.entries()].filter(([name]) => !new RegExp(`\\b${name}\\s*\\(`).test(current)).map(([, block]) => block);
        if (!missingLocators.length && !missingMethods.length) return { path: po.file, status: 'unchanged', content: current };
        if ((missingLocators.length && !current.includes('// testpilot:locators')) || (missingMethods.length && !current.includes('// testpilot:actions'))) {
            notes.push(`${po.file} has no TestPilot markers, so it was left alone. Add these members yourself:\n${[...missingLocators, ...missingMethods].join('\n')}`);
            return { path: po.file, status: 'skip', content: current, note: 'No // testpilot: markers; add the listed members by hand.' };
        }
        let content = current;
        if (missingLocators.length) content = content.replace(/^([ \t]*)\/\/ testpilot:locators/m, `${missingLocators.join('\n')}\n$1// testpilot:locators`);
        if (missingMethods.length) content = content.replace(/^([ \t]*)\/\/ testpilot:actions/m, `\n${missingMethods.join('\n\n')}\n$1// testpilot:actions`);
        if (po.usesUsers && !content.includes('TestUsers')) content = content.replace(/^(import org\.openqa\.selenium\.WebDriver;)/m, `$1\n\nimport ${this.pkg}.data.TestUsers;`);
        return { path: po.file, status: 'merge', content, note: `Adds ${[...missingLocators, ...missingMethods].length} member(s) above the TestPilot markers.` };
    }

    readonly usedPages = new Set<string>();

    supportFiles(): { files: PlannedFile[]; notes: string[] } {
        const files: PlannedFile[] = [];
        const notes: string[] = [];
        for (const d of this.stepDefs.values()) for (const p of d.pages) this.usedPages.add(p);
        const used = [...this.pages.values()].filter(po => po.locators.size || po.methods.size || this.usedPages.has(po.className));
        for (const po of used) files.push(this.pageObjectFile(po, notes));
        const steps = this.stepsFile(notes);
        if (steps) files.push(steps);
        notes.push(...this.duplicateSteps);
        return { files, notes };
    }
}

/** Plans every Java file for a batch of cases. Cases containing text written as instructions to an AI are left for a person. */
export function planSeleniumTests(store: ProjectStore, config: Config, cases: TestCase[], exploration: ExploredPage[]): GenerationPlan {
    const gen = new SeleniumGenerator(store, config, exploration);
    const files: PlannedFile[] = [];
    const out: GeneratedCase[] = [];
    for (const tc of cases) {
        const text = [tc.title, ...tc.preconditions, ...tc.steps.flatMap(s => [s.action, s.data ?? '', s.expected ?? '']), tc.expected ?? ''].join('\n');
        if (clean(text).suspicious) {
            out.push({ id: tc.id, spec: '', todos: 0, skipped: 'Contains text written as instructions to an AI. A person should check the case first.' });
            continue;
        }
        const spec = gen.spec(tc);
        for (const m of spec.content.matchAll(/^\s+(\w+Page) \w+ = new \1\(driver\);$/gm)) gen.usedPages.add(m[1]);
        files.push(compareWithDisk(store, spec.file, spec.content));
        out.push({ id: tc.id, spec: spec.file, todos: spec.todos });
    }
    const support = gen.supportFiles();
    return { files: [...support.files, ...files], cases: out, pageObjects: support.files.filter(f => f.path.includes('/pages/')).map(f => f.path), notes: support.notes };
}

/** The repository path of a Java class, for run results. */
export function javaClassPath(config: Config, className: string): string {
    return inTestRoot(config, path.posix.join('src/test/java', `${className.replace(/\./g, '/')}.java`));
}
