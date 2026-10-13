import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ProjectStore } from '../core/store.js';
import { quote } from '../explore/web.js';
import { CREATED_HEADER } from '../scaffold/engine.js';
import { BROWSER_PRELUDE, escapeHtml, htmlPage, QUALITY_REPORTS_DIR, relativeLink, runProjectScript, type ScriptRunner, type SpecLanguage } from './project.js';

export const VISUAL_PLAN_FILE = '.testpilot/visual/plan.json';
export const VISUAL_IMAGES_DIR = `${QUALITY_REPORTS_DIR}/visual`;

/** Text that changes between runs: clocks, dates and relative times. Shared by the browser helper and the tests. */
export const DYNAMIC_TEXT: Array<{ kind: string; source: string }> = [
    { kind: 'a clock time', source: String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b` },
    { kind: 'a date', source: String.raw`\b\d{4}-\d{2}-\d{2}\b` },
    { kind: 'a date', source: String.raw`\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b` },
    { kind: 'a date', source: String.raw`\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b` },
    { kind: 'a date', source: String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?\b` },
    {
        kind: 'a relative time',
        source: String.raw`\b(?:just now|yesterday|tomorrow|\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo|months?|y|years?)\s+ago|in\s+\d+\s+(?:minutes?|hours?|days?))\b`
    }
];

/** Which kind of changing text this is (clock, date, relative time), if any. */
export function dynamicTextKind(text: string): { kind: string; source: string } | undefined {
    return DYNAMIC_TEXT.find(p => new RegExp(p.source, 'i').test(text));
}

/** Elements that change between runs, found by selector. Only the ones present on a page become masks. */
export const MASK_RULES: Array<{ selector: string; reason: string }> = [
    { selector: 'time, [datetime]', reason: 'shows a date or time, which changes between runs' },
    { selector: 'video', reason: 'video frames differ between runs' },
    { selector: 'canvas', reason: 'canvas drawings (charts, maps) can render differently each time' },
    { selector: 'iframe', reason: 'embedded frames (ads, maps, widgets) change and load at different speeds' },
    { selector: 'marquee', reason: 'moving text' },
    { selector: '[aria-roledescription="carousel" i]', reason: 'carousels rotate their content' },
    { selector: '[class*="carousel" i]', reason: 'carousels rotate their content' },
    { selector: '[class*="slider" i]', reason: 'sliders rotate their content' },
    { selector: '[class*="swiper" i]', reason: 'sliders rotate their content' },
    { selector: '[class*="slick" i]', reason: 'sliders rotate their content' },
    { selector: 'img[src*="avatar" i], img[alt*="avatar" i], img[class*="avatar" i]', reason: 'avatars differ per user and account' },
    { selector: 'img[src*="profile" i], img[alt*="profile" i], img[class*="profile" i]', reason: 'profile pictures differ per user and account' },
    { selector: '[data-dynamic]', reason: 'marked as changing content by the developers (data-dynamic)' },
    { selector: '[aria-live]:not([aria-live="off"])', reason: 'live regions (aria-live) update while the page is open' }
];

export interface MaskSpec {
    selector: string;
    /** Regular expression source: the mask covers only matching elements (for clock and date text). */
    hasText?: string;
    reason: string;
    count: number;
}

export interface VisualPagePlan {
    /** What the test opens: a path under baseURL, or a full URL. */
    target: string;
    path: string;
    name: string;
    title?: string;
    masks: MaskSpec[];
    error?: string;
}

const DETECT_SCRIPT =
    BROWSER_PRELUDE +
    String.raw`
const pages = [];
for (const url of args.urls) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const masks = await page.evaluate(({ rules, patterns }) => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const out = [];
      const covered = new Set();
      for (const rule of rules) {
        let els = [];
        try { els = [...document.querySelectorAll(rule.selector)].filter(visible); } catch { continue; }
        if (!els.length) continue;
        els.forEach(el => covered.add(el));
        out.push({ selector: rule.selector, reason: rule.reason, count: els.length });
      }
      const res = patterns.map(p => ({ kind: p.kind, source: p.source, re: new RegExp(p.source, 'i') }));
      const autoClass = /^(css|sc|jss|emotion|styled|svelte)-|[a-f0-9]{6,}|__[A-Za-z0-9_-]{5}$/;
      const describe = el => {
        const tid = el.getAttribute('data-testid');
        if (tid) return '[data-testid="' + tid.replace(/"/g, '\\"') + '"]';
        if (el.id && !/\d{3,}|[a-f0-9]{8,}/.test(el.id)) return '#' + CSS.escape(el.id);
        const classes = [...el.classList].filter(c => !autoClass.test(c)).slice(0, 2);
        return el.tagName.toLowerCase() + classes.map(c => '.' + CSS.escape(c)).join('');
      };
      const seen = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode()) && out.length < 30) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(node.tagName)) continue;
        let inside = false;
        for (let p = node; p; p = p.parentElement) if (covered.has(p)) { inside = true; break; }
        if (inside) continue;
        const own = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
        if (!own || own.length > 200) continue;
        const hit = res.find(p => p.re.test(own));
        if (!hit || !visible(node)) continue;
        const selector = describe(node);
        const key = selector + '|' + hit.source;
        if (seen.has(key)) continue;
        seen.add(key);
        let count = 0;
        try { count = [...document.querySelectorAll(selector)].filter(e => hit.re.test(e.textContent || '')).length; } catch { continue; }
        out.push({ selector, hasText: hit.source, reason: 'its text looks like ' + hit.kind + ', which changes between runs', count: Math.max(count, 1) });
      }
      return out;
    }, { rules: args.rules, patterns: args.patterns });
    pages.push({ url: page.url(), requested: url, status: resp ? resp.status() : null, title: await page.title().catch(() => ''), masks });
  } catch (e) {
    pages.push({ url, requested: url, error: String(e.message).split('\n')[0], masks: [] });
  }
}
await browser.close();
done({ pages });
`;

