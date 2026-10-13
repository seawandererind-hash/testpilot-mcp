/**
 * Auto mode: reads a test case with the existing step parser and maps each step to a
 * live_test action on the elements the page shows right now. It only maps what it can
 * match confidently; anything else is handed back to the AI.
 */
import type { TestCase } from '../core/schema.js';
import type { ExploredElement } from '../explore/web.js';
import { type ActionIntent, type CheckIntent, parseAction, parseCheck } from '../generate/intents.js';
import type { LiveStepInput } from './protocol.js';

export interface CaseItem {
    /** The case text this came from. */
    text: string;
    kind: 'action' | 'check';
    intent: ActionIntent | CheckIntent;
}

/** The case's steps and expected results, in order, as parsed intents. */
export function caseItems(tc: TestCase): CaseItem[] {
    const items: CaseItem[] = [];
    for (const step of tc.steps) {
        for (const intent of parseAction(step.action, step.data)) items.push({ text: step.action, kind: 'action', intent });
        if (step.expected?.trim()) for (const intent of parseCheck(step.expected)) items.push({ text: step.expected, kind: 'check', intent });
    }
    if (tc.expected?.trim()) for (const intent of parseCheck(tc.expected)) items.push({ text: tc.expected, kind: 'check', intent });
    return items;
}

export type Plan = { kind: 'steps'; steps: LiveStepInput[]; note?: string } | { kind: 'skip'; note: string } | { kind: 'help'; reason: string };

const CLICKABLE = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch'];
const FIELDS = ['textbox', 'searchbox', 'combobox', 'spinbutton'];

/** Finds one element by name: an exact (case-insensitive) match, or the only partial match. Undefined when unsure. */
export function matchElement(name: string, roles: string[], elements: ExploredElement[]): ExploredElement | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    const pool = elements.filter(e => roles.includes(e.role));
    const exact = pool.filter(e => e.name.trim().toLowerCase() === n);
    if (exact.length === 1) return exact[0].count === 1 ? exact[0] : undefined;
    if (exact.length > 1) return undefined;
    const partial = pool.filter(e => {
        const en = e.name.trim().toLowerCase();
        return (en.includes(n) && n.length >= 3) || (n.includes(en) && en.length >= 3);
    });
    return partial.length === 1 && partial[0].count === 1 ? partial[0] : undefined;
}

const target = (e: ExploredElement) => ({ role: e.role, name: e.name });

