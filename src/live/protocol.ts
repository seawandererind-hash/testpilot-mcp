/**
 * The newline-delimited JSON protocol between the server and the live browser process,
 * plus the small pure helpers both sides of live_test share (locators, risky clicks,
 * sensitive fields). Nothing here touches a browser, so it is unit-testable.
 */
import { quote } from '../explore/web.js';

export const LIVE_ACTIONS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover', 'expectVisible', 'expectText', 'expectUrl'] as const;
export type LiveAction = (typeof LIVE_ACTIONS)[number];

/** What to act on. Role + name is preferred; css is the last resort. */
export interface LiveTarget {
    role?: string;
    name?: string;
    exact?: boolean;
    label?: string;
    placeholder?: string;
    text?: string;
    testId?: string;
    css?: string;
    nth?: number;
}

/** One action the AI (or auto mode) asks for. */
export interface LiveStepInput {
    action: LiveAction;
    target?: LiveTarget;
    /** Literal value (text to type, option, key, URL, expected text). */
    value?: string;
    /** Name of a .env key whose value is used instead; the value never leaves the server. */
    valueFromEnv?: string;
    timeoutMs?: number;
}

export type LiveCommand =
    | { id: number; op: 'snapshot'; label?: string }
    | { id: number; op: 'step'; action: LiveAction; target?: LiveTarget; value?: string; timeoutMs?: number; label?: string }
    | { id: number; op: 'close' };

/** What the browser process sends back after starting and after every command. */
export interface DriverReply {
    id: number;
    ok: boolean;
    error?: string;
    fatal?: string;
    ready?: boolean;
    closed?: boolean;
    headed?: boolean;
    headedFallback?: string;
    url?: string;
    title?: string;
    snapshot?: string;
    testIds?: Array<{ attr: string; value: string; tag: string; text: string }>;
    screenshot?: string;
}

export const LINE_PREFIX = '__TESTPILOT__';

export function encodeCommand(command: LiveCommand): string {
    return JSON.stringify(command) + '\n';
}

/** Reads one stdout line from the browser process. Anything that is not a protocol line (logs, warnings) is ignored. */
export function parseDriverLine(line: string): DriverReply | undefined {
    const at = line.indexOf(LINE_PREFIX);
    if (at < 0) return undefined;
    try {
        const parsed = JSON.parse(line.slice(at + LINE_PREFIX.length).trim()) as Partial<DriverReply>;
        if (typeof parsed !== 'object' || parsed === null) return undefined;
        if (parsed.fatal) return { id: typeof parsed.id === 'number' ? parsed.id : 0, ok: false, ...parsed } as DriverReply;
        if (typeof parsed.id !== 'number' || typeof parsed.ok !== 'boolean') return undefined;
        return parsed as DriverReply;
    } catch {
        return undefined;
    }
}

/** Splits a byte stream into complete lines, keeping a partial last line for the next chunk. */
export class LineBuffer {
    private rest = '';

    push(chunk: string): string[] {
        const text = this.rest + chunk;
        const lines = text.split(/\r?\n/);
        this.rest = lines.pop() ?? '';
        return lines.filter(l => l.length > 0);
    }
}

/** True when a target uses only raw CSS, which breaks as soon as the page's markup changes. */
export function usesCss(target: LiveTarget | undefined): boolean {
    return Boolean(target?.css && !target.role && !target.label && !target.placeholder && !target.text && !target.testId);
}

export function hasTarget(target: LiveTarget | undefined): boolean {
    return Boolean(target && (target.role || target.label || target.placeholder || target.text || target.testId || target.css));
}

/** The Playwright locator for a target, without the leading `page.`, e.g. getByRole('button', { name: 'Sign in' }). */
export function locatorExpression(target: LiveTarget): string {
    const exact = target.exact ? ', exact: true' : '';
    const exactOnly = target.exact ? ', { exact: true }' : '';
    let expr: string;
    if (target.role) expr = target.name !== undefined ? `getByRole(${quote(target.role)}, { name: ${quote(target.name)}${exact} })` : `getByRole(${quote(target.role)})`;
    else if (target.label) expr = `getByLabel(${quote(target.label)}${exactOnly})`;
    else if (target.placeholder) expr = `getByPlaceholder(${quote(target.placeholder)}${exactOnly})`;
    else if (target.text) expr = `getByText(${quote(target.text)}${exactOnly})`;
    else if (target.testId) expr = `getByTestId(${quote(target.testId)})`;
    else if (target.css) expr = `locator(${quote(target.css)})`;
    else throw new Error('A target needs a role (with name), label, placeholder, text, testId or css.');
    return typeof target.nth === 'number' ? `${expr}.nth(${target.nth})` : expr;
}

/** A short human label for a target, for summaries. */
export function describeTarget(target: LiveTarget | undefined): string {
    if (!target) return 'the page';
    if (target.role) return `${target.role}${target.name !== undefined ? ` "${target.name}"` : ''}`;
    if (target.label) return `field labelled "${target.label}"`;
    if (target.placeholder) return `field with placeholder "${target.placeholder}"`;
    if (target.text) return `text "${target.text}"`;
    if (target.testId) return `test id "${target.testId}"`;
    return `css "${target.css}"`;
}

const RISKY = /\b(pay(?:\s+now)?|payment|place\s+(?:the\s+)?order|confirm\s+(?:the\s+)?(?:order|payment|purchase|transfer)|submit\s+(?:order|payment)|purchase|buy(?:\s+now)?|checkout\s+now|delete|remove|destroy|erase|send|transfer|wire|withdraw|refund|unsubscribe|deactivate|close\s+account|cancel\s+(?:account|subscription))\b/i;

/** True when clicking this looks like it pays, orders, deletes or sends something real. */
export function isRiskyTarget(target: LiveTarget | undefined): boolean {
    if (!target) return false;
    const words = [target.name, target.label, target.text, target.testId?.replace(/[-_]+/g, ' '), target.css?.replace(/[-_#.[\]="']+/g, ' ')].filter(Boolean).join(' | ');
    return RISKY.test(words);
}

const SENSITIVE = /(pass ?word|passcode|passwd|\bpwd\b|\bpin\b|secret|token|\botp\b|one[- ]time|\bcvv\b|\bcvc\b|security code|card ?number|api ?key)/i;

/** True when a field looks like it holds a password or another secret. */
export function isSensitiveTarget(target: LiveTarget | undefined): boolean {
    if (!target) return false;
    return SENSITIVE.test([target.name, target.label, target.placeholder, target.testId, target.css].filter(Boolean).join(' | '));
}

/** True for .env key names that hold secrets (their values are always shown as •••). */
export function isSecretKey(name: string): boolean {
    return /(PASS|TOKEN|SECRET|KEY|PWD|CREDENTIAL|AUTH|PIN|OTP|CVV)/i.test(name);
}

export const MASK = '•••';

/** Headed by default on a desktop; headless in CI and on Linux machines without a display. */
export function defaultHeaded(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
    if (env.CI) return false;
    if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
    return true;
}
