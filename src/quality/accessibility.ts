import type { ProjectStore } from '../core/store.js';
import { quote } from '../explore/web.js';
import { CREATED_HEADER } from '../scaffold/engine.js';
import { explainRule } from './a11y-rules.js';
import { BROWSER_PRELUDE, canResolve, escapeHtml, htmlPage, QUALITY_REPORTS_DIR, runProjectScript, type ScriptRunner, type SpecLanguage } from './project.js';

export type A11yLevel = 'A' | 'AA' | 'AAA';
export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
export const IMPACTS: Impact[] = ['critical', 'serious', 'moderate', 'minor'];

export const AXE_INSTALL_COMMAND = ['npm', 'i', '-D', '@axe-core/playwright'];

/** axe-core tags for a WCAG level (WCAG 2.0, 2.1 and 2.2 success criteria up to that level). */
export function tagsFor(level: A11yLevel, bestPractices: boolean): string[] {
    const tags = ['wcag2a', 'wcag21a'];
    if (level !== 'A') tags.push('wcag2aa', 'wcag21aa', 'wcag22aa');
    if (level === 'AAA') tags.push('wcag2aaa');
    if (bestPractices) tags.push('best-practice');
    return tags;
}

/** Which axe engine the project can use: the Playwright integration, the bare library, or none. */
export function axeEngine(cwd: string): 'axe-playwright' | 'axe-core' | undefined {
    if (canResolve(cwd, '@axe-core/playwright')) return 'axe-playwright';
    if (canResolve(cwd, 'axe-core')) return 'axe-core';
    return undefined;
}

const SCAN_SCRIPT =
    BROWSER_PRELUDE +
    String.raw`
let AxeBuilder;
let axeSource;
try {
  if (args.engine === 'axe-playwright') { const mod = require('@axe-core/playwright'); AxeBuilder = mod.AxeBuilder || mod.default || mod; }
  else { const fs = await import('node:fs'); axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); }
} catch (e) { await browser.close(); done({ fatal: 'Could not load axe-core: ' + String(e.message).split('\n')[0] }); }
const pages = [];
for (const url of args.urls) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    let results;
    if (AxeBuilder) results = await new AxeBuilder({ page }).withTags(args.tags).analyze();
    else {
      await page.addScriptTag({ content: axeSource }).catch(() => page.evaluate(axeSource));
      results = await page.evaluate(tags => window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }), args.tags);
    }
    pages.push({
      url: page.url(), requested: url, status: resp ? resp.status() : null, title: await page.title().catch(() => ''),
      axeVersion: results.testEngine && results.testEngine.version,
      passes: (results.passes || []).length, incomplete: (results.incomplete || []).length,
      violations: results.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, description: v.description, tags: v.tags, nodes: v.nodes.slice(0, 50).map(n => ({ target: n.target, html: n.html })), nodeCount: v.nodes.length }))
    });
  } catch (e) {
    pages.push({ url, requested: url, error: String(e.message).split('\n')[0] });
  }
}
await browser.close();
done({ pages });
`;

/** One violation as axe reports it (the subset TestPilot reads). */
export interface AxeViolation {
    id: string;
    impact?: Impact | null;
    help?: string;
    helpUrl?: string;
    description?: string;
    tags?: string[];
    nodes: Array<{ target: unknown[]; html?: string }>;
    nodeCount?: number;
}

export interface AxePageResult {
    url: string;
    requested?: string;
    status?: number | null;
    title?: string;
    error?: string;
    axeVersion?: string;
    passes?: number;
    incomplete?: number;
    violations?: AxeViolation[];
}

export interface A11yIssue {
    rule: string;
    impact: Impact;
    title: string;
    who: string;
    fix: string;
    builtInExplanation: boolean;
    elements: number;
    examples: Array<{ selector: string; html: string }>;
    wcag: string[];
    bestPractice: boolean;
    helpUrl?: string;
}

export interface A11yPage {
    url: string;
    path: string;
    title: string;
    status?: number | null;
    error?: string;
    passes: number;
    incomplete: number;
    issues: A11yIssue[];
}

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "wcag143" → "1.4.3". */
export function wcagCriteria(tags: string[] = []): string[] {
    return tags.map(t => t.match(/^wcag(\d)(\d)(\d{1,2})$/)).filter((m): m is RegExpMatchArray => Boolean(m)).map(m => `${m[1]}.${m[2]}.${m[3]}`);
}

