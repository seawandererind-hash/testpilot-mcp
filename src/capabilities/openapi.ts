import path from 'node:path';

import YAML from 'yaml';

import { INTEGRATION_KEYS } from '../catalog/env-keys.js';
import { isLikelyProduction } from '../core/app-target.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { quote } from '../explore/web.js';
import { compareWithDisk, CREATED_HEADER, inTestRoot } from '../scaffold/engine.js';
import { type CapabilityPlan, emptyPlan, fetchText, type Lang, type PlanOutcome, planEnvExample, playwrightLang, relativeModule } from './shared.js';

/** Most endpoints TestPilot turns into tests in one go; the rest are listed as skipped. */
export const MAX_ENDPOINTS = 200;

type Json = Record<string, unknown>;

/** The parts of a response schema the generated tests check: required fields and their basic types. */
export interface Shape {
    type?: string | string[];
    nullable?: boolean;
    required?: string[];
    properties?: Record<string, Shape>;
    items?: Shape;
}

export interface Endpoint {
    method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    path: string;
    tag: string;
    summary?: string;
    /** Path with example values filled in, or undefined when a required value has no example. */
    concretePath?: string;
    query: Record<string, string | number | boolean>;
    missing: string[];
    contentType?: string;
    shape?: Shape;
    body?: unknown;
}

