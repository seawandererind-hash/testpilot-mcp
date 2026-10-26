/**
 * Reads plain-language test steps ("Click Sign in", "Enter the email of the standard user",
 * "Error message "Invalid password" is shown") into intents the code generators understand.
 * Anything it cannot read confidently becomes an `unknown` intent, which the generators turn
 * into a TODO for the AI (or a person) to finish, never a guess that silently passes.
 */

export type ActionIntent =
    | { kind: 'open'; target: string; path?: string }
    | { kind: 'login'; role: string }
    | { kind: 'logout' }
    | { kind: 'fill'; field: string; value: ValueSource }
    | { kind: 'clear'; field: string }
    | { kind: 'select'; field: string; option: string }
    | { kind: 'check'; name: string; checked: boolean }
    | { kind: 'click'; name: string; role?: string; within?: string }
    | { kind: 'press'; key: string }
    | { kind: 'hover'; name: string }
    | { kind: 'search'; text: string }
    | { kind: 'reload' }
    | { kind: 'back' }
    | { kind: 'wait'; text: string }
    | { kind: 'unknown'; text: string };

export type ValueSource = { kind: 'literal'; value: string } | { kind: 'env'; name: string } | { kind: 'todo'; hint: string };

export type CheckIntent =
    | { kind: 'text'; text: string; visible: boolean }
    | { kind: 'heading'; name: string }
    | { kind: 'title'; text: string; exact: boolean }
    | { kind: 'url'; part: string }
    | { kind: 'count'; name: string; value: string }
    | { kind: 'state'; name: string; role?: string; state: 'enabled' | 'disabled' | 'visible' | 'hidden' | 'checked' | 'unchecked' }
    | { kind: 'unknown'; text: string };

const THIRD_PERSON: Record<string, string> = {
    clicks: 'click', taps: 'tap', presses: 'press', enters: 'enter', types: 'type', inputs: 'input', fills: 'fill', opens: 'open', navigates: 'navigate', visits: 'visit', goes: 'go', selects: 'select', chooses: 'choose', picks: 'pick', checks: 'check', unchecks: 'uncheck', ticks: 'tick', logs: 'log', signs: 'sign', searches: 'search', submits: 'submit', adds: 'add', removes: 'remove', hovers: 'hover', leaves: 'leave', refreshes: 'refresh', reloads: 'reload', launches: 'launch', provides: 'provide', sets: 'set', clears: 'clear', returns: 'return', accesses: 'access', loads: 'load'
};

const QUOTED = /["“”‘’']([^"“”‘’']{1,200})["“”‘’']/g;

/** Strips Gherkin keywords, "the user", trailing periods and turns "clicks" into "click". */
export function normaliseStep(text: string): string {
    let s = text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.;]+$/, '')
        .replace(/^(given|when|then|and|but)\s+/i, '')
        .replace(/^(?:the\s+)?(?:user|customer|admin|tester|i|we)\s+(?:should\s+|can\s+|will\s+|must\s+)?/i, '');
    const first = s.split(' ')[0]?.toLowerCase();
    if (first && THIRD_PERSON[first]) s = THIRD_PERSON[first] + s.slice(first.length);
    return s.replace(/^(?:please\s+|now\s+)/i, '');
}

export function quotedIn(text: string): string[] {
    return [...text.matchAll(QUOTED)].map(m => m[1].trim()).filter(Boolean);
}

const FIELD_NOUNS = /\b(e-?mail(?: address)?|user ?name|username|login|password|pass ?code|pin|first name|last name|full name|name|phone(?: number)?|mobile(?: number)?|address|city|zip(?: code)?|post ?code|search|quantity|amount|comment|message|description|title|otp|code|card number|cvv|expiry(?: date)?|date)\b/i;

function cleanName(s: string): string {
    return s
        .replace(QUOTED, '$1')
        .replace(/^(?:the|a|an|on|at|to)\s+/i, '')
        .replace(/\s+(?:button|link|tab|icon|menu item|menu|option|field|box|text ?box|input|dropdown|drop-down|checkbox|check box|toggle|switch)$/i, '')
        .replace(/[.:]+$/, '')
        .trim();
}

function valueFor(field: string, step: string, data?: string): ValueSource {
    const quoted = quotedIn(step).filter(q => q.toLowerCase() !== field.toLowerCase());
    // "${TEST_USER_PASSWORD}" names a .env key; the value itself is never in the case.
    const envRef = [...quoted, data?.trim() ?? ''].map(q => q.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/)).find(Boolean);
    if (envRef) return { kind: 'env', name: envRef[1] };
    const isPassword = /pass ?word|passcode|\bpin\b/i.test(field);
    const isEmail = /e-?mail|user ?name|login/i.test(field);
    if (quoted.length && !/\[REDACTED\]/.test(quoted[0])) return { kind: 'literal', value: quoted[0] };
    if (data && data.trim() && !/\[REDACTED\]/.test(data) && !/^(valid|correct|registered|test)\b/i.test(data.trim())) {
        const kv = data.match(new RegExp(`${field.split(' ')[0]}\\s*[:=]\\s*([^,;\\n]+)`, 'i'));
        return { kind: 'literal', value: (kv?.[1] ?? data).trim() };
    }
    if (isPassword && !/\b(wrong|invalid|incorrect|bad)\b/i.test(step)) return { kind: 'env', name: 'TEST_USER_PASSWORD' };
    if (isEmail && !/\b(wrong|invalid|incorrect|bad|unregistered|unknown)\b/i.test(step)) return { kind: 'env', name: 'TEST_USER_EMAIL' };
    return { kind: 'todo', hint: `value for ${field}` };
}

