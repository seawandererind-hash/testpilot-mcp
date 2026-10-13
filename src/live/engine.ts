/**
 * Runs live_test actions on a session: sends them to the browser, records what really
 * happened and keeps the per-page captures used for the exploration merge.
 */
import type { ProjectStore } from '../core/store.js';
import { type ExploredElement, parseAriaSnapshot } from '../explore/web.js';
import { type DriverReply, describeTarget, isSecretKey, isSensitiveTarget, type LiveStepInput, locatorExpression, MASK } from './protocol.js';
import { pathOf, type RecordedStep, type RecordedValue } from './recording.js';
import type { LiveSession } from './session.js';

export interface ElementChanges {
    added: ExploredElement[];
    removed: Array<{ role: string; name: string }>;
}

export interface PageView {
    url: string;
    path: string;
    title: string;
    screenshot?: string;
    headings: string[];
    elements: ExploredElement[];
}

export interface StepOutcome {
    ok: boolean;
    error?: string;
    step: RecordedStep;
    /** What was typed, as shown to the AI: masked for secrets. */
    shownValue?: string;
    page: PageView;
    changes: ElementChanges;
}

/** Elements that appeared or disappeared between two snapshots. */
export function diffElements(before: ExploredElement[], after: ExploredElement[]): ElementChanges {
    const key = (e: { role: string; name: string }) => `${e.role}|${e.name}`;
    const was = new Set(before.map(key));
    const now = new Set(after.map(key));
    return { added: after.filter(e => !was.has(key(e))), removed: before.filter(e => !now.has(key(e))).map(e => ({ role: e.role, name: e.name })) };
}

/** Stores what the browser just showed on the session and returns a compact view of it. */
export function capture(session: LiveSession, store: ProjectStore, reply: DriverReply): PageView {
    const { elements, headings } = parseAriaSnapshot(reply.snapshot ?? '');
    const url = reply.url ?? session.current.url;
    const path = pathOf(url);
    const screenshot = reply.screenshot ? store.relative(reply.screenshot) : undefined;
    const title = reply.title ?? '';
    session.current = { url, title, elements };
    if (/^https?:/i.test(url)) session.pages.set(path, { url, path, title, screenshot, elements, testIds: reply.testIds ?? [], headings });
    return { url, path, title, screenshot, headings, elements };
}

/** Compact element list for tool results: interactive elements first, headings separately. */
export function compactView(view: PageView, limit = 40): Record<string, unknown> {
    return {
        url: view.url,
        title: view.title,
        screenshot: view.screenshot,
        headings: view.headings.slice(0, 10),
        elements: view.elements
            .filter(e => e.role !== 'heading')
            .slice(0, limit)
            .map(e => ({ role: e.role, name: e.name, locator: `page.${e.locator}`, ...(e.count > 1 ? { count: e.count } : {}) }))
    };
}

export type ValueCheck = { ok: true; value?: string; recorded?: RecordedValue; shown?: string } | { ok: false; message: string };

/** Works out the value for a step: a literal, or a .env key resolved here (never returned). */
export function resolveStepValue(input: LiveStepInput, env: Record<string, string>): ValueCheck {
    if (input.valueFromEnv !== undefined) {
        const name = input.valueFromEnv.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, message: `"${name}" is not a .env key name. Pass the key name (such as TEST_USER_PASSWORD), never the value.` };
        const value = env[name];
        if (value === undefined || value === '') return { ok: false, message: `${name} is not set. Ask the user to add it to .env (check_env shows what is missing), then try again. Never ask for the value in chat.` };
        const secret = isSecretKey(name) || isSensitiveTarget(input.target);
        return { ok: true, value, recorded: { kind: 'env', name }, shown: secret ? MASK : `(from .env ${name})` };
    }
    if (input.value === undefined) return { ok: true };
    if (input.action === 'fill' && isSensitiveTarget(input.target) && input.value !== '') {
        return { ok: false, message: `${describeTarget(input.target)} looks like a password or secret field. Put the value in .env and pass its key name with valueFromEnv (for example TEST_USER_PASSWORD) instead of typing it here.` };
    }
    return { ok: true, value: input.value, recorded: { kind: 'literal', value: input.value }, shown: input.action === 'fill' && isSensitiveTarget(input.target) ? MASK : input.value };
}

/** Sends one step to the browser and appends it to the recording. */
export async function performStep(session: LiveSession, store: ProjectStore, input: LiveStepInput, value: Extract<ValueCheck, { ok: true }>, fromCase?: string): Promise<StepOutcome> {
    const before = session.current.elements;
    const page = pathOf(session.current.url);
    const reply = await session.handle.send({ op: 'step', action: input.action, target: input.target, value: value.value, timeoutMs: input.timeoutMs, label: `step-${session.steps.length + 1}-${input.action}` }, (input.timeoutMs ?? 10_000) + 60_000);
    const view = capture(session, store, reply);
    const step: RecordedStep = {
        n: session.steps.length + 1,
        at: new Date().toISOString(),
        page,
        action: input.action,
        ...(input.target ? { target: input.target, locator: locatorExpression(input.target) } : {}),
        ...(value.recorded ? { value: value.recorded } : {}),
        result: reply.ok ? 'ok' : 'error',
        ...(reply.error ? { error: reply.error } : {}),
        urlAfter: view.url,
        ...(fromCase ? { fromCase } : {})
    };
    session.steps.push(step);
    return { ok: reply.ok, error: reply.error, step, shownValue: value.shown, page: view, changes: diffElements(before, view.elements) };
}

/** A recorded step as shown to the AI: env values by key name, secrets masked. */
export function showStep(step: RecordedStep): Record<string, unknown> {
    const value = step.value ? (step.value.kind === 'env' ? { fromEnv: step.value.name } : isSensitiveTarget(step.target) ? MASK : step.value.value) : undefined;
    return { n: step.n, action: step.action, target: step.locator ? `page.${step.locator}` : undefined, value, result: step.result, error: step.error, page: step.page };
}