export interface ApiDescription {
    title: string;
    version: string;
    kind: 'openapi3' | 'swagger2';
    servers: string[];
    endpoints: Endpoint[];
    skipped: Array<{ method: string; path: string; reason: string }>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseDocument(text: string): Json {
    const trimmed = text.trim();
    let doc: unknown;
    try {
        doc = trimmed.startsWith('{') ? JSON.parse(trimmed) : YAML.parse(trimmed, { maxAliasCount: 100 });
    } catch (error) {
        throw new Error(`The API description is not valid JSON or YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
    if (!isObj(doc)) throw new Error('The API description is empty or not an object.');
    return doc;
}

class Resolver {
    constructor(private readonly doc: Json) {}

    ref(ref: string): unknown {
        if (!ref.startsWith('#/')) return undefined;
        let node: unknown = this.doc;
        for (const raw of ref.slice(2).split('/')) {
            const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
            node = isObj(node) ? node[key] : undefined;
        }
        return node;
    }

    /** Follows $ref and merges allOf; oneOf/anyOf use their first option. */
    schema(input: unknown, depth = 0): Json {
        if (!isObj(input) || depth > 8) return {};
        let s: Json = input;
        let guard = 0;
        while (typeof s.$ref === 'string' && guard++ < 10) {
            const next = this.ref(s.$ref);
            if (!isObj(next)) return {};
            s = next;
        }
        if (Array.isArray(s.allOf)) {
            const parts = s.allOf.map(p => this.schema(p, depth + 1));
            const merged: Json = { ...s, type: s.type ?? parts.find(p => p.type)?.type ?? 'object', properties: {}, required: [] };
            delete merged.allOf;
            for (const p of [s, ...parts]) {
                Object.assign(merged.properties as Json, isObj(p.properties) ? p.properties : {});
                (merged.required as string[]).push(...(Array.isArray(p.required) ? (p.required as string[]) : []));
            }
            return merged;
        }
        const option = Array.isArray(s.oneOf) ? s.oneOf[0] : Array.isArray(s.anyOf) ? s.anyOf[0] : undefined;
        if (option !== undefined) return { ...this.schema(option, depth + 1), ...(s.nullable ? { nullable: true } : {}) };
        return s;
    }

    param(input: unknown): Json {
        let p = input;
        let guard = 0;
        while (isObj(p) && typeof p.$ref === 'string' && guard++ < 10) p = this.ref(p.$ref);
        return isObj(p) ? p : {};
    }
}

/** Reduces a schema to what the generated checks need. */
export function shapeOf(r: Resolver, input: unknown, depth = 0): Shape | undefined {
    const s = r.schema(input);
    if (!Object.keys(s).length || depth > 3) return undefined;
    const shape: Shape = {};
    let type = s.type as string | string[] | undefined;
    if (Array.isArray(type)) {
        if (type.includes('null')) shape.nullable = true;
        type = type.filter(t => t !== 'null');
        if (type.length === 1) type = type[0];
    }
    if (!type && isObj(s.properties)) type = 'object';
    if (!type && s.items) type = 'array';
    if (type && (!Array.isArray(type) || type.length)) shape.type = type;
    if (s.nullable === true || s['x-nullable'] === true) shape.nullable = true;
    if (type === 'object' && isObj(s.properties) && Array.isArray(s.required)) {
        const required = (s.required as unknown[]).filter((k): k is string => typeof k === 'string' && k in (s.properties as Json));
        if (required.length) {
            shape.required = required;
            shape.properties = {};
            for (const key of required) {
                const child = shapeOf(r, (s.properties as Json)[key], depth + 1);
                if (child) shape.properties[key] = child;
            }
        }
    }
    if (type === 'array' && s.items) {
        const items = shapeOf(r, s.items, depth + 1);
        if (items) shape.items = items;
    }
    return shape;
}

/** An example value built from a schema: its example, default or first enum value, otherwise a typed placeholder. */
export function exampleOf(r: Resolver, input: unknown, depth = 0): unknown {
    const s = r.schema(input);
    if (s.example !== undefined) return s.example;
    if (s.default !== undefined) return s.default;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    let type = s.type;
    if (Array.isArray(type)) type = type.find(t => t !== 'null');
    if (!type && isObj(s.properties)) type = 'object';
    if (depth > 4) return type === 'array' ? [] : type === 'object' ? {} : null;
    switch (type) {
        case 'string':
            return ({ email: 'test.user@example.com', 'date-time': '2026-01-01T09:00:00Z', date: '2026-01-01', uuid: '00000000-0000-4000-8000-000000000000', uri: 'https://example.com', url: 'https://example.com' } as Record<string, string>)[String(s.format)] ?? 'example';
        case 'integer':
        case 'number':
            return typeof s.minimum === 'number' ? s.minimum : 1;
        case 'boolean':
            return true;
        case 'array':
            return s.items ? [exampleOf(r, s.items, depth + 1)] : [];
        case 'object': {
            const props = isObj(s.properties) ? s.properties : {};
            const required = Array.isArray(s.required) ? (s.required as string[]) : [];
            const keys = required.length ? required.filter(k => k in props) : Object.keys(props);
            return Object.fromEntries(keys.slice(0, 30).map(k => [k, exampleOf(r, props[k], depth + 1)]));
        }
        default:
            return null;
    }
}

function paramExample(r: Resolver, p: Json): unknown {
    if (p.example !== undefined) return p.example;
    if (isObj(p.examples)) {
        const first = Object.values(p.examples)[0];
        const value = isObj(first) ? (isObj(r.param(first)) ? r.param(first).value : undefined) : undefined;
        if (value !== undefined) return value;
    }
    if (p['x-example'] !== undefined) return p['x-example'];
    const s = r.schema(p.schema);
    for (const source of [s, p]) {
        if (source.example !== undefined) return source.example;
        if (source.default !== undefined) return source.default;
        if (Array.isArray(source.enum) && source.enum.length) return source.enum[0];
    }
    return undefined;
}

const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Reads an OpenAPI 3.x or Swagger 2 document into the endpoints TestPilot generates tests for. */
export function describeApi(doc: Json, max = MAX_ENDPOINTS): ApiDescription {
    const kind = typeof doc.openapi === 'string' && doc.openapi.startsWith('3') ? 'openapi3' : doc.swagger === '2.0' || doc.swagger === 2 ? 'swagger2' : undefined;
    if (!kind) throw new Error('This file is not an OpenAPI 3.x or Swagger 2.0 description (no "openapi: 3…" or "swagger: \'2.0\'" at the top).');
    const r = new Resolver(doc);
    const info = isObj(doc.info) ? doc.info : {};
    const servers = kind === 'openapi3' ? (Array.isArray(doc.servers) ? doc.servers.filter(isObj).map(s => String(s.url ?? '')) : []) : doc.host ? [`${Array.isArray(doc.schemes) ? doc.schemes[0] : 'https'}://${doc.host}${doc.basePath ?? ''}`] : [];
    const endpoints: Endpoint[] = [];
    const skipped: ApiDescription['skipped'] = [];
    const paths = isObj(doc.paths) ? doc.paths : {};
    const rootProduces = Array.isArray(doc.produces) ? (doc.produces as string[]) : [];
    for (const [rawPath, item] of Object.entries(paths)) {
        if (!isObj(item)) continue;
        const shared = Array.isArray(item.parameters) ? item.parameters.map(p => r.param(p)) : [];
        for (const method of METHODS) {
            const op = item[method];
            if (!isObj(op)) continue;
            if (endpoints.length >= max) {
                skipped.push({ method: method.toUpperCase(), path: rawPath, reason: `over the limit of ${max} endpoints per run` });
                continue;
            }
            if (op.deprecated === true) {
                skipped.push({ method: method.toUpperCase(), path: rawPath, reason: 'marked deprecated' });
                continue;
            }
            const own = Array.isArray(op.parameters) ? op.parameters.map(p => r.param(p)) : [];
            const params = [...shared.filter(s => !own.some(o => o.name === s.name && o.in === s.in)), ...own];
            const missing: string[] = [];
            let concrete = rawPath;
            for (const p of params.filter(p => p.in === 'path')) {
                const value = paramExample(r, p);
                if (scalar(value)) concrete = concrete.replace(`{${String(p.name)}}`, encodeURIComponent(String(value)));
                else missing.push(String(p.name));
            }
            const query: Endpoint['query'] = {};
            for (const p of params.filter(p => p.in === 'query' && p.required === true)) {
                const value = paramExample(r, p);
                if (scalar(value)) query[String(p.name)] = value;
                else missing.push(String(p.name));
            }
            let body: unknown;
            if (kind === 'openapi3' && isObj(op.requestBody)) {
                const rb = r.param(op.requestBody);
                const content = isObj(rb.content) ? rb.content : {};
                const media = content['application/json'] ?? Object.entries(content).find(([k]) => /json/.test(k))?.[1] ?? Object.values(content)[0];
                if (isObj(media)) body = media.example ?? exampleOf(r, media.schema);
            } else if (kind === 'swagger2') {
                const bodyParam = params.find(p => p.in === 'body');
                if (bodyParam) body = exampleOf(r, bodyParam.schema);
                const form = params.filter(p => p.in === 'formData');
                if (form.length) body = Object.fromEntries(form.map(p => [String(p.name), paramExample(r, p) ?? exampleOf(r, p)]));
            }
            const responses = isObj(op.responses) ? op.responses : {};
            const okKey = Object.keys(responses).sort().find(k => /^2(\d\d|XX)$/i.test(k));
            let contentType: string | undefined;
            let shape: Shape | undefined;
            if (okKey) {
                const res = r.param(responses[okKey]);
                if (kind === 'openapi3' && isObj(res.content)) {
                    const entries = Object.entries(res.content);
                    const chosen = entries.find(([k]) => k === 'application/json') ?? entries.find(([k]) => /json/.test(k)) ?? entries[0];
                    if (chosen) {
                        contentType = chosen[0] === '*/*' ? undefined : chosen[0].split(';')[0];
                        if (isObj(chosen[1]) && /json/.test(chosen[0])) shape = shapeOf(r, chosen[1].schema);
                    }
                } else if (kind === 'swagger2' && res.schema) {
                    const produces = Array.isArray(op.produces) ? (op.produces as string[]) : rootProduces;
                    contentType = produces.find(p => /json/.test(p)) ?? (produces.length ? undefined : 'application/json');
                    if (contentType) shape = shapeOf(r, res.schema);
                }
            }
            const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : (rawPath.split('/').find(seg => seg && !seg.startsWith('{')) ?? 'root');
            const summary = typeof op.summary === 'string' ? op.summary : typeof op.operationId === 'string' ? op.operationId : undefined;
            endpoints.push({ method, path: rawPath, tag, summary, concretePath: missing.length ? undefined : concrete, query, missing, contentType, shape, body });
            if (method === 'get' && missing.length) skipped.push({ method: 'GET', path: rawPath, reason: `needs an example value for ${missing.join(', ')} (add "example:" to the parameter in the API description)` });
        }
    }
    return { title: String(info.title ?? 'API'), version: String(info.version ?? ''), kind, servers, endpoints, skipped };
}

function tagSlug(tag: string): string {
    return (
        tag
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 50) || 'api'
    );
}

const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\*\//g, '* /').trim().slice(0, 150);

/**
 * A JavaScript literal in the project's style (single quotes, bare keys), on one line
 * when short, otherwise indented under `indent`.
 */
export function lit(value: unknown, indent = ''): string {
    const one = (v: unknown): string => {
        if (typeof v === 'string') return quote(v);
        if (v === undefined) return 'undefined';
        if (v === null || typeof v !== 'object') return JSON.stringify(v);
        if (Array.isArray(v)) return `[${v.map(one).join(', ')}]`;
        const entries = Object.entries(v as Json).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${one(x)}`);
        return entries.length ? `{ ${entries.join(', ')} }` : '{}';
    };
    const flat = one(value);
    if (flat.length <= 100 || value === null || typeof value !== 'object') return flat;
    const inner = `${indent}    `;
    if (Array.isArray(value)) return `[\n${value.map(v => `${inner}${lit(v, inner)}`).join(',\n')}\n${indent}]`;
    const entries = Object.entries(value as Json).map(([k, x]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${lit(x, inner)}`);
    return `{\n${entries.join(',\n')}\n${indent}}`;
}

function pathWithPlaceholders(e: Endpoint): string {
    return e.concretePath ?? e.path.replace(/\{([^}]+)\}/g, (_m, name: string) => `TODO_${name.replace(/[^A-Za-z0-9_]/g, '_')}`);
}

export function specFile(file: string, client: string, lang: Lang, source: string, api: ApiDescription, tag: string, endpoints: Endpoint[]): string {
    const ts = lang.typescript;
    const lines = [
        `// ${CREATED_HEADER}`,
        `// API tests generated from ${oneLine(source)} (${oneLine(api.title)}${api.version ? ` ${oneLine(api.version)}` : ''}), tag "${oneLine(tag)}".`,
        '// GET tests check the status (2xx), the content type, and that required fields exist with the right basic types.',
        '// Tests that change data (POST, PUT, PATCH, DELETE) start as test.fixme: check the example body, point it at test data,',
        '// then change test.fixme to test. The address comes from API_BASE_URL in .env (never production).',
        ...(ts ? [] : ['// @ts-check']),
        "import { test } from '@playwright/test';",
        '',
        `import { ApiClient, expectShape, expectSuccess } from '${relativeModule(file, client, !ts)}';`,
        '',
        `test.describe(${quote(`${tag} API`)}, () => {`
    ];
    const tags = ['@api', '@openapi', `@${tagSlug(tag)}`];
    for (const e of endpoints) {
        const title = `${e.method.toUpperCase()} ${e.path}${e.summary ? `: ${oneLine(e.summary)}` : ''}`;
        const target = quote(pathWithPlaceholders(e));
        if (e.method === 'get') {
            if (!e.concretePath) continue;
            const query = Object.keys(e.query).length ? `, ${lit(e.query)}` : '';
            lines.push(
                `    test(${quote(title)}, { tag: ${lit(tags)} }, async ({ request }) => {`,
                '        const api = new ApiClient(request);',
                `        const response = await api.get(${target}${query});`,
                `        await expectSuccess(response${e.contentType ? `, ${quote(e.contentType)}` : ''});`,
                ...(e.shape && e.contentType && /json/.test(e.contentType) ? [`        expectShape(await response.json(), ${lit(e.shape, '        ')});`] : []),
                '    });',
                ''
            );
        } else {
            const hasBody = e.method !== 'delete' && e.body !== undefined;
            lines.push(
                `    // ${e.method.toUpperCase()} changes data on the server, so this test starts disabled. Use data the test creates itself,`,
                `    // ${e.missing.length ? `fill in ${e.missing.join(', ')} (marked TODO_), ` : ''}then change test.fixme to test.`,
                `    test.fixme(${quote(title)}, { tag: ${lit([...tags, '@writes'])} }, async ({ request }) => {`,
                '        const api = new ApiClient(request);',
                ...(hasBody ? [`        const body = ${lit(e.body, '        ')};`] : []),
                `        const response = await api.${e.method}(${target}${hasBody ? ', body' : ''});`,
                `        await expectSuccess(response);`,
                '    });',
                ''
            );
        }
    }
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push('});', '');
    return lines.join('\n');
}

export function clientFile(lang: Lang): string {
    const ts = lang.typescript;
    const t = (typed: string) => (ts ? typed : '');
    return `// ${CREATED_HEADER}
${ts ? '' : '// @ts-check\n'}// A small client for the API under test plus a response-shape checker. No extra packages needed.
import { expect${ts ? ', type APIRequestContext, type APIResponse' : ''} } from '@playwright/test';
${ts ? `
/** Required fields and basic types, taken from the API description. */
export interface Shape {
    type?: string | string[];
    nullable?: boolean;
    required?: string[];
    properties?: Record<string, Shape>;
    items?: Shape;
}

type Query = Record<string, string | number | boolean>;
` : `
/** @typedef {{ type?: string | string[], nullable?: boolean, required?: string[], properties?: Record<string, any>, items?: any }} Shape */
/** @typedef {Record<string, string | number | boolean>} Query */
`}
/** API_BASE_URL from .env (or CI), always ending with a slash so base paths such as /v1 are kept. */
export function apiBaseUrl()${t(': string')} {
    const base = process.env.API_BASE_URL;
    if (!base) throw new Error('Missing API_BASE_URL. Put the address of the test API in .env (never production).');
    return base.endsWith('/') ? base : \`\${base}/\`;
}

/** Full URL of a path from the API description, with query parameters. */
export function apiUrl(path${t(': string')}, query${t(': Query')} = {})${t(': string')} {
    const url = new URL(path.replace(/^\\/+/, ''), apiBaseUrl());
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url.toString();
}

function headers()${t(': Record<string, string>')} {
    const token = process.env.API_TOKEN;
    return { Accept: 'application/json', ...(token ? { Authorization: \`Bearer \${token}\` } : {}) };
}

export class ApiClient {
    ${ts ? 'constructor(private readonly request: APIRequestContext) {}' : '/** @param {import(\'@playwright/test\').APIRequestContext} request */\n    constructor(request) {\n        this.request = request;\n    }'}

    get(path${t(': string')}, query${t(': Query')} = {})${t(': Promise<APIResponse>')} {
        return this.request.get(apiUrl(path, query), { headers: headers() });
    }

    post(path${t(': string')}, body${t('?: unknown')})${t(': Promise<APIResponse>')} {
        return this.request.post(apiUrl(path), { headers: headers(), data: body });
    }

    put(path${t(': string')}, body${t('?: unknown')})${t(': Promise<APIResponse>')} {
        return this.request.put(apiUrl(path), { headers: headers(), data: body });
    }

    patch(path${t(': string')}, body${t('?: unknown')})${t(': Promise<APIResponse>')} {
        return this.request.patch(apiUrl(path), { headers: headers(), data: body });
    }

    delete(path${t(': string')})${t(': Promise<APIResponse>')} {
        return this.request.delete(apiUrl(path), { headers: headers() });
    }
}

function typeOf(value${t(': unknown')})${t(': string')} {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
}

/** Lists every place where a value does not match the shape: missing required fields and wrong basic types. */
export function shapeErrors(value${t(': unknown')}, shape${t(': Shape')}, where = 'body')${t(': string[]')} {
    const actual = typeOf(value);
    if (actual === 'null') return shape.nullable || !shape.type ? [] : [\`\${where} is null\`];
    const allowed = shape.type === undefined ? [] : Array.isArray(shape.type) ? shape.type : [shape.type];
    if (allowed.length && !allowed.some(type => type === actual || (type === 'number' && actual === 'integer'))) return [\`\${where} should be \${allowed.join(' or ')} but is \${actual}\`];
    const errors${t(': string[]')} = [];
    if (actual === 'object') {
        const record = ${ts ? 'value as Record<string, unknown>' : '/** @type {Record<string, unknown>} */ (value)'};
        for (const key of shape.required ?? []) {
            if (!(key in record)) errors.push(\`\${where}.\${key} is missing\`);
            else if (shape.properties?.[key]) errors.push(...shapeErrors(record[key], shape.properties[key], \`\${where}.\${key}\`));
        }
    }
    if (actual === 'array' && shape.items) {
        ${ts ? '(value as unknown[])' : '/** @type {unknown[]} */ (value)'}.slice(0, 50).forEach((item, i) => errors.push(...shapeErrors(item, ${ts ? 'shape.items!' : 'shape.items'}, \`\${where}[\${i}]\`)));
    }
    return errors;
}

export function expectShape(value${t(': unknown')}, shape${t(': Shape')})${t(': void')} {
    expect(shapeErrors(value, shape), 'The response does not match the API description').toEqual([]);
}

/** A 2xx answer, with the content type the API description promises. */
export async function expectSuccess(response${t(': APIResponse')}, contentType${t('?: string')})${t(': Promise<void>')} {
    const status = response.status();
    expect(status >= 200 && status < 300, \`Expected a 2xx answer from \${response.url()}, got \${status}: \${(await response.text()).slice(0, 300)}\`).toBe(true);
    if (contentType) expect(response.headers()['content-type'] ?? '').toContain(contentType);
}
`;
}

/** Where the API description comes from: a file in the repository, or an http(s) address. */
export async function loadApiDocument(store: ProjectStore, config: Config, specArg: string | undefined, allowProduction: boolean, doFetch?: typeof fetch): Promise<{ source: string; text: string } | { error: string }> {
    const ref = specArg?.trim() || (config.app.kind === 'openapi' ? config.app.ref : undefined);
    if (!ref) return { error: 'Give the API description with spec: a path inside the repository (openapi.yaml, swagger.json) or an http(s) address of a test environment.' };
    if (/^https?:\/\//i.test(ref)) {
        let url: URL;
        try {
            url = new URL(ref);
        } catch {
            return { error: `${ref} is not a valid address.` };
        }
        if (url.username || url.password) return { error: 'Give the address without a username or password in it.' };
        if (isLikelyProduction(ref) && !allowProduction) {
            return { error: `${url.hostname} does not look like a test environment. TestPilot does not read from production by default. If this really is a safe address (for example a public API description), call again with allowProduction: true after the user confirms.` };
        }
        try {
            return { source: ref, text: await fetchText(ref, doFetch) };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }
    const relative = path.isAbsolute(ref) ? store.relative(ref) : ref.replace(/\\/g, '/');
    const text = store.read(relative);
    if (text === undefined) return { error: `${relative} was not found in the repository.` };
    return { source: relative, text };
}

export async function planOpenApi(store: ProjectStore, config: Config, specArg: string | undefined, allowProduction: boolean, doFetch?: typeof fetch): Promise<PlanOutcome> {
    const lang = playwrightLang(config, 'API tests from an OpenAPI file');
    if ('error' in lang) return lang;
    const loaded = await loadApiDocument(store, config, specArg, allowProduction, doFetch);
    if ('error' in loaded) return loaded;
    let api: ApiDescription;
    try {
        api = describeApi(parseDocument(loaded.text));
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    const runnable = api.endpoints.filter(e => e.method === 'get' && e.concretePath);
    const writes = api.endpoints.filter(e => e.method !== 'get');
    if (!runnable.length && !writes.length) return { error: `${loaded.source} describes no endpoints TestPilot can test.${api.skipped.length ? ` Skipped: ${api.skipped.slice(0, 5).map(s => `${s.method} ${s.path} (${s.reason})`).join('; ')}` : ''}` };
    const plan: CapabilityPlan = emptyPlan(
        'openapi',
        'API tests from an OpenAPI file',
        `Reads ${loaded.source} (${api.title}${api.version ? ` ${api.version}` : ''}) and writes one spec per tag: ${runnable.length} GET test(s) that run straight away and ${writes.length} test(s) that change data, written as test.fixme for a person to enable.`,
        `Generated API tests from ${loaded.source}: ${runnable.length} GET test(s), ${writes.length} disabled data-changing test(s)`
    );
    const client = inTestRoot(config, `tests/api/client.${lang.ext}`);
    plan.files.push(compareWithDisk(store, client, clientFile(lang)));
    const byTag = new Map<string, Endpoint[]>();
    for (const e of api.endpoints) if (e.method !== 'get' || e.concretePath) byTag.set(e.tag, [...(byTag.get(e.tag) ?? []), e]);
    const used = new Set<string>();
    for (const [tag, list] of byTag) {
        let name = tagSlug(tag);
        for (let i = 2; used.has(name); i++) name = `${tagSlug(tag)}-${i}`;
        used.add(name);
        const file = inTestRoot(config, `tests/api/${name}.api.spec.${lang.ext}`);
        plan.files.push(compareWithDisk(store, file, specFile(file, client, lang, loaded.source, api, tag, list)));
    }
    plan.files.push(planEnvExample(store, INTEGRATION_KEYS.api));
    const server = api.servers.find(s => /^https?:\/\//i.test(s) && !isLikelyProduction(s));
    plan.notes.push(`Set API_BASE_URL in .env to the test API${server ? ` (the description lists ${server})` : ''}. If the API needs a token, put it in API_TOKEN; it is sent as a Bearer token.`);
    plan.notes.push('Run them with `npx playwright test tests/api`.');
    if (api.skipped.length) plan.notes.push(`Skipped ${api.skipped.length} endpoint(s):\n${api.skipped.slice(0, 20).map(s => `  - ${s.method} ${s.path}: ${s.reason}`).join('\n')}${api.skipped.length > 20 ? `\n  - …and ${api.skipped.length - 20} more` : ''}`);
    plan.data = { source: loaded.source, api: { title: api.title, version: api.version, kind: api.kind }, getTests: runnable.length, fixmeTests: writes.length, skipped: api.skipped };
    return plan;
}
