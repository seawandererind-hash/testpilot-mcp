import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot } from '../scaffold/engine.js';
import { PII_ADVICE, type PiiFinding, scanCases } from './pii.js';
import { type CapabilityPlan, emptyPlan, type Lang, type PlanOutcome, planPackageAdditions, playwrightLang, relativeModule } from './shared.js';

/** Pinned: latest stable release that was at least two weeks old when checked (2026-10-13). */
export const FAKER_VERSION = '10.6.0';

export function factoryFile(lang: Lang): string {
    const ts = lang.typescript;
    const t = (typed: string, plain = '') => (ts ? typed : plain);
    return `// ${CREATED_HEADER}
${ts ? '' : '// @ts-check\n'}// Test data builders. Every value is unique for this run (run id + worker + counter), so tests
// running in parallel, or a re-run against the same environment, never collide on an email or order number.
// Override any field: buildUser({ firstName: 'Ada' }). Reproduce a run's random values with FAKER_SEED=123 in .env.
import { faker } from '@faker-js/faker';

if (process.env.FAKER_SEED) faker.seed(Number(process.env.FAKER_SEED));

/** Changes on every run; set TEST_RUN_ID in CI to tie data to a pipeline run. */
export const RUN_ID = (process.env.TEST_RUN_ID ?? \`\${Date.now().toString(36)}\${Math.random().toString(36).slice(2, 6)}\`).toLowerCase();
const WORKER = process.env.TEST_WORKER_INDEX ?? '0';
let counter = 0;

/** A value no other test in any run uses, e.g. "user-lx2k9a3f-w0-1". */
export function uniqueId(prefix = 'tp')${t(': string')} {
    counter += 1;
    return \`\${prefix}-\${RUN_ID}-w\${WORKER}-\${counter}\`;
}
${ts ? `
export interface User {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    phone: string;
}

export interface Address {
    street: string;
    city: string;
    postcode: string;
    country: string;
}

export interface OrderItem {
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
}

export interface Order {
    id: string;
    customer: User;
    shippingAddress: Address;
    items: OrderItem[];
    total: number;
}
` : ''}
/**
 * Generic builder: pass the defaults as a function of a fresh unique id, then overrides.
 * Example: const product = build(id => ({ sku: id, name: faker.commerce.productName() }), { name: 'Red shoes' });
 */
export function build${t('<T extends object>')}(defaults${t(': (id: string) => T')}, overrides${t(': Partial<T>')} = {})${t(': T')} {
    return { ...defaults(uniqueId('item')), ...overrides };
}

/** A user with a unique @example.com address (a domain that never receives mail) and a fictional 555 phone number. */
export function buildUser(overrides${t(': Partial<User>')} = {})${t(': User')} {
    const id = uniqueId('user');
    return {
        id,
        firstName: faker.person.firstName(),
        lastName: faker.person.lastName(),
        email: \`\${id}@example.com\`,
        password: \`Tp-\${faker.string.alphanumeric(12)}-9!\`,
        phone: \`+1-202-555-01\${String(counter % 100).padStart(2, '0')}\`,
        ...overrides
    };
}

export function buildAddress(overrides${t(': Partial<Address>')} = {})${t(': Address')} {
    return {
        street: faker.location.streetAddress(),
        city: faker.location.city(),
        postcode: faker.location.zipCode(),
        country: 'US',
        ...overrides
    };
}

export function buildOrder(overrides${t(': Partial<Order>')} = {})${t(': Order')} {
    const items = overrides.items ?? [
        { sku: uniqueId('sku'), name: faker.commerce.productName(), quantity: faker.number.int({ min: 1, max: 3 }), unitPrice: faker.number.int({ min: 5, max: 200 }) }
    ];
    return {
        id: uniqueId('order'),
        customer: buildUser(),
        shippingAddress: buildAddress(),
        items,
        total: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
        ...overrides
    };
}
`;
}

