import { APP_TYPE_OPTIONS, EXECUTION_OPTIONS, findFramework, PATTERN_OPTIONS } from '../catalog/frameworks.js';
import { digestOf } from '../core/confirm.js';
import type { Config, TestCase } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { PLAN_FILE } from '../core/store.js';
import { ownedMarkdown } from '../knowledge/generate.js';
import { GENERATED_HEADER } from '../scaffold/engine.js';

export const PLAN_META_FILE = '.testpilot/plan.json';

export interface PlanMeta {
    generatedAt: string;
    digest: string;
    waves: Array<{ number: number; name: string; ids: string[] }>;
    manual: string[];
    rework: string[];
    duplicates: string[];
    unreviewed: string[];
    approved?: { by: string; at: string; digest: string; via: string };
}

const PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 };
const EFFORT_RANK = { S: 0, M: 1, L: 2 } as const;

function rank(tc: TestCase): number[] {
    const smoke = tc.tags.some(t => /smoke|sanity|critical/i.test(t)) ? 0 : 1;
    return [PRIORITY_RANK[tc.priority ?? ''] ?? 1, smoke, EFFORT_RANK[tc.automation?.effort ?? 'M']];
}

function byRank(a: TestCase, b: TestCase): number {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.id.localeCompare(b.id, undefined, { numeric: true });
}

export interface PlanOptions {
    wave1Size: number;
    wave2Size: number;
}

/**
 * Splits reviewed cases into waves: critical paths first (P1 or smoke, not large),
 * then core regression, then the rest. Cases already automated keep their wave.
 */
export function buildPlan(cases: TestCase[], options: PlanOptions): PlanMeta {
    const reviewed = cases.filter(tc => tc.review);
    const unreviewed = cases.filter(tc => !tc.review).map(tc => tc.id);
    const duplicates = reviewed.filter(tc => tc.review!.duplicateOf.length && tc.review!.verdict !== 'MANUAL').map(tc => tc.id);
    const manual = reviewed.filter(tc => tc.review!.verdict === 'MANUAL').map(tc => tc.id);
    const rework = reviewed.filter(tc => tc.review!.verdict === 'NEEDS-REWORK' && !duplicates.includes(tc.id)).map(tc => tc.id);
    const automate = reviewed.filter(tc => tc.review!.verdict === 'AUTOMATE' && !duplicates.includes(tc.id)).sort(byRank);

    const waves = new Map<number, string[]>([
        [1, []],
        [2, []],
        [3, []]
    ]);
    const pinned = (tc: TestCase) => tc.automation?.wave && ['generated', 'passing', 'failing'].includes(tc.automation.status ?? '');
    for (const tc of automate.filter(pinned)) waves.get(tc.automation!.wave!)?.push(tc.id) ?? waves.set(tc.automation!.wave!, [tc.id]);
    const free = automate.filter(tc => !pinned(tc));
    const critical = free.filter(tc => (tc.priority === 'P1' || tc.tags.some(t => /smoke|sanity|critical/i.test(t))) && tc.automation?.effort !== 'L');
    const wave1 = (critical.length ? critical : free).slice(0, Math.max(0, options.wave1Size - waves.get(1)!.length));
    waves.get(1)!.push(...wave1.map(tc => tc.id));
    const rest = free.filter(tc => !wave1.includes(tc));
    const core = rest.filter(tc => (tc.priority ?? 'P2') !== 'P3' && tc.automation?.effort !== 'L').slice(0, options.wave2Size);
    waves.get(2)!.push(...core.map(tc => tc.id));
    waves.get(3)!.push(...rest.filter(tc => !core.includes(tc)).map(tc => tc.id));

    const names: Record<number, string> = { 1: 'Critical paths', 2: 'Core regression', 3: 'Extended coverage' };
    const waveList = [...waves.entries()].filter(([, ids]) => ids.length).sort(([a], [b]) => a - b).map(([number, ids]) => ({ number, name: names[number] ?? `Wave ${number}`, ids }));
    const meta: PlanMeta = { generatedAt: new Date().toISOString(), digest: '', waves: waveList, manual, rework, duplicates, unreviewed };
    meta.digest = digestOf({ waves: waveList, manual, rework, duplicates });
    return meta;
}

