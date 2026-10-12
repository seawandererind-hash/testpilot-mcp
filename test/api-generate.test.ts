import { describe, expect, it } from 'vitest';

import { ConfigSchema, type TestCase } from '../src/core/schema.js';
import { apiSpec, parseRequest, parseResponseChecks } from '../src/generate/api.js';

const config = ConfigSchema.parse({ appType: 'api', stack: { framework: 'playwright-api', language: 'typescript', templatePack: 'playwright-ts' } });

function tc(partial: Partial<TestCase>): TestCase {
    return { id: 'API-1', title: 'Create an order', preconditions: [], steps: [], tags: [], source: { type: 'excel', ref: 'api.xlsx' }, ...partial } as TestCase;
}

describe('API step reader', () => {
    it.each([
        ['Send a GET request to /orders/42', { method: 'get', path: '/orders/42', auth: 'default' }],
        ['POST /orders', { method: 'post', path: '/orders' }],
        ['Call DELETE on `/orders/42` without a token', { method: 'delete', path: '/orders/42', auth: 'none' }],
        ['Send GET https://staging.example.com/api/users?page=2 with an invalid token', { method: 'get', path: '/api/users?page=2', auth: 'invalid' }],
        ['PUT /users/7 with header X-Request-Id: "abc-1"', { method: 'put', path: '/users/7', headers: { 'X-Request-Id': 'abc-1' } }]
    ])('%s', (step, expected) => {
        expect(parseRequest(step)).toMatchObject(expected);
    });

    it('takes a JSON body from the data column or inline, and leaves prose bodies as TODO', () => {
        expect(parseRequest('POST /orders', '{"sku": "RED-1", "qty": 2}')?.body).toEqual({ sku: 'RED-1', qty: 2 });
        expect(parseRequest('POST /orders with body {"sku": "X"}')?.body).toEqual({ sku: 'X' });
        expect(parseRequest('POST /orders', 'a valid order')?.bodyTodo).toBe('a valid order');
        expect(parseRequest('Open the dashboard')).toBeUndefined();
    });

    it.each([
        ['Status code is 201', [{ kind: 'status', code: 201 }]],
        ['Returns 404 Not Found', [{ kind: 'status', code: 404 }]],
        ['Response status is Unauthorized', [{ kind: 'status', code: 401 }]],
        ['Response contains field "id"', [{ kind: 'has-field', field: 'id' }]],
        ['Field "status" is "PAID"', [{ kind: 'field-equals', field: 'status', value: 'PAID' }]],
        ['Property total equals 42.5', [{ kind: 'field-equals', field: 'total', value: 42.5 }]],
        ['Error message "Order not found" is returned', [{ kind: 'text', text: 'Order not found' }]],
        ['Response is a list of orders', [{ kind: 'array' }]],
        ['Content-Type is application/json', [{ kind: 'header', name: 'content-type', value: 'application/json' }]],
        ['Responds within 2 seconds', [{ kind: 'time', ms: 2000 }]],
        ['The e-mail is valid', [{ kind: 'unknown' }]]
    ])('expected: %s', (text, checks) => {
        expect(parseResponseChecks(text)).toMatchObject(checks);
    });
});

describe('API spec generation', () => {
    it('writes a complete Playwright API test with no secrets and no TODOs', () => {
        const spec = apiSpec(
            config,
            tc({
                area: 'Orders',
                priority: 'P1',
                preconditions: ['User is authenticated'],
                steps: [
                    { action: 'Send POST /orders', data: '{"sku":"RED-1","qty":2}', expected: 'Status code is 201' },
                    { action: 'GET /orders/{id} without a token', expected: 'Returns 401' }
                ],
                expected: 'Response contains field "id"'
            })
        );
        expect(spec.file).toBe('tests/api/orders/API-1.spec.ts');
        expect(spec.todos).toBe(0);
        expect(spec.content).toContain("test(\n    'API-1 Create an order',");
        expect(spec.content).toContain("tag: ['@API-1', '@api', '@orders', '@p1']");
        expect(spec.content).toContain("annotation: { type: 'test_key', description: 'API-1' }");
        expect(spec.content).toContain("const response1 = await request.post('/orders', { data: {\"sku\":\"RED-1\",\"qty\":2} });");
        expect(spec.content).toContain('expect(response1.status()).toBe(201);');
        expect(spec.content).toContain('playwright.request.newContext');
        expect(spec.content).toContain('expect(response2.status()).toBe(401);');
        expect(spec.content).toContain("expect(body2).toHaveProperty('id');");
        expect(spec.content).toContain('async ({ request, playwright })');
        expect(spec.content).not.toMatch(/waitForTimeout|setTimeout|Bearer [A-Za-z0-9]{8,}(?<!testing)/);
    });

    it('marks the test fixme when it cannot translate a step', () => {
        const spec = apiSpec(config, tc({ steps: [{ action: 'Reconcile the ledger', expected: 'Everything balances' }] }));
        expect(spec.todos).toBeGreaterThan(0);
        expect(spec.content).toContain('test.fixme(');
        expect(spec.content).toContain('TODO(testpilot)');
    });
});
