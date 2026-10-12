import type { Config, TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { quote } from '../explore/web.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot, type PlannedFile } from '../scaffold/engine.js';
import { clean } from '../testcases/normalize.js';
import type { GeneratedCase, GenerationPlan } from './playwright.js';
import { slug } from './playwright.js';

/**
 * Generates Playwright API tests (APIRequestContext) from test cases written as
 * requests and expected responses. The base URL and the API token come from
 * playwright.config.ts (API_BASE_URL, API_TOKEN in .env); nothing secret is written
 * into the tests. Steps it cannot translate become TODO(testpilot) and the test is
 * marked fixme, so nothing passes by accident.
 */

export type RequestIntent = {
    kind: 'request';
    method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
    path: string;
    body?: unknown;
    bodyTodo?: string;
    headers: Record<string, string>;
    auth: 'default' | 'none' | 'invalid';
};

export type ResponseCheck =
    | { kind: 'status'; code: number }
    | { kind: 'ok' }
    | { kind: 'has-field'; field: string }
    | { kind: 'field-equals'; field: string; value: string | number | boolean | null }
    | { kind: 'text'; text: string }
    | { kind: 'array' }
    | { kind: 'header'; name: string; value: string }
    | { kind: 'time'; ms: number }
    | { kind: 'unknown'; text: string };

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD';
const REQUEST = new RegExp(String.raw`\b(${METHODS})\b(?:\s+request)?(?:\s+(?:to|on|for|at|against))?\s+(?:the\s+)?(?:endpoint\s+)?["'\x60]?((?:https?:\/\/[^\s"'\x60]+)|\/[^\s"'\x60]*)`, 'i');
const STATUS_TEXT: Record<string, number> = { ok: 200, created: 201, accepted: 202, 'no content': 204, 'bad request': 400, unauthorized: 401, unauthorised: 401, forbidden: 403, 'not found': 404, conflict: 409, 'unprocessable entity': 422, 'too many requests': 429 };

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed)) return { ok: false };
    try {
        return { ok: true, value: JSON.parse(trimmed) };
    } catch {
        return { ok: false };
    }
}

