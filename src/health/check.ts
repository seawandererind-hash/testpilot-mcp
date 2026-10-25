/**
 * The app health check: what a person with no testing background wants to know first
 * ("is anything broken?"), worked out from one read-only walk through the app.
 * Every finding says, in plain words, what is wrong, why it matters and who can fix it.
 */
import type { BrokenLink, ExploredPage } from '../explore/web.js';

export const HEALTH_DIR = '.testpilot/health';
export const STARTER_CASES_FILE = 'test-cases/starter-tests.csv';
export const STARTER_PREFIX = 'START';

export type Severity = 'problem' | 'warning';

export interface Finding {
    severity: Severity;
    /** Short headline, e.g. "2 links lead nowhere". */
    title: string;
    /** What it means for the people using the app. */
    meaning: string;
    /** What to do about it, and who usually does it. */
    fix: string;
    /** Pages or addresses where it happens. */
    where: string[];
}

export interface HealthReport {
    checkedAt: string;
    start: string;
    pagesChecked: number;
    pagesOk: number;
    findings: Finding[];
    /** One-line verdict for the chat. */
    verdict: string;
    /** Things that work, so the person also hears the good news. */
    good: string[];
    signIn?: { path: string; button?: string };
}

const SLOW_MS = 3000;

function pathOf(url: string): string {
    try {
        const u = new URL(url);
        return u.pathname + u.search;
    } catch {
        return url;
    }
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** Turns one walk through the app into plain-language findings. */
export function buildHealthReport(pages: ExploredPage[], brokenLinks: BrokenLink[], start: string, now = new Date()): HealthReport {
    const findings: Finding[] = [];
    const opened = pages.filter(p => !p.error && (p.status ?? 200) < 400);
    // A page reached through a link that fails is a broken link; only pages typed in directly count as "did not open".
    const failed = pages.filter(p => p.error || (p.status ?? 200) >= 400);
    const failedPages = failed.filter(p => !p.foundOn);
    brokenLinks = [...failed.filter(p => p.foundOn).map(p => ({ url: p.url, status: p.status, error: p.error, foundOn: p.foundOn })), ...brokenLinks];

    if (failedPages.length) {
        findings.push({
            severity: 'problem',
            title: `${plural(failedPages.length, 'page')} did not open`,
            meaning: 'People who click their way to these pages get an error instead of the page.',
            fix: 'Send the addresses to your developers. If the whole app failed, check the address and that the test environment is running (and that you are on the VPN, if your company uses one).',
            where: failedPages.map(p => `${p.path} (${p.error ?? `error ${p.status}`})`)
        });
    }
    if (brokenLinks.length) {
        findings.push({
            severity: 'problem',
            title: `${plural(brokenLinks.length, 'link')} lead${brokenLinks.length === 1 ? 's' : ''} nowhere`,
            meaning: 'Someone clicking these links sees a "page not found" or an error page.',
            fix: 'Developers should fix or remove these links. Each line says which page the link is on.',
            where: brokenLinks.map(l => `${pathOf(l.url)} (${l.status ? `error ${l.status}` : l.error ?? 'no answer'}${l.foundOn ? `, linked from ${pathOf(l.foundOn)}` : ''})`)
        });
    }
    const crashing = opened.filter(p => p.pageErrors?.length);
    if (crashing.length) {
        findings.push({
            severity: 'problem',
            title: `Programming errors on ${plural(crashing.length, 'page')}`,
            meaning: 'Part of the page\'s code crashed while it loaded. Buttons or content on these pages may silently not work.',
            fix: 'Give the error text to your developers; they will recognise it.',
            where: crashing.map(p => `${p.path}: ${p.pageErrors![0]}${p.pageErrors!.length > 1 ? ` (+${p.pageErrors!.length - 1} more)` : ''}`)
        });
    }
    const serverErrors = opened.flatMap(p => (p.failedRequests ?? []).filter(r => r.url !== p.url && (r.status === null || r.status >= 500)).map(r => ({ page: p.path, r })));
    if (serverErrors.length) {
        findings.push({
            severity: 'problem',
            title: `${plural(serverErrors.length, 'background request')} failed`,
            meaning: 'The page asked the server for data or files and got an error back, so something on the page is probably missing or broken.',
            fix: 'Developers can look these addresses up in the server logs.',
            where: serverErrors.slice(0, 10).map(({ page, r }) => `${page}: ${pathOf(r.url)} (${r.status ? `error ${r.status}` : r.error ?? 'no answer'})`)
        });
    }
    const missing = opened.flatMap(p => (p.failedRequests ?? []).filter(r => r.url !== p.url && r.status !== null && r.status >= 400 && r.status < 500 && !p.brokenImages?.includes(r.url)).map(r => ({ page: p.path, r })));
    if (missing.length) {
        findings.push({
            severity: 'warning',
            title: `${plural(missing.length, 'file')} the pages ask for ${missing.length === 1 ? 'is' : 'are'} missing`,
            meaning: 'Usually an image, a font or a script that moved. Sometimes harmless, sometimes the reason something looks wrong.',
            fix: 'Developers should remove the reference or put the file back.',
            where: missing.slice(0, 10).map(({ page, r }) => `${page}: ${pathOf(r.url)} (error ${r.status})`)
        });
    }
    // "Failed to load resource" repeats a failed request that is already reported above.
    const consoleOf = (p: ExploredPage) => (p.consoleErrors ?? []).filter(e => !/^Failed to load resource/i.test(e));
    const consoleNoise = opened.filter(p => consoleOf(p).length && !p.pageErrors?.length);
    if (consoleNoise.length) {
        findings.push({
            severity: 'warning',
            title: `Error messages in the browser on ${plural(consoleNoise.length, 'page')}`,
            meaning: 'The browser logged errors that visitors do not see. They often point at a real problem before users notice it.',
            fix: 'Worth a look by a developer (open the page, press F12, look at the Console tab).',
            where: consoleNoise.map(p => `${p.path}: ${consoleOf(p)[0]}`)
        });
    }
    const brokenImages = opened.filter(p => p.brokenImages?.length);
    if (brokenImages.length) {
        findings.push({
            severity: 'warning',
            title: `Broken images on ${plural(brokenImages.length, 'page')}`,
            meaning: 'Visitors see an empty box or a broken-image icon.',
            fix: 'Developers or content editors should fix the image addresses.',
            where: brokenImages.map(p => `${p.path}: ${p.brokenImages!.map(pathOf).slice(0, 3).join(', ')}`)
        });
    }
    const slow = opened.filter(p => (p.loadMs ?? 0) > SLOW_MS);
    if (slow.length) {
        findings.push({
            severity: 'warning',
            title: `${plural(slow.length, 'slow page')}`,
            meaning: `These took more than ${SLOW_MS / 1000} seconds to show. People tend to leave pages that feel slow.`,
            fix: 'Test environments are often slower than production, so compare before raising it. If it is slow everywhere, tell the developers.',
            where: slow.map(p => `${p.path}: ${(p.loadMs! / 1000).toFixed(1)} s`)
        });
    }
    const overflow = opened.filter(p => p.phoneOverflow);
    if (overflow.length) {
        findings.push({
            severity: 'warning',
            title: `Too wide for a phone on ${plural(overflow.length, 'page')}`,
            meaning: 'On a phone, people have to scroll sideways to see the whole page.',
            fix: 'A designer or front-end developer should check these pages on a phone-sized screen.',
            where: overflow.map(p => p.path)
        });
    }
    const noAlt = opened.filter(p => p.imagesWithoutAlt);
    if (noAlt.length) {
        findings.push({
            severity: 'warning',
            title: 'Images without a text description',
            meaning: 'Blind people using a screen reader cannot tell what these images show. This is part of accessibility rules (WCAG) many companies must follow.',
            fix: 'Developers add an alt text to each image. For a full accessibility check, ask me to run the accessibility scan.',
            where: noAlt.map(p => `${p.path}: ${plural(p.imagesWithoutAlt!, 'image')}`)
        });
    }
    const untitled = opened.filter(p => !p.title.trim());
    if (untitled.length) {
        findings.push({
            severity: 'warning',
            title: `${plural(untitled.length, 'page')} without a title`,
            meaning: 'The browser tab shows the address instead of a name, and search engines and screen readers have nothing to go on.',
            fix: 'Developers give each page a <title>.',
            where: untitled.map(p => p.path)
        });
    }

    const problems = findings.filter(f => f.severity === 'problem').length;
    const warnings = findings.length - problems;
    const good: string[] = [];
    if (opened.length) good.push(`${plural(opened.length, 'page')} opened without errors from the server.`);
    if (!brokenLinks.length && pages.some(p => p.links?.length)) good.push('Every link that was checked works.');
    if (opened.length && !crashing.length) good.push('No programming errors while the pages loaded.');
    if (opened.length && !slow.length) good.push(`Every page showed in under ${SLOW_MS / 1000} seconds.`);
    if (opened.some(p => p.phoneOverflow === false) && !overflow.length) good.push('The pages fit on a phone screen.');

    const signInPage = opened.find(p => p.elements.some(e => e.role === 'textbox' && /pass ?word/i.test(e.name)));
    const signIn = signInPage
        ? { path: signInPage.path, button: signInPage.elements.find(e => e.role === 'button' && /sign ?in|log ?in|login|continue|submit/i.test(e.name))?.name }
        : undefined;

    const verdict = !opened.length
        ? 'The app did not open, so nothing else could be checked.'
        : problems
          ? `Found ${plural(problems, 'problem')} to fix${warnings ? ` and ${plural(warnings, 'thing')} worth a look` : ''} across ${plural(pages.length, 'page')}.`
          : warnings
            ? `No serious problems across ${plural(pages.length, 'page')}, and ${plural(warnings, 'thing')} worth a look.`
            : `All ${plural(pages.length, 'page')} look healthy.`;

    return { checkedAt: now.toISOString(), start, pagesChecked: pages.length, pagesOk: opened.length, findings, verdict, good, signIn };
}

/** The report a person reads: what was checked, what is wrong, what is fine. */
export function renderHealthMarkdown(report: HealthReport): string {
    const lines = [
        '# App health check',
        '',
        `Checked ${report.start} on ${report.checkedAt.slice(0, 16).replace('T', ' ')} (UTC). TestPilot opened each page like a visitor would, following links only. It did not click buttons, type anything or submit forms, so nothing in the app was changed.`,
        '',
        `**${report.verdict}**`,
        ''
    ];
    const problems = report.findings.filter(f => f.severity === 'problem');
    const warnings = report.findings.filter(f => f.severity === 'warning');
    const section = (heading: string, items: Finding[]) => {
        if (!items.length) return;
        lines.push(`## ${heading}`, '');
        for (const f of items) {
            lines.push(`### ${f.title}`, '', `**What it means:** ${f.meaning}`, '', `**What to do:** ${f.fix}`, '');
            for (const w of f.where.slice(0, 15)) lines.push(`- ${w.replace(/\|/g, '\\|')}`);
            if (f.where.length > 15) lines.push(`- …and ${f.where.length - 15} more`);
            lines.push('');
        }
    };
    section('Problems to fix', problems);
    section('Worth a look', warnings);
    if (report.good.length) lines.push('## What is working', '', ...report.good.map(g => `- ${g}`), '');
    lines.push(
        '## What this check does not cover',
        '',
        '- Anything behind a sign-in (unless you gave TestPilot a test account), and anything that needs clicking or typing, such as forms, carts or payments.',
        '- Whether the content is correct. Only you know what the app is supposed to do; describe it in your own words and TestPilot turns it into tests.',
        '',
        'Run the check again any time with "check my app again".',
        ''
    );
    return lines.join('\n');
}

function csvCell(s: string): string {
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Quote marks would end the quoted text early when the case is read back, so such names are left out. */
const QUOTES = /["“”'‘’]/;

/** True when a page heading appears once, so a test can rely on it. */
function uniqueHeading(p: ExploredPage): string | undefined {
    const h = p.elements.filter(e => e.role === 'heading' && e.count === 1 && e.name.trim().length >= 3 && e.name.length <= 80 && !QUOTES.test(e.name));
    return h[0]?.name;
}

export interface StarterCase {
    id: string;
    title: string;
    area: string;
    priority: 'High' | 'Medium' | 'Low';
    steps: string[];
    expected: string;
}

/**
 * Safe first tests worked out from the walk: every page opens and shows what it showed today,
 * and the main links lead where they should. They never type, submit or buy anything.
 */
export function starterCases(pages: ExploredPage[], max = 12): StarterCase[] {
    const opened = pages.filter(p => !p.error && (p.status ?? 200) < 400);
    const cases: StarterCase[] = [];
    let n = 0;
    const next = () => `${STARTER_PREFIX}-${++n}`;
    const seenPaths = new Set<string>();
    for (const p of opened) {
        if (cases.length >= Math.ceil(max * 0.7)) break;
        if (seenPaths.has(p.path)) continue;
        seenPaths.add(p.path);
        const name = p.title.trim() || uniqueHeading(p) || p.path;
        const heading = uniqueHeading(p);
        const title = p.title.trim();
        const expected = title && !QUOTES.test(title) ? `Page title contains "${title.slice(0, 60)}"` : heading ? `${heading} page is displayed` : '';
        if (!expected) continue;
        cases.push({ id: next(), title: `${name.slice(0, 60)} page opens`, area: 'Pages open', priority: cases.length === 0 ? 'High' : 'Medium', steps: [`Open ${p.path}`], expected });
    }
    // Navigation: links on the first page whose text is unique and that lead to another page that opened.
    const home = opened[0];
    if (home?.links) {
        const reachable = new Map(opened.map(p => [p.url.split('#')[0], p]));
        const linkNames = home.elements.filter(e => e.role === 'link');
        const used = new Set<string>();
        for (const link of home.links) {
            if (cases.length >= max) break;
            const target = reachable.get(link.href.split('#')[0]);
            if (!target || target === home || used.has(target.path) || !link.text || QUOTES.test(link.text)) continue;
            const el = linkNames.find(e => e.name.trim().toLowerCase() === link.text.toLowerCase());
            if (!el || el.count !== 1) continue;
            used.add(target.path);
            const path = new URL(target.url).pathname;
            cases.push({ id: next(), title: `"${link.text}" link opens the right page`, area: 'Navigation', priority: 'Medium', steps: [`Open ${home.path}`, `Click ${link.text} link`], expected: `URL contains "${path}"` });
        }
    }
    return cases;
}

export function starterCasesCsv(cases: StarterCase[]): string {
    const rows = [['ID', 'Title', 'Module', 'Priority', 'Steps', 'Expected Result'].join(',')];
    for (const c of cases) rows.push([c.id, c.title, c.area, c.priority, c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), c.expected].map(csvCell).join(','));
    return rows.join('\n') + '\n';
}