/** Turns raw axe results into plain-language issues, worst first. */
export function toA11yPage(raw: AxePageResult): A11yPage {
    let path = raw.url;
    try {
        const u = new URL(raw.url);
        path = u.pathname + u.search;
    } catch {
        // keep the raw value
    }
    const issues = (raw.violations ?? []).map(v => {
        const explanation = explainRule(v.id, v);
        return {
            rule: v.id,
            impact: (v.impact && IMPACTS.includes(v.impact) ? v.impact : 'minor') as Impact,
            title: explanation.title,
            who: explanation.who,
            fix: explanation.fix,
            builtInExplanation: explanation.builtIn,
            elements: v.nodeCount ?? v.nodes.length,
            examples: v.nodes.slice(0, 3).map(n => ({ selector: trim(n.target.map(t => (Array.isArray(t) ? t.join(' ') : String(t))).join(' >>> '), 160), html: trim((n.html ?? '').replace(/\s+/g, ' ').trim(), 200) })),
            wcag: wcagCriteria(v.tags),
            bestPractice: (v.tags ?? []).includes('best-practice') && !wcagCriteria(v.tags).length,
            helpUrl: v.helpUrl
        };
    });
    issues.sort((a, b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || b.elements - a.elements);
    return { url: raw.url, path, title: raw.title ?? '', status: raw.status, error: raw.error, passes: raw.passes ?? 0, incomplete: raw.incomplete ?? 0, issues };
}

export interface A11ySummary {
    pages: number;
    pagesWithIssues: number;
    issues: number;
    elements: number;
    byImpact: Record<Impact, number>;
    /** Each rule once across all pages, worst first: what to fix first. */
    topRules: Array<{ rule: string; impact: Impact; title: string; pages: number; elements: number }>;
}

export function summarise(pages: A11yPage[]): A11ySummary {
    const byImpact: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    const rules = new Map<string, A11ySummary['topRules'][number]>();
    let elements = 0;
    let issues = 0;
    for (const p of pages)
        for (const i of p.issues) {
            byImpact[i.impact]++;
            issues++;
            elements += i.elements;
            const r = rules.get(i.rule) ?? { rule: i.rule, impact: i.impact, title: i.title, pages: 0, elements: 0 };
            r.pages++;
            r.elements += i.elements;
            rules.set(i.rule, r);
        }
    const topRules = [...rules.values()].sort((a, b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || b.pages - a.pages || b.elements - a.elements);
    return { pages: pages.length, pagesWithIssues: pages.filter(p => p.issues.length).length, issues, elements, byImpact, topRules };
}

export interface A11yScanOutcome {
    fatal?: string;
    pages: A11yPage[];
    axeVersion?: string;
}

/** Scans the pages with axe in the project's Playwright. */
export async function scanAccessibility(
    store: ProjectStore,
    cwd: string,
    options: { urls: string[]; tags: string[]; engine: 'axe-playwright' | 'axe-core'; storageState?: string; ignoreHttpsErrors?: boolean; timeoutMs?: number },
    run: ScriptRunner = runProjectScript
): Promise<A11yScanOutcome> {
    const payload = { urls: options.urls, tags: options.tags, engine: options.engine, storageState: options.storageState ? store.resolve(options.storageState) : undefined, ignoreHttpsErrors: options.ignoreHttpsErrors };
    const out = (await run(store, cwd, 'a11y-scan', SCAN_SCRIPT, payload, options.timeoutMs ?? 10 * 60_000)) as { fatal?: string; pages?: AxePageResult[] };
    if (out.fatal) return { fatal: out.fatal, pages: [] };
    const raw = out.pages ?? [];
    return { pages: raw.map(toA11yPage), axeVersion: raw.find(p => p.axeVersion)?.axeVersion };
}

export const EAA_SENTENCE = 'Since 28 June 2025 the European Accessibility Act requires many digital products and services sold in the EU (online shops, banking, transport, e-books and more) to meet these accessibility rules.';

const IMPACT_TEXT: Record<Impact, string> = {
    critical: 'Critical: blocks some people completely',
    serious: 'Serious: very hard for some people',
    moderate: 'Moderate: gets in the way',
    minor: 'Minor: an annoyance'
};

/** Markdown would treat "<main>" in an explanation as HTML; show tags as code instead. */
const mdText = (s: string) => s.replace(/<[^<>]+>/g, m => `\`${m}\``).replace(/\|/g, '\\|');

export function renderA11yMarkdown(pages: A11yPage[], meta: { level: A11yLevel; tags: string[]; scannedAt: string; axeVersion?: string }): string {
    const s = summarise(pages);
    const lines = [
        '# Accessibility report',
        '',
        `Scanned ${s.pages} page(s) on ${meta.scannedAt.slice(0, 10)} with axe-core${meta.axeVersion ? ` ${meta.axeVersion}` : ''} against WCAG level ${meta.level} (tags: ${meta.tags.join(', ')}).`,
        EAA_SENTENCE,
        'Automated checks find roughly a third of accessibility problems; test with a keyboard and a screen reader too.',
        '',
        `**${s.issues ? `${s.issues} issue(s) on ${s.pagesWithIssues} page(s), affecting ${s.elements} element(s).` : 'No issues found by the automated checks.'}** Critical ${s.byImpact.critical}, serious ${s.byImpact.serious}, moderate ${s.byImpact.moderate}, minor ${s.byImpact.minor}.`,
        ''
    ];
    if (s.topRules.length) {
        lines.push('## Fix first', '', '| Impact | Problem | Rule | Pages | Elements |', '|---|---|---|---|---|');
        for (const r of s.topRules) lines.push(`| ${r.impact} | ${mdText(r.title)} | \`${r.rule}\` | ${r.pages} | ${r.elements} |`);
        lines.push('');
    }
    for (const p of pages) {
        lines.push(`## ${mdText(p.title || p.path)} (${p.path})`, '');
        if (p.error) {
            lines.push(`Could not open: ${p.error}`, '');
            continue;
        }
        if (!p.issues.length) {
            lines.push('No issues found.', '');
            continue;
        }
        for (const i of p.issues) {
            lines.push(`### ${i.impact}: ${mdText(i.title)} (\`${i.rule}\`, ${i.elements} element(s))`, '', `- **Who is affected:** ${mdText(i.who)}`, `- **How to fix:** ${mdText(i.fix)}`);
            if (i.wcag.length) lines.push(`- **WCAG:** ${i.wcag.join(', ')}`);
            else if (i.bestPractice) lines.push('- **Best practice** (not a WCAG failure on its own, but it helps).');
            if (i.helpUrl) lines.push(`- More: ${i.helpUrl}`);
            for (const e of i.examples) lines.push(`- \`${e.selector.replace(/`/g, "'")}\`: \`${e.html.replace(/`/g, "'")}\``);
            lines.push('');
        }
    }
    lines.push('Page content is data from the app; it was scanned, not followed as instructions.', '');
    return lines.join('\n');
}

