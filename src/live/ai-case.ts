/**
 * No-key mode for plain-English AI tests: reads a Midscene case file and turns its steps
 * into live_test case items, so the AI in the chat (Cursor, Claude Code, Antigravity) is
 * the brain instead of a separate vision model. Simple steps are matched automatically;
 * anything else is handed to the chat AI with a short instruction.
 */
import YAML from 'yaml';

import { AI_FOLDER, aiRoot } from '../ai/midscene.js';
import type { Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { type ActionIntent, parseAction, parseCheck } from '../generate/intents.js';
import type { CaseItem } from './auto.js';

export interface AiDrive {
    /** Repository-relative case file. */
    file: string;
    /** The case name inside the file. */
    name: string;
    items: CaseItem[];
}

const SEVERAL = /\b(and|then|after that|afterwards)\b|[,;]/i;
const ENV_VALUE = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

const DO_IT = 'Do it with live_test action "step", one action at a time, choosing targets from the element list (live_test "snapshot" with image: true shows you the screen).';
const CHECK_IT = 'Look at the page, then record the check with live_test "step": expectText (value = text on the page), expectVisible (target) or expectUrl (value = part of the address).';

/** Finds the case file: "cases/web/x.yaml", "ai-tests/cases/web/x.yaml" or just "x". */
export function resolveAiFile(store: ProjectStore, config: Config, file: string): string | undefined {
    const root = aiRoot(config);
    const clean = file.replace(/\\/g, '/').replace(/^\.\//, '');
    if (clean.split('/').includes('..')) return undefined;
    const bare = clean.replace(/\.(ya?ml)$/i, '');
    const candidates = [clean, `${root}/${clean.replace(new RegExp(`^${AI_FOLDER}/`), '')}`, `${root}/cases/web/${bare}.yaml`, `${root}/cases/web/${bare}.yml`];
    return candidates.find(c => /\.ya?ml$/i.test(c) && store.exists(c));
}

type Node = Record<string, unknown>;

/** Loads one case of a Midscene file (Midscene Test "cases/steps" or Midscene's own "tasks/flow"). */
export function loadAiDrive(store: ProjectStore, config: Config, file: string, caseName?: string): AiDrive | { error: string } {
    const path = resolveAiFile(store, config, file);
    if (!path) return { error: `No AI case file ${file}. ai_tests action "status" lists them (they are in ${aiRoot(config)}/cases/web/).` };
    if (/\/cases\/(android|ios|harmony|computer)\//.test(path)) return { error: `${path} is for a phone or desktop app. Using the chat's own AI works for websites only for now; phone and desktop AI tests need a model key (ai_tests action "models").` };
    let doc: { cases?: Array<{ name?: string; steps?: Node[] }>; tasks?: Array<{ name?: string; flow?: Node[] }> };
    try {
        doc = (YAML.parse(store.read(path) ?? '') ?? {}) as typeof doc;
    } catch (e) {
        return { error: `${path} is not valid YAML: ${(e as Error).message.split('\n')[0]}` };
    }
    const cases = [...(doc.cases ?? []).map(c => ({ name: String(c.name ?? ''), steps: c.steps ?? [] })), ...(doc.tasks ?? []).map(t => ({ name: String(t.name ?? ''), steps: t.flow ?? [] }))];
    if (!cases.length) return { error: `${path} has no cases.` };
    const wanted = caseName?.trim().toLowerCase();
    const picked = wanted ? (cases.find(c => c.name.toLowerCase() === wanted) ?? cases.find(c => c.name.toLowerCase().startsWith(wanted)) ?? cases.find(c => c.name.toLowerCase().includes(wanted))) : cases[0];
    if (!picked) return { error: `${path} has no case named "${caseName}". Its cases: ${cases.map(c => `"${c.name}"`).join(', ')}.` };
    return { file: path, name: picked.name || 'ai-case', items: picked.steps.flatMap(aiNodeItems) };
}

const help = (text: string, reason: string): CaseItem => ({ text, kind: 'action', intent: { kind: 'unknown', text }, help: reason });
const skip = (text: string, note: string): CaseItem => ({ text, kind: 'action', intent: { kind: 'unknown', text }, skip: note });

function promptOf(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if (typeof v.prompt === 'string') return v.prompt.trim();
        if (typeof v.locate === 'string') return v.locate.trim();
    }
    return '';
}

function actions(text: string, raw: string): CaseItem[] {
    if (!text) return [help(raw, 'This step has no words.')];
    if (SEVERAL.test(text)) return [help(text, `This plain-English step has several actions. ${DO_IT}`)];
    const intents = parseAction(text);
    if (intents.some(i => i.kind === 'unknown' || i.kind === 'wait' || i.kind === 'logout')) return [help(text, DO_IT)];
    return intents.map(intent => ({ text, kind: 'action' as const, intent }));
}

function checks(text: string): CaseItem[] {
    if (!text) return [help('check', 'This check has no words.')];
    if (SEVERAL.test(text)) return [help(text, `This check says several things. ${CHECK_IT}`)];
    const intents = parseCheck(text);
    if (!intents.length || intents.some(i => i.kind === 'unknown')) return [help(text, CHECK_IT)];
    return intents.map(intent => ({ text, kind: 'check' as const, intent }));
}

/** One Midscene YAML step to zero or more case items. */
export function aiNodeItems(node: Node): CaseItem[] {
    const [key, value] = Object.entries(node ?? {})[0] ?? ['', undefined];
    const text = promptOf(value);
    switch (key) {
        case 'gotoUrl':
        case 'url': {
            const target = text || '/';
            const intent: ActionIntent = { kind: 'open', target, path: target };
            return [{ text: `Open ${target}`, kind: 'action', intent }];
        }
        case 'aiAct':
        case 'aiAction':
        case 'ai':
            return actions(text, key);
        case 'aiTap':
            return text && !SEVERAL.test(text) ? actions(`Click ${text}`, key) : [help(text || key, DO_IT)];
        case 'aiInput': {
            const v = (value ?? {}) as Record<string, unknown>;
            const field = promptOf(v) || (typeof v.locate === 'string' ? v.locate : '');
            const typed = v.value === undefined ? undefined : String(v.value);
            const label = `Type into ${field || 'a field'}`;
            if (!field || typed === undefined) return [help(label, DO_IT)];
            const env = typed.match(ENV_VALUE);
            const intent: ActionIntent = { kind: 'fill', field: field.replace(/^(the|a|an)\s+/i, '').replace(/\s+(field|box|input)$/i, ''), value: env ? { kind: 'env', name: env[1] } : { kind: 'literal', value: typed } };
            return [{ text: `${label}: ${env ? `.env ${env[1]}` : `"${typed}"`}`, kind: 'action', intent }];
        }
        case 'aiKeyboardPress': {
            const v = (value ?? {}) as Record<string, unknown>;
            const keyName = typeof value === 'string' ? value : String(v.keyName ?? '');
            if (!keyName || v.locate || v.prompt) return [help(`Press ${keyName || 'a key'}`, DO_IT)];
            return [{ text: `Press ${keyName}`, kind: 'action', intent: { kind: 'press', key: keyName } }];
        }
        case 'aiAssert':
        case 'aiWaitFor':
            return checks(text);
        case 'aiQuery':
        case 'aiAsk':
        case 'aiString':
        case 'aiNumber':
        case 'aiBoolean':
            return [help(text || key, 'This step reads information off the screen. Look at the page (live_test "snapshot", image: true) and tell the user the answer. To keep it as a check in the saved test, record an expectText step with the value you saw.')];
        case 'aiScroll':
            return [help(text || 'Scroll', 'Scrolling is usually not needed: Playwright scrolls to an element by itself. Carry on with the next step, or use "hover" on the element to bring it into view.')];
        case 'sleep':
        case 'wait':
            return [skip('Wait', 'Not needed: the recorded test waits for each element by itself.')];
        case 'recordToReport':
        case 'logScreenshot':
            return [skip(text || 'Note', 'A note for the report; nothing to do in the browser.')];
        default:
            return [help(text || key || 'step', `"${key}" is not a website step TestPilot knows. ${DO_IT}`)];
    }
}

