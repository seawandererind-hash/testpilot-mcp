import type { TestCase } from '../core/schema.js';

/**
 * Finds personal data in imported test cases: real-looking emails, phone numbers,
 * card numbers (Luhn-valid), IBANs (mod-97 valid) and national-id-like values.
 * Findings carry a masked value only; the full value is never returned.
 */

export type PiiKind = 'email' | 'phone' | 'card-number' | 'iban' | 'national-id';

export interface PiiFinding {
    caseId: string;
    field: string;
    kind: PiiKind;
    masked: string;
}

const SAFE_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

/** Luhn checksum, used by payment card numbers. */
export function luhnValid(digits: string): boolean {
    if (!/^\d{12,19}$/.test(digits)) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (double) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}

/** ISO 13616 mod-97 check of an IBAN (spaces allowed). */
export function ibanValid(raw: string): boolean {
    const iban = raw.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
        const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
        for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    return remainder === 1;
}

/** Keeps only the last two characters of letters and digits, so the value cannot be read back. */
export function mask(value: string, kind: PiiKind): string {
    if (kind === 'email') {
        const [local, domain] = value.split('@');
        const tld = domain.split('.').pop() ?? '';
        return `${local[0]}***@***.${tld}`;
    }
    const chars = [...value];
    const significant = chars.map((c, i) => (/[A-Za-z0-9]/.test(c) ? i : -1)).filter(i => i >= 0);
    const keep = new Set(significant.slice(-2));
    return chars.map((c, i) => (/[A-Za-z0-9]/.test(c) && !keep.has(i) ? '*' : c)).join('');
}

const PATTERNS: Array<{ kind: PiiKind; re: RegExp; valid?: (match: string) => boolean }> = [
    { kind: 'email', re: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, valid: m => !SAFE_EMAIL_DOMAIN.test(m.split('@')[1]) },
    { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, valid: ibanValid },
    { kind: 'card-number', re: /\b\d(?:[ -]?\d){11,18}\b/g, valid: m => luhnValid(m.replace(/\D/g, '')) },
    // US SSN (not 000/666/9xx area), UK National Insurance number, Indian PAN and Aadhaar.
    { kind: 'national-id', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
    { kind: 'national-id', re: /\b(?![DFIQUV])[A-CEGHJ-PR-TW-Z](?![DFIQUVO])[A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g },
    { kind: 'national-id', re: /\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b/g },
    { kind: 'national-id', re: /(?<!\d[ -]?)[2-9]\d{3} \d{4} \d{4}(?![ -]?\d)/g },
    // International (+44 …, 0044 …) or national numbers with 9 to 15 digits; plain short numbers and dates are ignored.
    { kind: 'phone', re: /(?:\+|\b00)\d[\d ().-]{7,18}\d\b|\(?\b0\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{3,4}\b|\(\d{3}\) ?\d{3}-\d{4}\b/g, valid: m => {
        const digits = m.replace(/\D/g, '');
        return digits.length >= 9 && digits.length <= 15;
    } }
];

/** Scans one text; overlapping matches count once (the first, most specific kind wins). */
export function scanText(text: string): Array<{ kind: PiiKind; masked: string }> {
    const taken: Array<[number, number]> = [];
    const out: Array<{ kind: PiiKind; masked: string }> = [];
    for (const { kind, re, valid } of PATTERNS) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
            const start = m.index ?? 0;
            const end = start + m[0].length;
            if (taken.some(([s, e]) => start < e && end > s)) continue;
            if (valid && !valid(m[0])) continue;
            taken.push([start, end]);
            out.push({ kind, masked: mask(m[0], kind) });
        }
    }
    return out;
}

/** Every text field of a test case, named the way the report shows it. */
function fields(tc: TestCase): Array<[string, string]> {
    const out: Array<[string, string]> = [['title', tc.title]];
    if (tc.description) out.push(['description', tc.description]);
    tc.preconditions.forEach((p, i) => out.push([`preconditions[${i + 1}]`, p]));
    tc.steps.forEach((s, i) => {
        out.push([`steps[${i + 1}].action`, s.action]);
        if (s.data) out.push([`steps[${i + 1}].data`, s.data]);
        if (s.expected) out.push([`steps[${i + 1}].expected`, s.expected]);
    });
    if (tc.expected) out.push(['expected', tc.expected]);
    if (tc.testData) out.push(['testData', tc.testData]);
    return out;
}

export function scanCases(cases: TestCase[]): PiiFinding[] {
    const findings: PiiFinding[] = [];
    for (const tc of cases) {
        for (const [field, text] of fields(tc)) {
            for (const hit of scanText(text)) findings.push({ caseId: tc.id, field, ...hit });
        }
    }
    return findings;
}

export const PII_ADVICE: Record<PiiKind, string> = {
    email: 'use buildUser().email from test-data/factory (unique @example.com addresses)',
    phone: 'use buildUser().phone (fictional 555 numbers)',
    'card-number': "use your payment provider's published test card numbers, kept in test-data",
    iban: "use your bank or payment provider's documented test IBANs",
    'national-id': 'use a made-up value in the right format from the factory, never a real person\'s id'
};