export function readPlanMeta(store: ProjectStore): PlanMeta | undefined {
    const raw = store.read(PLAN_META_FILE);
    return raw ? (JSON.parse(raw) as PlanMeta) : undefined;
}

export function isApproved(meta: PlanMeta | undefined): boolean {
    return Boolean(meta?.approved && meta.approved.digest === meta.digest);
}

const label = (options: Array<{ value: string; label: string }>, value?: string) => options.find(o => o.value === value)?.label ?? value ?? 'not set';

/** Renders plans/automation-plan.md. Sections between keep markers survive regeneration. */
export function renderPlan(meta: PlanMeta, cases: TestCase[], config: Config): string {
    const byId = new Map(cases.map(tc => [tc.id, tc]));
    const row = (id: string) => {
        const tc = byId.get(id);
        if (!tc) return `| ${id} | (missing) | | | |`;
        const status = tc.automation?.status && tc.automation.status !== 'planned' ? ` (${tc.automation.status})` : '';
        return `| ${id} | ${cell(tc.title)}${status} | ${cell(tc.area ?? 'General')} | ${tc.priority ?? '-'} | ${tc.automation?.effort ?? '-'} |`;
    };
    const total = meta.waves.reduce((n, w) => n + w.ids.length, 0);
    const hooks = new Set<string>();
    const complex: string[] = [];
    for (const w of meta.waves) {
        for (const id of w.ids) {
            const tc = byId.get(id);
            for (const s of tc?.review?.suggestions ?? []) if (s.startsWith('For ')) hooks.add(s.replace(/^For /, '').replace(/\.$/, ''));
            if (tc?.automation?.effort === 'L') complex.push(id);
        }
    }
    const areas = new Map<string, { automate: number; manual: number; rework: number }>();
    const bump = (id: string, key: 'automate' | 'manual' | 'rework') => {
        const area = byId.get(id)?.area ?? 'General';
        const entry = areas.get(area) ?? { automate: 0, manual: 0, rework: 0 };
        entry[key]++;
        areas.set(area, entry);
    };
    meta.waves.forEach(w => w.ids.forEach(id => bump(id, 'automate')));
    meta.manual.forEach(id => bump(id, 'manual'));
    meta.rework.forEach(id => bump(id, 'rework'));

    const framework = (config.appType && findFramework(config.appType, config.stack.framework ?? '')?.label) ?? config.stack.framework ?? 'not chosen';
    const lines = [
        `<!-- ${GENERATED_HEADER} -->`,
        `# Automation plan${config.project.name ? `: ${config.project.name}` : ''}`,
        '',
        meta.approved && meta.approved.digest === meta.digest
            ? `**Status: approved** by ${meta.approved.by} on ${meta.approved.at.slice(0, 10)}.`
            : `**Status: draft, waiting for approval.** Generated ${meta.generatedAt.slice(0, 10)}. Tests are generated only after a named person approves this plan.`,
        '',
        '## Summary',
        '',
        `- ${total} test case(s) to automate in ${meta.waves.length} wave(s); ${meta.manual.length} stay manual; ${meta.rework.length} need rework first${meta.duplicates.length ? `; ${meta.duplicates.length} duplicate(s) left out` : ''}.`,
        `- App: ${label(APP_TYPE_OPTIONS, config.appType)}${config.app.ref ? ` (${config.app.ref})` : ''}.`,
        `- Stack: ${framework}, ${config.stack.language ?? ''}, ${label(PATTERN_OPTIONS, config.stack.pattern)}; runs on ${label(EXECUTION_OPTIONS, config.execution.target)}.`,
        meta.unreviewed.length ? `- ${meta.unreviewed.length} case(s) were not reviewed yet and are not in this plan: ${meta.unreviewed.slice(0, 10).join(', ')}${meta.unreviewed.length > 10 ? ', …' : ''}.` : '',
        '',
        '## Coverage by area',
        '',
        '| Area | Automate | Manual | Rework first |',
        '|---|---|---|---|',
        ...[...areas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, n]) => `| ${cell(area)} | ${n.automate} | ${n.manual} | ${n.rework} |`),
        ''
    ];
    for (const w of meta.waves) {
        lines.push(`## Wave ${w.number}: ${w.name} (${w.ids.length})`, '', waveWhy(w.number), '', '| ID | Title | Area | Priority | Effort |', '|---|---|---|---|---|', ...w.ids.map(row), '');
    }
    if (meta.manual.length) lines.push('## Kept manual', '', 'These need human judgement or physical interaction. Run them by hand each release.', '', '| ID | Title | Area | Priority | Effort |', '|---|---|---|---|---|', ...meta.manual.map(row), '');
    if (meta.rework.length) {
        lines.push('## Needs rework before automation', '', 'Fix these with the case owner (missing steps, vague or missing expected results), then re-import or edit them and review again.', '');
        for (const id of meta.rework) lines.push(`- **${id}** ${cell(byId.get(id)?.title ?? '')}: ${byId.get(id)?.review?.issues.slice(0, 2).join(' ') ?? ''}`);
        lines.push('');
    }
    if (meta.duplicates.length) {
        lines.push('## Duplicates left out', '');
        for (const id of meta.duplicates) lines.push(`- ${id} duplicates ${byId.get(id)?.review?.duplicateOf.join(', ')}`);
        lines.push('');
    }
    lines.push(
        '## Approach',
        '',
        `- ${label(PATTERN_OPTIONS, config.stack.pattern)}: one page or screen object per area; tests call page objects and never use raw selectors.`,
        '- Locators by role and accessible name first, test ids second; no XPath unless nothing else works.',
        '- Each test carries its test-case id in the title and as a tag, so results map back to the source.',
        '- Test data comes from test-data/ and .env; tests create what they need and do not depend on each other.',
        '- No fixed waits; tests wait for conditions.',
        '',
        '## Risks and assumptions',
        '',
        `- Tests run against the test environment${config.app.ref ? ` (${config.app.ref})` : ''}, never production.`,
        '- Test accounts exist in that environment and their credentials are in .env (or CI secrets).',
        ...[...hooks].map(h => `- Needs ${h}.`),
        complex.length ? `- Larger cases (${complex.slice(0, 8).join(', ')}${complex.length > 8 ? ', …' : ''}) involve uploads, downloads, frames or hooks; expect extra effort.` : '',
        '- A test counts as done after it passes twice in a row.',
        '',
        '## Definition of done for each wave',
        '',
        '- Every test in the wave is generated, completed (no TODOs) and passes twice in a row.',
        '- Failures that are real bugs are reported, linked to the test-case id, and the test is tagged @known-issue.',
        '- Results are published to the report and, if configured, the test-management tool.',
        '',
        '## Notes',
        '',
        '<!-- keep -->',
        '<!-- Anything you write between these markers survives when TestPilot regenerates the plan. -->',
        '<!-- /keep -->',
        ''
    );
    return lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
}