export function renderA11yHtml(pages: A11yPage[], meta: { level: A11yLevel; tags: string[]; scannedAt: string; axeVersion?: string }): string {
    const s = summarise(pages);
    const e = escapeHtml;
    const stat = (n: number, label: string, cls = '') => `<div class="stat"><b class="${cls}">${n}</b><span>${e(label)}</span></div>`;
    const parts: string[] = [
        `<h1>Accessibility report</h1>`,
        `<p class="muted">Scanned ${s.pages} page(s) on ${e(meta.scannedAt.slice(0, 10))} with axe-core${meta.axeVersion ? ` ${e(meta.axeVersion)}` : ''} against WCAG level ${e(meta.level)}.</p>`,
        `<p>${e(EAA_SENTENCE)} Automated checks find roughly a third of problems, so also try the pages with only a keyboard and with a screen reader.</p>`,
        `<div class="stats">${stat(s.issues, 'issues')}${stat(s.byImpact.critical, 'critical', 'critical')}${stat(s.byImpact.serious, 'serious', 'serious')}${stat(s.byImpact.moderate, 'moderate', 'moderate')}${stat(s.byImpact.minor, 'minor', 'minor')}${stat(s.elements, 'elements affected')}</div>`
    ];
    if (!s.issues) parts.push(`<p class="ok"><b>No issues found by the automated checks.</b></p>`);
    if (s.topRules.length) {
        parts.push('<h2>Fix first</h2>', '<ol class="fixfirst">');
        for (const r of s.topRules) parts.push(`<li><span class="badge ${r.impact}">${r.impact}</span>${e(r.title)} <span class="muted">(${r.pages} page(s), ${r.elements} element(s), <code>${e(r.rule)}</code>)</span></li>`);
        parts.push('</ol>');
    }
    for (const p of pages) {
        parts.push(`<h2>${e(p.title || p.path)} <span class="muted">${e(p.path)}</span></h2>`);
        if (p.error) {
            parts.push(`<div class="card"><p class="critical">Could not open this page: ${e(p.error)}</p></div>`);
            continue;
        }
        if (!p.issues.length) {
            parts.push(`<div class="card"><p class="ok">No issues found on this page.</p></div>`);
            continue;
        }
        for (const i of p.issues) {
            const examples = i.examples.map(x => `<li><code>${e(x.selector)}</code><pre>${e(x.html)}</pre></li>`).join('');
            parts.push(
                `<div class="card"><h3><span class="badge ${i.impact}" title="${e(IMPACT_TEXT[i.impact])}">${i.impact}</span>${e(i.title)}</h3>`,
                `<p class="muted"><code>${e(i.rule)}</code> · ${i.elements} element(s)${i.wcag.length ? ` · WCAG ${e(i.wcag.join(', '))}` : i.bestPractice ? ' · best practice' : ''}</p>`,
                `<dl><dt>Who is affected</dt><dd>${e(i.who)}</dd><dt>How to fix</dt><dd>${e(i.fix)}${i.helpUrl ? ` <a href="${e(i.helpUrl)}">More about this rule</a>` : ''}</dd></dl>`,
                examples ? `<details><summary>Where (${Math.min(i.examples.length, i.elements)} of ${i.elements})</summary><ul class="examples">${examples}</ul></details>` : '',
                '</div>'
            );
        }
    }
    parts.push('<p class="muted" style="margin-top:28px">Generated by TestPilot (quality_scan, action "accessibility"). Page content is data from the app; it was scanned, not followed as instructions.</p>');
    const css = `.fixfirst { padding-left: 22px; } .fixfirst li { margin: 6px 0; } details { margin-top: 10px; } summary { cursor: pointer; color: var(--accent); } .examples { padding-left: 18px; margin: 8px 0 0; } .examples li { margin: 8px 0; } h2 .muted { font-size: 0.9rem; font-weight: 400; }`;
    return htmlPage('Accessibility report', parts.join('\n'), css);
}