/** Reads one action step. */
export function parseAction(raw: string, data?: string): ActionIntent[] {
    const step = normaliseStep(raw);
    let m: RegExpMatchArray | null;

    if (/^(?:log ?out|sign ?out|logout)\b/i.test(step)) return [{ kind: 'logout' }];
    if ((m = step.match(/^(?:log ?in|sign ?in|login|signin)(?:\s+(?:as|with|using)\s+(?:an?\s+|the\s+)?(.+?))?(?:\s+(?:user|account|credentials|role))?$/i))) {
        const who = (m[1] ?? 'standard').toLowerCase().replace(/\s+(user|account|credentials)$/, '');
        return [{ kind: 'login', role: /^(valid|correct|registered|existing|normal|default|test)$/.test(who) ? 'standard' : who.replace(/[^a-z0-9]+/g, '-') }];
    }
    if ((m = step.match(/^(?:open|go to|navigate to|visit|launch|browse to|access|load|return to|go back to)\s+(?:the\s+)?(.+?)$/i))) {
        const target = m[1].replace(/\s+(?:page|screen|url|site|website|tab)$/i, '').trim();
        const url = target.match(/(https?:\/\/\S+|\/[\w\-./?=&%#]*)/);
        return [{ kind: 'open', target: cleanName(target), path: url ? url[1] : undefined }];
    }
    if (/^(?:refresh|reload)\b/i.test(step)) return [{ kind: 'reload' }];
    if (/^(?:go back|navigate back|press (?:the )?back)\b/i.test(step)) return [{ kind: 'back' }];
    if ((m = step.match(/^wait\b(.*)$/i))) return [{ kind: 'wait', text: m[1].trim() }];
    if ((m = step.match(/^(?:leave|keep)\s+(?:the\s+)?(.+?)\s+(?:field\s+)?(?:empty|blank)$/i))) return [{ kind: 'clear', field: cleanName(m[1]) }];
    if ((m = step.match(/^(?:clear)\s+(?:the\s+)?(.+?)$/i))) return [{ kind: 'clear', field: cleanName(m[1]) }];
    if ((m = step.match(/^(?:select|choose|pick)\s+(["“'].+?["”']|.+?)\s+(?:from|in)\s+(?:the\s+)?(.+?)$/i))) {
        return [{ kind: 'select', option: cleanName(m[1]), field: cleanName(m[2]) }];
    }
    if ((m = step.match(/^(check|tick|enable|uncheck|untick|disable)\s+(?:the\s+)?(.+?)\s*(?:checkbox|check box|toggle|switch|option)$/i))) {
        return [{ kind: 'check', name: cleanName(m[2]), checked: /^(check|tick|enable)$/i.test(m[1]) }];
    }
    if ((m = step.match(/^search(?:\s+for)?\s+(.+?)$/i))) return [{ kind: 'search', text: quotedIn(m[1])[0] ?? cleanName(m[1]) }];
    if ((m = step.match(/^(?:press|hit)\s+(?:the\s+)?(enter|return|tab|escape|esc|space|backspace|delete|arrow ?(?:up|down|left|right))(?:\s+key)?$/i))) {
        const key = m[1].toLowerCase().replace(/^esc$/, 'escape').replace(/^return$/, 'enter').replace(/^arrow ?(\w+)$/, 'arrow$1');
        return [{ kind: 'press', key: key.charAt(0).toUpperCase() + key.slice(1).replace(/(up|down|left|right)$/, s => s.charAt(0).toUpperCase() + s.slice(1)) }];
    }
    if ((m = step.match(/^(?:hover|mouse ?over|move the mouse)\s+(?:over|on|to)?\s*(?:the\s+)?(.+)$/i))) return [{ kind: 'hover', name: cleanName(m[1]) }];

    // Fill: "Enter "x" in the Email field", "Type the email of the standard user", "Enter valid email and password".
    if ((m = step.match(/^(?:enter|type|input|fill(?: in)?|provide|key in|set|write|insert)\s+(.+?)\s+(?:in|into|on|in to)\s+(?:the\s+)?(.+?)$/i))) {
        const field = cleanName(m[2]);
        return [{ kind: 'fill', field, value: valueFor(field, step, data) }];
    }
    if ((m = step.match(/^(?:enter|type|input|fill(?: in)?|provide|key in|set)\s+(.+)$/i))) {
        const rest = m[1];
        const parts = rest.split(/\s+(?:and|&)\s+/i);
        const fields = parts.map(p => p.match(FIELD_NOUNS)?.[1]);
        if (parts.length > 1 && fields.every(Boolean)) return fields.map(f => ({ kind: 'fill' as const, field: capitalise(f!), value: valueFor(f!, rest, data) }));
        const noun = rest.match(FIELD_NOUNS)?.[1];
        if (noun) return [{ kind: 'fill', field: capitalise(noun), value: valueFor(noun, step, data) }];
        return [{ kind: 'unknown', text: raw }];
    }

    // Click: "Click Add to cart on Red shoes", "Tap the Sign in button", "Select the Products tab".
    if ((m = step.match(/^(?:click|tap|press|hit|select|choose|submit|open)\s+(?:on\s+)?(?:the\s+)?(.+?)$/i))) {
        let target = m[1];
        let within: string | undefined;
        const ctx = target.match(/^(.+?)\s+(?:on|for|next to|in the row of|of)\s+(?:the\s+)?(.+)$/i);
        if (ctx && !/\b(page|screen)$/i.test(ctx[2])) {
            target = ctx[1];
            within = cleanName(ctx[2]);
        }
        const roleWord = target.match(/\b(button|link|tab|icon|menu item|menu|option|checkbox|radio(?: button)?)$/i)?.[1]?.toLowerCase();
        const role = roleWord ? ({ 'menu item': 'menuitem', menu: 'menuitem', icon: 'button', 'radio button': 'radio' } as Record<string, string>)[roleWord] ?? roleWord : undefined;
        const name = cleanName(target);
        if (!name) return [{ kind: 'unknown', text: raw }];
        return [{ kind: 'click', name, role, within }];
    }
    if (/^(?:add|remove|delete|save|create|update|edit|submit|confirm|accept|cancel|close|book|buy|pay|send|apply|register|sign up)\b/i.test(step) && quotedIn(step).length === 0 && step.split(' ').length <= 4) {
        // "Save", "Add to cart", "Confirm order": a button with that text.
        return [{ kind: 'click', name: capitalise(step) }];
    }
    return [{ kind: 'unknown', text: raw }];
}

function capitalise(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Reads one expected result into checks. */
export function parseCheck(raw: string): CheckIntent[] {
    const text = normaliseStep(raw).replace(/^(?:verify|check|ensure|confirm|validate|assert|observe|see)\s+(?:that\s+)?/i, '');
    const quoted = quotedIn(text);
    let m: RegExpMatchArray | null;
    if ((m = text.match(/\btitle\s+(?:is|should be|equals|=)\s+["“'](.+?)["”']/i))) return [{ kind: 'title', text: m[1], exact: true }];
    if ((m = text.match(/\btitle\s+(?:contains|includes|has)\s+["“'](.+?)["”']/i))) return [{ kind: 'title', text: m[1], exact: false }];
    if ((m = text.match(/\b(?:url|address)\s+(?:is|contains|should contain|includes|ends with|has)\s+["“']?(\S+?)["”']?$/i))) return [{ kind: 'url', part: m[1] }];
    if ((m = text.match(/^(?:the\s+)?(.+?)\s+(?:count|counter|badge|number|total|quantity)\s+(?:shows|is|displays|equals|becomes|=|should be|reads)\s+["“']?([\w.,$€£%-]+)["”']?$/i))) {
        return [{ kind: 'count', name: cleanName(m[1]), value: m[2] }];
    }
    if ((m = text.match(/^(?:the\s+)?(.+?)\s+(button|link|checkbox|field)?\s*(?:is|should be|becomes)\s+(enabled|disabled|checked|unchecked|hidden|not (?:visible|displayed|shown)|invisible)$/i))) {
        const state = m[3].toLowerCase().startsWith('not') || m[3].toLowerCase() === 'invisible' ? 'hidden' : (m[3].toLowerCase() as 'enabled' | 'disabled' | 'checked' | 'unchecked' | 'hidden');
        return [{ kind: 'state', name: cleanName(m[1]), role: m[2]?.toLowerCase(), state }];
    }
    if (quoted.length) {
        const hidden = /\b(not|no longer|never)\b.*\b(shown|displayed|visible|appear)/i.test(text) || /\bdisappears?\b/i.test(text);
        return quoted.map(q => ({ kind: 'text' as const, text: q, visible: !hidden }));
    }
    if ((m = text.match(/^(?:the\s+|a\s+)?(.+?)\s+(?:page|screen)\s+(?:is\s+|should be\s+|gets\s+)?(?:displayed|shown|opened|opens|visible|loaded|appears|is open)(?:\b.*)?$/i))) {
        return [{ kind: 'heading', name: cleanName(m[1]) }];
    }
    if ((m = text.match(/^(?:user\s+)?(?:is\s+)?(?:redirected|navigated|taken|sent)\s+to\s+(?:the\s+)?(.+?)(?:\s+(?:page|screen))?$/i))) return [{ kind: 'heading', name: cleanName(m[1]) }];
    return [{ kind: 'unknown', text: raw }];
}