function literal(raw: string): string | number | boolean | null {
    const v = raw.trim().replace(/^["'\x60](.*)["'\x60]$/, '$1');
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    if (/^null$/i.test(v)) return null;
    return v;
}

/** Reads one step as an HTTP request, or returns undefined when it is something else. */
export function parseRequest(action: string, data?: string): RequestIntent | undefined {
    const m = REQUEST.exec(action);
    if (!m) return undefined;
    let target = m[2].replace(/[.,;:)]+$/, '');
    if (/^https?:\/\//i.test(target)) {
        const url = new URL(target);
        target = `${url.pathname}${url.search}`;
    }
    const headers: Record<string, string> = {};
    for (const h of action.matchAll(/\bheader\s+["']?([A-Za-z0-9-]+)["']?\s*(?:=|:|to|as|set to)\s*["']([^"']+)["']/gi)) headers[h[1]] = h[2];
    const auth: RequestIntent['auth'] = /\b(without|no|missing)\s+(an?\s+)?(auth|authori[sz]ation|token|credentials|api key)\b|\bunauthenticated\b|\banonymous(ly)?\b/i.test(action)
        ? 'none'
        : /\b(invalid|expired|wrong|bad|fake)\s+(auth|token|credentials|api key)\b/i.test(action)
          ? 'invalid'
          : 'default';
    const intent: RequestIntent = { kind: 'request', method: m[1].toLowerCase() as RequestIntent['method'], path: target || '/', headers, auth };
    const inline = /\b(?:with|using)\s+(?:the\s+)?(?:json\s+)?(?:body|payload)\s*:?\s*([[{][\s\S]*[\]}])/i.exec(action)?.[1];
    const bodyText = inline ?? (data && data.trim() ? data : undefined);
    if (bodyText) {
        const parsed = parseJson(bodyText);
        if (parsed.ok) intent.body = parsed.value;
        else intent.bodyTodo = bodyText.trim().slice(0, 200);
    } else if (/\b(with|using)\s+(a\s+|the\s+)?(valid\s+|invalid\s+)?(body|payload|data)\b/i.test(action) && ['post', 'put', 'patch'].includes(intent.method)) {
        intent.bodyTodo = 'request body described in words';
    }
    return intent;
}

/** Reads an expected result as checks on the last response. */
export function parseResponseChecks(raw: string): ResponseCheck[] {
    const text = raw.trim().replace(/^(?:then\s+|and\s+)?(?:verify|check|ensure|confirm|validate|assert|expect)\s+(?:that\s+)?/i, '');
    const out: ResponseCheck[] = [];
    let m: RegExpExecArray | null;
    if ((m = /\b(?:status(?:\s+code)?|response\s+code|http\s+code|returns?|responds?\s+with|gets?|receives?)\s*(?:is|should be|equals?|of|=|:)?\s*(\d{3})\b/i.exec(text)) || (m = /^\s*(\d{3})\b/.exec(text))) out.push({ kind: 'status', code: Number(m[1]) });
    else {
        const named = Object.keys(STATUS_TEXT).find(k => new RegExp(String.raw`\b(?:status(?:\s+code)?\s+(?:is\s+)?|returns?\s+(?:an?\s+)?|responds?\s+with\s+(?:an?\s+)?)${k}\b`, 'i').test(text));
        if (named) out.push({ kind: 'status', code: STATUS_TEXT[named] });
        else if (/\b(successful|success)\s+(response|status)\b|\brequest succeeds\b/i.test(text)) out.push({ kind: 'ok' });
    }
    for (const f of text.matchAll(/\b(?:field|property|key|attribute)\s+["'\x60]?([\w.[\]-]+)["'\x60]?\s+(?:is|equals?|=|should be|has value|with value)\s+("[^"]*"|'[^']*'|[\w.-]+)/gi)) out.push({ kind: 'field-equals', field: f[1], value: literal(f[2]) });
    if (!out.some(c => c.kind === 'field-equals')) {
        for (const f of text.matchAll(/\b(?:contains?|includes?|has|have|with)\s+(?:an?\s+|the\s+)?(?:field|property|key|attribute)s?\s+["'\x60]?([\w.[\]-]+)["'\x60]?/gi)) out.push({ kind: 'has-field', field: f[1] });
        for (const f of text.matchAll(/["'\x60]([\w.[\]-]+)["'\x60]\s+(?:field|property|key)\b/gi)) out.push({ kind: 'has-field', field: f[1] });
    }
    if (!out.some(c => c.kind === 'has-field' || c.kind === 'field-equals')) {
        const quoted = /\b(?:contains?|includes?|shows?|message|error)\b[^"']*["']([^"']+)["']/i.exec(text);
        if (quoted) out.push({ kind: 'text', text: quoted[1] });
    }
    if (/\b(list|array|collection)\b/i.test(text) && /\b(returns?|is|response|body)\b/i.test(text)) out.push({ kind: 'array' });
    if ((m = /\b(?:header\s+)?["']?(content-type|[A-Za-z]+-[A-Za-z-]+)["']?\s+(?:header\s+)?(?:is|contains?|equals?|=)\s+["']?([\w/.+-]+)["']?/i.exec(text)) && (/content-type/i.test(m[1]) || /\bheader\b/i.test(text))) out.push({ kind: 'header', name: m[1].toLowerCase(), value: m[2].replace(/[.,;:]+$/, '') });
    else if (/\b(json response|returns json|response is json)\b/i.test(text)) out.push({ kind: 'header', name: 'content-type', value: 'application/json' });
    if ((m = /\b(?:response\s+time|responds?|returns?|takes?)\b[^\d]{0,30}(?:under|less than|below|within|<)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(text))) out.push({ kind: 'time', ms: Math.round(Number(m[1]) * (/^m/i.test(m[2]) ? 1 : 1000)) });
    return out.length ? out : [{ kind: 'unknown', text }];
}

function accessor(field: string): string {
    return quote(field);
}

interface Ctx {
    body: string[];
    todos: number;
    usesPlaywright: boolean;
    n: number;
    current?: { response: string; json?: string; started: string; line: number; timed?: boolean };
}

function emitRequest(r: RequestIntent, ctx: Ctx): void {
    ctx.n += 1;
    const response = `response${ctx.n}`;
    const started = `started${ctx.n}`;
    const options: string[] = [];
    if (r.body !== undefined) options.push(`data: ${JSON.stringify(r.body)}`);
    const headers = { ...r.headers, ...(r.auth === 'invalid' ? { Authorization: 'Bearer invalid-token-for-testing' } : {}) };
    if (Object.keys(headers).length) options.push(`headers: { ${Object.entries(headers).map(([k, v]) => `${quote(k)}: ${quote(v)}`).join(', ')} }`);
    if (r.bodyTodo) {
        ctx.todos += 1;
        ctx.body.push(`// TODO(testpilot): write the request body as JSON: ${r.bodyTodo.replace(/\s+/g, ' ')}`);
    }
    let client = 'request';
    if (r.auth === 'none') {
        // A fresh context without the default Authorization header from playwright.config.ts.
        ctx.usesPlaywright = true;
        client = `anonymous${ctx.n}`;
        ctx.body.push(`const ${client} = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, extraHTTPHeaders: { Accept: 'application/json' } });`);
    }
    ctx.body.push(`const ${response} = await ${client}.${r.method}(${quote(r.path)}${options.length ? `, { ${options.join(', ')} }` : ''});`);
    ctx.current = { response, started, line: ctx.body.length - 1 };
}

function emitCheck(c: ResponseCheck, ctx: Ctx): void {
    const cur = ctx.current;
    if (!cur) {
        ctx.todos += 1;
        ctx.body.push(`// TODO(testpilot): no request was sent before this check: ${c.kind === 'unknown' ? c.text : c.kind}`);
        return;
    }
    const json = () => {
        if (!cur.json) {
            cur.json = `${cur.response.replace('response', 'body')}`;
            ctx.body.push(`const ${cur.json} = await ${cur.response}.json();`);
        }
        return cur.json;
    };
    switch (c.kind) {
        case 'status':
            ctx.body.push(`expect(${cur.response}.status()).toBe(${c.code});`);
            return;
        case 'ok':
            ctx.body.push(`expect(${cur.response}.ok(), await ${cur.response}.text()).toBeTruthy();`);
            return;
        case 'has-field':
            ctx.body.push(`expect(${json()}).toHaveProperty(${accessor(c.field)});`);
            return;
        case 'field-equals':
            ctx.body.push(`expect(${json()}).toHaveProperty(${accessor(c.field)}, ${JSON.stringify(c.value)});`);
            return;
        case 'text':
            ctx.body.push(`expect(await ${cur.response}.text()).toContain(${quote(c.text)});`);
            return;
        case 'array':
            ctx.body.push(`expect(Array.isArray(${json()})).toBe(true);`);
            return;
        case 'header':
            ctx.body.push(`expect(${cur.response}.headers()[${quote(c.name)}]).toContain(${quote(c.value)});`);
            return;
        case 'time':
            // Measured around the request above; generous on purpose, it is a guard, not a benchmark.
            if (!cur.timed) {
                ctx.body.splice(cur.line, 0, `const ${cur.started} = Date.now();`);
                cur.timed = true;
                cur.line += 1;
            }
            ctx.body.push(`expect(Date.now() - ${cur.started}).toBeLessThan(${c.ms});`);
            return;
        case 'unknown':
            ctx.todos += 1;
            ctx.body.push(`// TODO(testpilot): check "${c.text.replace(/\s+/g, ' ').slice(0, 160)}"`);
    }
}

export function apiSpec(config: Config, tc: TestCase): { file: string; content: string; todos: number } {
    const ctx: Ctx = { body: [], todos: 0, usesPlaywright: false, n: 0 };
    for (const pre of tc.preconditions) {
        if (/\b(authenticated|logged in|valid token|api token|authori[sz]ed)\b/i.test(pre) && !/\bnot\b/i.test(pre)) ctx.body.push(`// Precondition: ${pre} (API_TOKEN from .env is sent by playwright.config.ts)`);
        else {
            const req = parseRequest(pre);
            if (req) emitRequest(req, ctx);
            else {
                ctx.todos += 1;
                ctx.body.push(`// TODO(testpilot): set up "${pre.replace(/\s+/g, ' ').slice(0, 160)}" (create the data through the API in this test)`);
            }
        }
    }
    tc.steps.forEach((step, i) => {
        ctx.body.push('', `// Step ${i + 1}: ${step.action.replace(/\s+/g, ' ').slice(0, 200)}`);
        const req = parseRequest(step.action, step.data);
        if (req) emitRequest(req, ctx);
        else if (/\b(authenticate|log ?in|sign ?in|get (a|an) (access )?token)\b/i.test(step.action)) ctx.body.push('// Authentication: API_TOKEN from .env is sent with every request (playwright.config.ts).');
        else {
            const checks = parseResponseChecks(step.action);
            if (checks[0].kind !== 'unknown') checks.forEach(c => emitCheck(c, ctx));
            else {
                ctx.todos += 1;
                ctx.body.push(`// TODO(testpilot): "${step.action.replace(/\s+/g, ' ').slice(0, 160)}"`);
            }
        }
        if (step.expected) {
            ctx.body.push(`// Expected: ${step.expected.replace(/\s+/g, ' ').slice(0, 200)}`);
            parseResponseChecks(step.expected).forEach(c => emitCheck(c, ctx));
        }
    });
    if (tc.expected) {
        ctx.body.push('', `// Expected: ${tc.expected.replace(/\s+/g, ' ').slice(0, 200)}`);
        for (const line of tc.expected.split(/\n+/).filter(Boolean)) parseResponseChecks(line).forEach(c => emitCheck(c, ctx));
    }
    if (!ctx.n) {
        ctx.todos += 1;
        ctx.body.push('// TODO(testpilot): this case does not say which request to send (for example "GET /orders/42").');
    }
    const area = tc.area ?? 'api';
    const file = inTestRoot(config, `tests/api/${slug(area) || 'api'}/${tc.id.replace(/[^A-Za-z0-9._-]+/g, '_')}.spec.ts`);
    const tags = [`@${tc.id}`, '@api', ...(tc.area ? [`@${slug(tc.area)}`] : []), ...(tc.priority ? [`@${tc.priority.toLowerCase()}`] : []), ...tc.tags.map(t => `@${slug(t)}`)].filter((t, i, all) => all.indexOf(t) === i && t.length > 1);
    const fixtures = ['request', ...(ctx.usesPlaywright ? ['playwright'] : [])];
    const usesExpect = ctx.body.some(l => l.includes('expect('));
    const lines = [
        `// ${CREATED_HEADER}`,
        `// Generated from test case ${tc.id} (${tc.source.type}${tc.source.ref ? `: ${tc.source.ref.replace(/\s+/g, ' ')}` : ''}).${ctx.todos ? ` ${ctx.todos} TODO(testpilot) item(s) to finish; the test is marked fixme until then.` : ''}`,
        `import { ${usesExpect ? 'expect, ' : ''}test } from '@playwright/test';`,
        '',
        `test${ctx.todos ? '.fixme' : ''}(`,
        `    ${quote(`${tc.id} ${clean(tc.title).text.replace(/\s+/g, ' ')}`)},`,
        `    { tag: [${tags.map(quote).join(', ')}], annotation: { type: 'test_key', description: ${quote(tc.id)} } },`,
        `    async ({ ${fixtures.join(', ')} }) => {`,
        ...ctx.body.map(l => (l ? `        ${l}` : '')),
        '    }',
        ');',
        ''
    ];
    return { file, content: lines.join('\n'), todos: ctx.todos };
}

/** Plans API specs for a batch of cases. Cases with text written as instructions to an AI are left for a person. */
export function planApiTests(store: ProjectStore, config: Config, cases: TestCase[]): GenerationPlan {
    const files: PlannedFile[] = [];
    const out: GeneratedCase[] = [];
    for (const tc of cases) {
        const text = [tc.title, ...tc.preconditions, ...tc.steps.flatMap(s => [s.action, s.data ?? '', s.expected ?? '']), tc.expected ?? ''].join('\n');
        if (clean(text).suspicious) {
            out.push({ id: tc.id, spec: '', todos: 0, skipped: 'Contains text written as instructions to an AI. A person should check the case first.' });
            continue;
        }
        const spec = apiSpec(config, tc);
        files.push(compareWithDisk(store, spec.file, spec.content));
        out.push({ id: tc.id, spec: spec.file, todos: spec.todos });
    }
    return { files, cases: out, pageObjects: [], notes: ['API tests use API_BASE_URL and API_TOKEN from .env through playwright.config.ts.'] };
}