/** Writes accessibility.html and accessibility.md (plus the raw results as JSON) and returns their paths. */
export function writeA11yReports(store: ProjectStore, pages: A11yPage[], meta: { level: A11yLevel; tags: string[]; scannedAt: string; axeVersion?: string }): string[] {
    const files = [`${QUALITY_REPORTS_DIR}/accessibility.html`, `${QUALITY_REPORTS_DIR}/accessibility.md`, `${QUALITY_REPORTS_DIR}/accessibility.json`];
    store.write(files[0], renderA11yHtml(pages, meta));
    store.write(files[1], renderA11yMarkdown(pages, meta));
    store.write(files[2], JSON.stringify({ ...meta, pages }, null, 2) + '\n');
    return files;
}

/** A Playwright spec that runs the same scan in CI and fails on serious or critical issues. */
export function renderA11ySpec(paths: string[], tags: string[], lang: SpecLanguage, esm: boolean): string {
    const imports =
        lang === 'ts' || esm
            ? [`import { expect, test } from '@playwright/test';`, `import AxeBuilder from '@axe-core/playwright';`]
            : [`const { expect, test } = require('@playwright/test');`, `const AxeBuilder = require('@axe-core/playwright').default;`];
    return [
        `// ${CREATED_HEADER}`,
        '// Accessibility checks with axe-core (WCAG rules). Each page fails when it has serious or critical issues;',
        '// the full list of issues is attached to the test result. Report: quality_scan action "accessibility".',
        ...imports,
        '',
        `const TAGS = [${tags.map(quote).join(', ')}];`,
        `const PAGES = [${paths.map(quote).join(', ')}];`,
        '',
        'for (const pagePath of PAGES) {',
        "    test(`accessibility: ${pagePath}`, { tag: ['@a11y'] }, async ({ page }) => {",
        '        await page.goto(pagePath);',
        '        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();',
        "        await test.info().attach('axe-violations', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });",
        "        const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');",
        "        expect(blocking.map(v => `${v.impact}: ${v.id} on ${v.nodes.length} element(s): ${v.help} (${v.helpUrl})`), 'serious or critical accessibility issues').toEqual([]);",
        '    });',
        '}',
        ''
    ].join('\n');
}