/** Maps one parsed case item to live steps on the current page. */
export function planItem(item: CaseItem, elements: ExploredElement[], ctx: { isFirst: boolean; atStart: boolean; startUrl: string }): Plan {
    const i = item.intent;
    if (item.kind === 'action') {
        const a = i as ActionIntent;
        switch (a.kind) {
            case 'open': {
                if (a.path) return { kind: 'steps', steps: [{ action: 'goto', value: a.path }] };
                if (/^(?:the\s+)?(app|application|site|web ?site|home ?page|home|start page|landing page|login|log ?in|sign ?in)$/i.test(a.target)) {
                    return ctx.atStart ? { kind: 'skip', note: 'The start page is already open.' } : { kind: 'steps', steps: [{ action: 'goto', value: ctx.startUrl }] };
                }
                const link = matchElement(a.target, ['link', 'tab', 'menuitem'], elements);
                if (link) return { kind: 'steps', steps: [{ action: 'click', target: target(link) }], note: `Opened "${a.target}" through its link.` };
                return { kind: 'help', reason: `Do not know the address of "${a.target}". Use step with goto and the path, or click the link that opens it.` };
            }
            case 'login': {
                if (a.role !== 'standard') return { kind: 'help', reason: `Signing in as "${a.role}" needs that user's .env keys. Do it with step (fill with valueFromEnv) and say which keys hold that user's login.` };
                const user = elements.find(e => FIELDS.includes(e.role) && /e-?mail|user ?name|login/i.test(e.name));
                const pwd = elements.find(e => FIELDS.includes(e.role) && /pass ?word/i.test(e.name));
                const submit = elements.find(e => e.role === 'button' && /sign ?in|log ?in|continue|submit/i.test(e.name));
                if (!user || !pwd || !submit) return { kind: 'help', reason: 'Could not find the login form (email, password and sign-in button) on this page.' };
                return {
                    kind: 'steps',
                    steps: [
                        { action: 'fill', target: target(user), valueFromEnv: 'TEST_USER_EMAIL' },
                        { action: 'fill', target: target(pwd), valueFromEnv: 'TEST_USER_PASSWORD' },
                        { action: 'click', target: target(submit) }
                    ]
                };
            }
            case 'fill':
            case 'clear': {
                const field = matchElement(a.field, FIELDS, elements);
                if (!field) return { kind: 'help', reason: `Could not find one field named "${a.field}" on this page.` };
                if (a.kind === 'clear') return { kind: 'steps', steps: [{ action: 'fill', target: target(field), value: '' }] };
                if (a.value.kind === 'todo') return { kind: 'help', reason: `The case does not say what to type in "${a.field}". Ask the user or use a .env key.` };
                return { kind: 'steps', steps: [a.value.kind === 'env' ? { action: 'fill', target: target(field), valueFromEnv: a.value.name } : { action: 'fill', target: target(field), value: a.value.value }] };
            }
            case 'select': {
                const field = matchElement(a.field, ['combobox', 'listbox'], elements);
                if (!field) return { kind: 'help', reason: `Could not find one dropdown named "${a.field}".` };
                return { kind: 'steps', steps: [{ action: 'select', target: target(field), value: a.option }] };
            }
            case 'check': {
                const box = matchElement(a.name, ['checkbox', 'switch', 'radio'], elements);
                if (!box) return { kind: 'help', reason: `Could not find one checkbox named "${a.name}".` };
                return { kind: 'steps', steps: [{ action: a.checked ? 'check' : 'uncheck', target: target(box) }] };
            }
            case 'click': {
                if (a.within) return { kind: 'help', reason: `"${a.name}" has to be clicked inside "${a.within}"; pick the right one with step (role + name, and nth if there are several).` };
                const el = matchElement(a.name, a.role ? [a.role] : CLICKABLE, elements);
                if (!el) return { kind: 'help', reason: `Could not find exactly one thing named "${a.name}" to click.` };
                return { kind: 'steps', steps: [{ action: 'click', target: target(el) }] };
            }
            case 'hover': {
                const el = matchElement(a.name, [...CLICKABLE, 'heading'], elements);
                if (!el) return { kind: 'help', reason: `Could not find exactly one "${a.name}" to hover.` };
                return { kind: 'steps', steps: [{ action: 'hover', target: target(el) }] };
            }
            case 'press':
                return { kind: 'steps', steps: [{ action: 'press', value: a.key }] };
            case 'search': {
                const box = elements.find(e => e.role === 'searchbox') ?? matchElement('search', FIELDS, elements);
                if (!box) return { kind: 'help', reason: 'Could not find a search box.' };
                return { kind: 'steps', steps: [{ action: 'fill', target: target(box), value: a.text }, { action: 'press', target: target(box), value: 'Enter' }] };
            }
            default:
                return { kind: 'help', reason: `Could not turn "${item.text}" into a browser action.` };
        }
    }
    const c = i as CheckIntent;
    switch (c.kind) {
        case 'text':
            if (!c.visible) return { kind: 'help', reason: `Checking that "${c.text}" is not shown is not automated here; check it with step.` };
            return { kind: 'steps', steps: [{ action: 'expectText', value: c.text }] };
        case 'heading': {
            const h = matchElement(c.name, ['heading'], elements);
            if (!h) return { kind: 'help', reason: `No heading like "${c.name}" on the page now. Look at the screenshot and check with step.` };
            return { kind: 'steps', steps: [{ action: 'expectVisible', target: target(h) }] };
        }
        case 'url':
            return { kind: 'steps', steps: [{ action: 'expectUrl', value: c.part }] };
        case 'state': {
            if (c.state !== 'visible') return { kind: 'help', reason: `Checking that "${c.name}" is ${c.state} needs a manual step.` };
            const el = matchElement(c.name, c.role ? [c.role] : [...CLICKABLE, ...FIELDS, 'heading'], elements);
            if (!el) return { kind: 'help', reason: `Could not find "${c.name}".` };
            return { kind: 'steps', steps: [{ action: 'expectVisible', target: target(el) }] };
        }
        default:
            return { kind: 'help', reason: `Could not turn the expected result "${item.text}" into a check.` };
    }
}