function waveWhy(n: number): string {
    switch (n) {
        case 1:
            return 'Highest priority, smallest effort: the paths that must never break. Automated first so the team gets value quickly.';
        case 2:
            return 'The rest of the important regression cases.';
        default:
            return 'Lower priority or larger cases, automated once the first waves are stable.';
    }
}

function cell(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Writes the plan files and records each case's wave. */
export function savePlan(store: ProjectStore, meta: PlanMeta, config: Config): { planFileKept: boolean } {
    const cases = store.readCases();
    const waveOf = new Map<string, number>();
    meta.waves.forEach(w => w.ids.forEach(id => waveOf.set(id, w.number)));
    for (const tc of cases) {
        const wave = waveOf.get(tc.id);
        const before = JSON.stringify(tc.automation ?? {});
        if (wave !== undefined) tc.automation = { ...tc.automation, wave, status: tc.automation?.status && tc.automation.status !== 'manual' ? tc.automation.status : 'planned' };
        else if (meta.manual.includes(tc.id)) tc.automation = { ...tc.automation, wave: undefined, status: 'manual' };
        else if (tc.automation?.wave !== undefined && !['generated', 'passing', 'failing'].includes(tc.automation.status ?? '')) tc.automation = { ...tc.automation, wave: undefined, status: undefined };
        if (JSON.stringify(tc.automation ?? {}) !== before) store.writeCase(tc);
    }
    store.write(PLAN_META_FILE, JSON.stringify(meta, null, 2) + '\n');
    const planned = ownedMarkdown(store, PLAN_FILE, renderPlan(meta, store.readCases(), config));
    if (planned.status !== 'skip') store.write(PLAN_FILE, planned.content);
    return { planFileKept: planned.status === 'skip' };
}
