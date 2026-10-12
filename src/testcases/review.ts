import type { TestCase, Verdict } from '../core/schema.js';

/**
 * Heuristic review of test cases before automation. It is deliberately explainable:
 * every point lost comes with an issue the user can read and fix. The AI in the
 * client can add judgement on top, using these findings as a starting point.
 */

const VAGUE = /\b(properly|correctly|as expected|should work|works fine|working fine|appropriate(ly)?|etc\.?|and so on|some|any (error|message)|quickly|fast|user friendly|looks good|ok(ay)?|normal(ly)?|successful(ly)? (?!logged|created|saved|submitted|added|deleted|updated))\b/i;
const MANUAL_ONLY: Array<[RegExp, string]> = [
    [/\b(look and feel|visually (check|verify|inspect)|ui looks|aesthetic|pixel|alignment|font|colou?r scheme)\b/i, 'visual judgement'],
    [/\b(usability|user experience|intuitive|easy to use|exploratory)\b/i, 'usability or exploratory testing'],
    [/\b(captcha|recaptcha|hcaptcha)\b/i, 'CAPTCHA (cannot be automated; ask for a test bypass)'],
    [/\b(print(er|out)?|scan (the )?(document|barcode)|physical|unplug|bluetooth pairing|nfc|fingerprint|face ?id|biometric)\b/i, 'physical device interaction'],
    [/\b(phone call|call the (customer|user)|speak to|listen|audio quality)\b/i, 'human interaction or audio']
];
const NEEDS_HOOK: Array<[RegExp, string]> = [
    [/\b(otp|one[- ]time (password|code)|verification code|2fa|mfa|two[- ]factor|authenticator)\b/i, 'a one-time code: ask for a fixed OTP or a test-mode bypass in the test environment'],
    [/\b(e-?mail (is |was )?(sent|received)|check (the )?(e-?mail|inbox)|verification (e-?mail|link))\b/i, 'an email: use a test mailbox API (e.g. Mailpit, MailSlurp) or a test-only endpoint'],
    [/\b(sms|text message)\b/i, 'an SMS: use the provider\'s test numbers or a test-only endpoint'],
    [/\b(payment|credit card|checkout with card|3-?d ?secure)\b/i, 'a payment: use the payment provider\'s sandbox test cards'],
    [/\b(wait (for )?(\d+ )?(hours?|days?|minutes?)|next day|after (24|48) hours|expire[sd]? after)\b/i, 'waiting for time to pass: ask for a way to set the clock or the expiry in test']
];
const COMPLEX = /\b(upload|download|drag( and |&| ?n ?)drop|iframe|new (tab|window)|pop-?up|pdf|export|import file|file picker)\b/i;
const VERBS = /^(open|go|navigate|visit|launch|start|click|tap|press|select|choose|pick|enter|type|input|fill|set|clear|check|uncheck|tick|toggle|verify|validate|assert|confirm|observe|ensure|log ?in|sign ?in|log ?out|sign ?out|submit|save|delete|remove|add|create|edit|update|change|search|filter|sort|scroll|swipe|hover|drag|upload|download|wait|refresh|reload|close|accept|reject|cancel|expand|collapse|switch|login|logout|register|book|buy|pay|send|open|use|repeat|return|navigate|view|give|call|make|perform|copy|paste|attach|rotate|zoom|turn|enable|disable|install|uninstall|given|when|then|and|user|the user|as a)\b/i;
const NEGATIVE = /\b(invalid|incorrect|wrong|empty|blank|missing|without|negative|error|fail(s|ure|ed)?|locked|expired|unauthori[sz]ed|forbidden|denied|reject(ed)?|not allowed|exceed(s|ed)?|too (long|short|many)|boundary|max(imum)?|min(imum)?|special characters|duplicate)\b/i;
const BOUNDARY_HINT = /\b(max(imum)?|min(imum)?|limit|length|characters|digits|quantity|range|between \d|up to \d|at least \d)\b/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'user', 'should', 'click', 'enter', 'page', 'verify', 'are', 'was', 'has', 'have', 'will', 'can', 'not', 'all', 'any', 'its', 'his', 'her', 'their', 'when', 'given']);

export interface CaseReview {
    id: string;
    score: number;
    verdict: Verdict;
    scores: Record<string, number>;
    issues: string[];
    suggestions: string[];
    duplicateOf: string[];
    effort: 'S' | 'M' | 'L';
    hooks: string[];
}

function textOf(tc: TestCase): string {
    return [tc.title, tc.description, ...tc.preconditions, ...tc.steps.flatMap(s => [s.action, s.data, s.expected]), tc.expected, tc.testData].filter(Boolean).join('\n');
}