/** "/" → "home", "/products.html" → "products-html". */
export function snapshotName(pagePath: string): string {
    return pagePath.replace(/[?#].*$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'home';
}

/** What a test should open: the path when the page is under the base URL, otherwise the full address. */
export function gotoTarget(url: string, baseUrl?: string): { target: string; path: string } {
    const u = new URL(url);
    const pathPart = u.pathname + u.search;
    if (baseUrl) {
        try {
            const b = new URL(baseUrl);
            if (b.origin === u.origin) return { target: pathPart, path: pathPart };
        } catch {
            // fall through
        }
    }
    return { target: u.href, path: pathPart };
}

/** Opens each page with the project's Playwright and finds the areas that change between runs. */
export async function detectMasks(store: ProjectStore, cwd: string, options: { urls: string[]; baseUrl?: string; storageState?: string; ignoreHttpsErrors?: boolean }, run: ScriptRunner = runProjectScript): Promise<{ fatal?: string; pages: VisualPagePlan[] }> {
    const payload = { urls: options.urls, rules: MASK_RULES, patterns: DYNAMIC_TEXT, storageState: options.storageState ? store.resolve(options.storageState) : undefined, ignoreHttpsErrors: options.ignoreHttpsErrors };
    const out = (await run(store, cwd, 'visual-masks', DETECT_SCRIPT, payload, 5 * 60_000)) as { fatal?: string; pages?: Array<{ url: string; requested: string; title?: string; error?: string; masks: MaskSpec[] }> };
    if (out.fatal) return { fatal: out.fatal, pages: [] };
    return { pages: planPages(out.pages ?? [], options.baseUrl) };
}

/** Builds unique test names and targets for detected pages. */
export function planPages(raw: Array<{ requested: string; title?: string; error?: string; masks: MaskSpec[] }>, baseUrl?: string): VisualPagePlan[] {
    const used = new Set<string>();
    return raw.map(p => {
        const { target, path: pagePath } = gotoTarget(p.requested, baseUrl);
        let name = snapshotName(pagePath);
        for (let i = 2; used.has(name); i++) name = `${snapshotName(pagePath)}-${i}`;
        used.add(name);
        return { target, path: pagePath, name, title: p.title, masks: p.masks, error: p.error };
    });
}

function maskLine(m: MaskSpec): string[] {
    const locator = m.hasText ? `page.locator(${quote(m.selector)}).filter({ hasText: /${m.hasText.replace(/\//g, '\\/')}/i })` : `page.locator(${quote(m.selector)})`;
    return [`// ${m.reason.replace(/\r?\n/g, ' ')}${m.count > 1 ? ` (${m.count} on the page)` : ''}`, `${locator},`];
}

/** The visual spec: one toHaveScreenshot test per page, with masks for the changing areas. */
export function renderVisualSpec(pages: VisualPagePlan[], lang: SpecLanguage, esm: boolean, options: { fullPage: boolean; maxDiffPixelRatio: number }): string {
    const imports = lang === 'ts' || esm ? [`import { expect, test } from '@playwright/test';`] : [`const { expect, test } = require('@playwright/test');`];
    const lines = [
        `// ${CREATED_HEADER}`,
        '// Visual checks: each test compares the page with its approved screenshot (the baseline).',
        '// Baselines live next to this file in visual.spec.' + lang + '-snapshots/. Masks hide areas that change on every run;',
        '// the comment above each one says why. Update baselines with quality_scan (visual, mode "approve") after a review.',
        ...imports,
        '',
        "test.describe('visual', () => {"
    ];
    for (const p of pages.filter(x => !x.error)) {
        lines.push(
            `    test(${quote(`visual: ${p.path}`)}, { tag: ['@visual'] }, async ({ page }) => {`,
            `        await page.goto(${quote(p.target)});`,
            `        await expect(page).toHaveScreenshot(${quote(`${p.name}.png`)}, {`,
            `            fullPage: ${options.fullPage},`,
            "            animations: 'disabled',",
            "            caret: 'hide',",
            `            maxDiffPixelRatio: ${options.maxDiffPixelRatio},`
        );
        if (p.masks.length) {
            lines.push('            mask: [');
            for (const m of p.masks) lines.push(...maskLine(m).map(l => `                ${l}`));
            lines.push('            ]');
        } else lines.push('            mask: []');
        lines.push('        });', '    });', '');
    }
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push('});', '');
    return lines.join('\n');
}

export interface VisualDiff {
    name: string;
    path?: string;
    title?: string;
    expected?: string;
    actual?: string;
    diff?: string;
    missingBaseline: boolean;
}

function walkPngs(dir: string, since: number, out: string[] = [], depth = 0): string[] {
    if (depth > 6 || !existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walkPngs(full, since, out, depth + 1);
        else if (/-(actual|expected|diff)\.png$/.test(name) && st.mtimeMs >= since - 1000) out.push(full);
    }
    return out;
}

/**
 * Collects expected / actual / diff images that Playwright left in test-results for failed
 * comparisons, copies them under .testpilot/reports/visual/ (test-results is cleared on the next run)
 * and returns them per snapshot.
 */
export function collectDiffs(store: ProjectStore, resultsDir: string, since: number, plan: VisualPagePlan[]): VisualDiff[] {
    const groups = new Map<string, VisualDiff>();
    for (const file of walkPngs(resultsDir, since)) {
        const m = path.basename(file).match(/^(.*)-(actual|expected|diff)\.png$/)!;
        const base = m[1].replace(/-(chromium|firefox|webkit|chrome|msedge)?-?(linux|darwin|win32)?$/, '');
        const page = plan.find(p => p.name === base || m[1].startsWith(`${p.name}-`));
        const key = page?.name ?? base;
        const entry = groups.get(key) ?? { name: key, path: page?.path, title: page?.title, missingBaseline: false };
        const target = `${VISUAL_IMAGES_DIR}/${key}-${m[2]}.png`;
        mkdirSync(path.dirname(store.resolve(target)), { recursive: true });
        copyFileSync(file, store.resolve(target));
        entry[m[2] as 'actual' | 'expected' | 'diff'] = target;
        groups.set(key, entry);
    }
    for (const g of groups.values()) g.missingBaseline = !g.expected && Boolean(g.actual);
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderVisualHtml(diffs: VisualDiff[], passed: Array<{ path: string; name: string }>, meta: { ranAt: string; reportFile: string; command: string; notes: string[] }): string {
    const e = escapeHtml;
    const img = (file: string | undefined, label: string) =>
        file ? `<figure><figcaption>${label}</figcaption><a href="${e(relativeLink(meta.reportFile, file))}"><img src="${e(relativeLink(meta.reportFile, file))}" alt="${e(label)} screenshot" loading="lazy"></a></figure>` : `<figure><figcaption>${label}</figcaption><p class="muted">Not available</p></figure>`;
    const parts = [
        '<h1>Visual comparison</h1>',
        `<p class="muted">Run on ${e(meta.ranAt.slice(0, 16).replace('T', ' '))} UTC with <code>${e(meta.command)}</code>.</p>`,
        `<div class="stats"><div class="stat"><b class="${diffs.length ? 'serious' : 'ok'}">${diffs.length}</b><span>page(s) look different</span></div><div class="stat"><b class="ok">${passed.length}</b><span>page(s) match</span></div></div>`,
        diffs.length
            ? '<p>For each page below, compare the approved look (expected) with today\'s (actual). The diff image shows changed pixels in red; click an image to open it full size. If the change is intended, approve it (quality_scan, visual, mode "approve" with the page). If not, it is a bug to report.</p>'
            : '<p class="ok"><b>Every page matches its approved screenshot.</b></p>',
        ...meta.notes.map(n => `<p class="muted">${e(n)}</p>`)
    ];
    for (const d of diffs) {
        parts.push(`<h2>${e(d.title || d.path || d.name)} ${d.path ? `<span class="muted">${e(d.path)}</span>` : ''}</h2>`);
        if (d.missingBaseline) parts.push(`<div class="card"><p>No approved screenshot yet for this page. Create baselines first (quality_scan, visual, mode "baseline").</p>${img(d.actual, 'Actual')}</div>`);
        else parts.push(`<div class="card"><div class="trio">${img(d.expected, 'Expected')}${img(d.actual, 'Actual')}${img(d.diff, 'Diff')}</div></div>`);
    }
    if (passed.length) parts.push('<h2>Matching pages</h2>', `<ul>${passed.map(p => `<li><code>${e(p.path)}</code></li>`).join('')}</ul>`);
    parts.push('<p class="muted" style="margin-top:28px">Generated by TestPilot (quality_scan, action "visual", mode "compare"). Images are copies from test-results, kept in .testpilot/reports/visual/.</p>');
    const css = `.trio { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; } figure { margin: 0; min-width: 0; } figcaption { font-weight: 600; margin-bottom: 6px; } figure img { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: 4px; background: #fff; } h2 .muted { font-size: 0.9rem; font-weight: 400; } @media (max-width: 720px) { .trio { grid-template-columns: 1fr; } }`;
    return htmlPage('Visual comparison', parts.join('\n'), css);
}