export function dataFixtureFile(config: Config, lang: Lang, file: string, baseFixtures: string | undefined, factory: string): string {
    const ts = lang.typescript;
    const ext = !ts;
    const baseImport = baseFixtures ? `import { expect, test as base } from '${relativeModule(file, baseFixtures, ext)}';` : `import { expect, test as base } from '@playwright/test';`;
    return `// ${CREATED_HEADER}
// Creates test data through the API before a test and deletes it afterwards, so every test starts from
// data it owns. Use it in a spec:
//     import { test, expect } from '${relativeModule(inTestRoot(config, 'tests/example.spec.ts'), file, ext)}';
//     test('SHOP-12 shows my order', async ({ seed, page }) => { const order = await seed.order(); ... });
${ts ? "import type { APIRequestContext } from '@playwright/test';\n\n" : ''}${baseImport}
import { buildOrder, buildUser${ts ? ', type Order, type User' : ''} } from '${relativeModule(file, factory, ext)}';

export class Seeder {
    ${ts ? 'private readonly created: string[] = [];' : '/** @type {string[]} */\n    created = [];'}

    constructor(${ts ? 'private readonly request: APIRequestContext' : 'request'}) {${ts ? '' : '\n        this.request = request;'}}

    /**
     * POSTs a record to a collection path and remembers it, so it is deleted after the test.
     * The response must contain the new record's id (idField).
     */
    async create${ts ? '<T extends object>' : ''}(collectionPath${ts ? ': string' : ''}, body${ts ? ': T' : ''}, idField = 'id')${ts ? ': Promise<T & Record<string, unknown>>' : ''} {
        const response = await this.request.post(collectionPath, { data: body });
        expect(response.ok(), \`Creating test data with POST \${collectionPath} failed with \${response.status()}\`).toBeTruthy();
        const saved = { ...body, ...(await response.json().catch(() => ({}))) };
        const id = saved[idField];
        if (id !== undefined && id !== null) this.created.push(\`\${collectionPath.replace(/\\/+$/, '')}/\${encodeURIComponent(String(id))}\`);
        return saved;
    }

    // TODO(testpilot): change the paths below to your API's real endpoints (ask your developers or check the API docs).
    async user(overrides${ts ? ': Partial<User>' : ''} = {}) {
        return this.create('/api/users', buildUser(overrides));
    }

    async order(overrides${ts ? ': Partial<Order>' : ''} = {}) {
        return this.create('/api/orders', buildOrder(overrides));
    }

    /** Deletes everything this test created, newest first. A failed delete never fails the test. */
    async cleanup()${ts ? ': Promise<void>' : ''} {
        for (const path of this.created.reverse()) {
            await this.request.delete(path).catch(() => undefined);
        }
    }
}

export const test = base.extend${ts ? '<{ seed: Seeder }>' : ''}({
    seed: async ({ playwright }, use) => {
        // Data goes through the API, not the browser: faster and independent of the UI under test.
        const token = process.env.API_TOKEN;
        const request = await playwright.request.newContext({
            baseURL: process.env.API_BASE_URL ?? process.env.APP_BASE_URL,
            extraHTTPHeaders: { Accept: 'application/json', ...(token ? { Authorization: \`Bearer \${token}\` } : {}) }
        });
        const seeder = new Seeder(request);
        await use(seeder);
        await seeder.cleanup();
        await request.dispose();
    }
});

export { expect };
`;
}

export function planTestData(store: ProjectStore, config: Config): PlanOutcome {
    const lang = playwrightLang(config, 'The test data factory');
    if ('error' in lang) return lang;
    const factory = inTestRoot(config, `test-data/factory.${lang.ext}`);
    const fixture = inTestRoot(config, `tests/fixtures/data.${lang.ext}`);
    const baseFixtures = inTestRoot(config, `src/fixtures/test.${lang.ext}`);
    const plan: CapabilityPlan = emptyPlan(
        'test-data',
        'Test data factory',
        `Builders for users, addresses and orders (plus a generic build()) that give every test its own unique data, and a "seed" fixture that creates data through the API before a test and deletes it afterwards.`,
        `Added the test data factory (${factory}) and the API seeding fixture (${fixture}) with @faker-js/faker ${FAKER_VERSION}`
    );
    plan.files.push(compareWithDisk(store, factory, factoryFile(lang)));
    plan.files.push(compareWithDisk(store, fixture, dataFixtureFile(config, lang, fixture, store.exists(baseFixtures) ? baseFixtures : undefined, factory)));
    const pkg = planPackageAdditions(store, config, { '@faker-js/faker': FAKER_VERSION });
    plan.files.push(pkg);
    if (pkg.status !== 'unchanged') {
        plan.install.push(['npm', 'install']);
    }
    plan.notes.push(`Change the API paths marked TODO(testpilot) in ${fixture} to your real endpoints. Data is created with API_BASE_URL (or APP_BASE_URL) and API_TOKEN from .env.`);

    const cases = store.readCases();
    const findings = scanCases(cases);
    plan.data = { personalData: findings, casesScanned: cases.length };
    if (findings.length) {
        plan.notes.push(personalDataSummary(findings));
    } else if (cases.length) {
        plan.notes.push(`Personal-data check: no real-looking emails, phone numbers, card numbers, IBANs or national ids in ${cases.length} imported test case(s).`);
    }
    return plan;
}

export function personalDataSummary(findings: PiiFinding[]): string {
    const byCase = new Map<string, PiiFinding[]>();
    for (const f of findings) byCase.set(f.caseId, [...(byCase.get(f.caseId) ?? []), f]);
    const kinds = [...new Set(findings.map(f => f.kind))];
    const lines = [...byCase].slice(0, 30).map(([id, list]) => `  - ${id}: ${list.map(f => `${f.kind} in ${f.field} (${f.masked})`).join('; ')}`);
    return [
        `Personal-data check: ${findings.length} value(s) in ${byCase.size} imported test case(s) look like real personal data. Test cases should not hold real people's data; replace them in the source tool and re-import:`,
        ...lines,
        ...(byCase.size > 30 ? [`  - …and ${byCase.size - 30} more case(s)`] : []),
        ...kinds.map(k => `  Fix for ${k}: ${PII_ADVICE[k]}.`)
    ].join('\n');
}