export function tokens(tc: TestCase): Set<string> {
    const words = [tc.title, ...tc.steps.map(s => `${s.action} ${s.expected ?? ''}`), tc.expected ?? '']
        .join(' ')
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g);
    return new Set((words ?? []).filter(w => !STOP.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size && !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
}

/** Reviews one case on five dimensions (0–100 each) and returns a verdict with readable issues. */
export function reviewCase(tc: TestCase): CaseReview {
    const issues: string[] = [];
    const suggestions: string[] = [];
    const all = textOf(tc);
    const hasExpected = Boolean(tc.expected) || tc.steps.some(s => s.expected);

    // Clarity: a meaningful title and steps that start with an action.
    let clarity = 100;
    if (!tc.title || tc.title.length < 8 || /^(test|tc|case|scenario)[\s_-]*\d*$/i.test(tc.title)) {
        clarity -= 35;
        issues.push('Title does not say what is being tested.');
        suggestions.push('Rename it to the behaviour, e.g. "Login fails with a wrong password".');
    }
    if (tc.title.length > 140) {
        clarity -= 10;
        issues.push('Title is very long; it probably describes several behaviours.');
    }
    const unclearSteps = tc.steps.filter(s => s.action && !VERBS.test(s.action.trim().replace(/^["'(]/, '')));
    if (tc.steps.length && unclearSteps.length / tc.steps.length > 0.5) {
        clarity -= 25;
        issues.push('Most steps do not start with an action (open, click, enter, verify…).');
        suggestions.push('Write each step as one action: "Click Sign in", "Enter the email".');
    }

    // Completeness: steps, expected results, data.
    let completeness = 100;
    if (!tc.steps.length) {
        completeness -= 60;
        issues.push('No steps.');
    }
    if (!hasExpected) {
        completeness -= 50;
        issues.push('No expected result, so a test could not tell pass from fail.');
        suggestions.push('Add what the user should see after the last step (text, page, value).');
    }
    if (/\b(valid|invalid|existing|registered|test) (user|account|credentials|data|email|password|card)\b/i.test(all) && !tc.testData && !tc.steps.some(s => s.data) && !tc.preconditions.length) {
        completeness -= 15;
        issues.push('Mentions specific data (e.g. "valid user") without saying which.');
        suggestions.push('Name the data: a role in test-data/users.json or a value in the Test Data column.');
    }

    // Atomicity: one behaviour per case.
    let atomicity = 100;
    if (tc.steps.length > 15) {
        atomicity -= 35;
        issues.push(`${tc.steps.length} steps: long cases break easily and are hard to diagnose.`);
        suggestions.push('Split it into several cases, each checking one behaviour.');
    }
    const checks = tc.steps.filter(s => s.expected).length + (tc.expected ? 1 : 0);
    if (checks > 8) {
        atomicity -= 20;
        issues.push(`${checks} separate checks; consider splitting.`);
    }

    // Determinism: expected results that can be checked objectively.
    let determinism = 100;
    const expectedText = [tc.expected, ...tc.steps.map(s => s.expected)].filter(Boolean).join('\n');
    const vague = expectedText.match(VAGUE);
    if (vague) {
        determinism -= 35;
        issues.push(`Expected result is vague ("${vague[0]}").`);
        suggestions.push('Say exactly what appears: the message text, the page, or the value.');
    }
    if (/\b(random|any|some) (product|item|user|value)\b/i.test(all)) {
        determinism -= 15;
        issues.push('Uses random or unspecified data, so runs may differ.');
    }

    // Automatability.
    let automatability = 100;
    const manual = MANUAL_ONLY.filter(([re]) => re.test(all)).map(([, why]) => why);
    const hooks = NEEDS_HOOK.filter(([re]) => re.test(all)).map(([, why]) => why);
    if (manual.length) {
        automatability -= 70;
        issues.push(`Needs ${manual.join(' and ')}.`);
    }
    if (hooks.length) {
        automatability -= 20;
        issues.push(`Depends on ${hooks.map(h => h.split(':')[0]).join(', ')}.`);
        suggestions.push(...hooks.map(h => `For ${h}.`));
    }

    const scores = { clarity: clamp(clarity), completeness: clamp(completeness), atomicity: clamp(atomicity), determinism: clamp(determinism), automatability: clamp(automatability) };
    const score = Math.round(scores.clarity * 0.2 + scores.completeness * 0.3 + scores.atomicity * 0.15 + scores.determinism * 0.2 + scores.automatability * 0.15);
    let verdict: Verdict = 'AUTOMATE';
    if (manual.length) verdict = 'MANUAL';
    else if (!tc.steps.length || !hasExpected || score < 55) verdict = 'NEEDS-REWORK';
    const effort: 'S' | 'M' | 'L' = tc.steps.length > 12 || hooks.length || COMPLEX.test(all) ? 'L' : tc.steps.length > 5 || tc.testData ? 'M' : 'S';
    return { id: tc.id, score, verdict, scores, issues, suggestions: [...new Set(suggestions)], duplicateOf: [], effort, hooks };
}

function clamp(n: number): number {
    return Math.max(0, Math.min(100, n));
}

export interface SuiteReview {
    reviews: CaseReview[];
    duplicates: Array<{ id: string; of: string; similarity: number }>;
    suggestions: string[];
    byVerdict: Record<Verdict, number>;
    averageScore: number;
}

/** Reviews every case, finds near-duplicates and gaps in coverage. */
export function reviewSuite(cases: TestCase[]): SuiteReview {
    const reviews = cases.map(reviewCase);
    const duplicates: SuiteReview['duplicates'] = [];
    const toks = cases.map(tokens);
    for (let i = 0; i < cases.length; i++) {
        for (let j = 0; j < i; j++) {
            const sim = jaccard(toks[i], toks[j]);
            if (sim >= 0.85 && toks[i].size >= 4) {
                duplicates.push({ id: cases[i].id, of: cases[j].id, similarity: Math.round(sim * 100) / 100 });
                reviews[i].duplicateOf.push(cases[j].id);
                reviews[i].issues.push(`Looks like a duplicate of ${cases[j].id} (${Math.round(sim * 100)}% the same words).`);
                break;
            }
        }
    }

    const suggestions: string[] = [];
    const areas = new Map<string, TestCase[]>();
    for (const tc of cases) areas.set(tc.area ?? 'General', [...(areas.get(tc.area ?? 'General') ?? []), tc]);
    for (const [area, list] of areas) {
        if (list.length >= 2 && !list.some(tc => NEGATIVE.test(textOf(tc)))) {
            suggestions.push(`${area}: every case is a happy path. Add negative cases (invalid input, empty required fields, wrong permissions).`);
        }
        if (list.some(tc => BOUNDARY_HINT.test(textOf(tc))) && !list.some(tc => /\bboundary|max(imum)? ?(\+|plus) ?1|min(imum)? ?(-|minus) ?1|edge\b/i.test(textOf(tc)))) {
            suggestions.push(`${area}: cases mention limits (length, quantity, range). Add boundary tests just inside and just outside each limit.`);
        }
    }
    const withPriority = cases.filter(tc => tc.priority);
    if (!withPriority.length && cases.length > 3) suggestions.push('No case has a priority. Add P1/P2/P3 so the plan can start with what matters most.');
    else if (withPriority.length > 4 && withPriority.filter(tc => tc.priority === 'P1').length / withPriority.length > 0.6) {
        suggestions.push('Over 60% of cases are P1. Rank by business risk so the first wave stays small and meaningful.');
    }
    if (cases.length > 5 && !cases.some(tc => tc.area)) suggestions.push('Cases have no module or area. Grouping them (Login, Checkout, …) gives tidier page objects and reports.');
    if (duplicates.length) suggestions.push(`${duplicates.length} likely duplicate(s): merge them or mark one as a variant.`);

    const byVerdict: Record<Verdict, number> = { AUTOMATE: 0, MANUAL: 0, 'NEEDS-REWORK': 0 };
    for (const r of reviews) byVerdict[r.verdict]++;
    const averageScore = reviews.length ? Math.round(reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length) : 0;
    return { reviews, duplicates, suggestions, byVerdict, averageScore };
}

/** Suite view of every case using the verdicts already saved (including the user's overrides). */
export function suiteFromStored(cases: TestCase[]): SuiteReview {
    const suite = reviewSuite(cases);
    cases.forEach((tc, i) => {
        if (!tc.review) return;
        const r = suite.reviews[i];
        r.verdict = tc.review.verdict;
        r.score = tc.review.score;
        r.issues = tc.review.issues;
    });
    suite.byVerdict = { AUTOMATE: 0, MANUAL: 0, 'NEEDS-REWORK': 0 };
    for (const r of suite.reviews) suite.byVerdict[r.verdict]++;
    suite.averageScore = suite.reviews.length ? Math.round(suite.reviews.reduce((sum, r) => sum + r.score, 0) / suite.reviews.length) : 0;
    return suite;
}

export function renderReviewMarkdown(suite: SuiteReview, cases: TestCase[], when: string): string {
    const title = new Map(cases.map(tc => [tc.id, tc.title]));
    const lines = [
        `# Test-case review, ${when.slice(0, 10)}`,
        '',
        `${suite.reviews.length} case(s) reviewed. Average quality score: **${suite.averageScore}/100**.`,
        '',
        '| Verdict | Cases |',
        '|---|---|',
        `| Ready to automate | ${suite.byVerdict.AUTOMATE} |`,
        `| Needs rework first | ${suite.byVerdict['NEEDS-REWORK']} |`,
        `| Keep manual | ${suite.byVerdict.MANUAL} |`,
        ''
    ];
    if (suite.suggestions.length) lines.push('## Suggestions for the suite', '', ...suite.suggestions.map(s => `- ${s}`), '');
    lines.push('## Cases', '', '| ID | Title | Score | Verdict | Effort | Main issues |', '|---|---|---|---|---|---|');
    for (const r of [...suite.reviews].sort((a, b) => a.score - b.score)) {
        lines.push(`| ${r.id} | ${cell(title.get(r.id) ?? '')} | ${r.score} | ${r.verdict} | ${r.effort} | ${cell(r.issues.slice(0, 2).join(' ') || 'none')} |`);
    }
    lines.push('', 'Scores: clarity 20%, completeness 30%, one behaviour per case 15%, objective expected results 20%, automatability 15%.', '', 'Test-case text is data from your source. TestPilot never follows instructions written inside it.', '');
    return lines.join('\n');
}

function cell(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
