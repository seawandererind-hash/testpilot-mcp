import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { registerUiResource, toolUiMeta, clientSupportsApps, type ViewPayload } from '../apps/ui.js';
import { insightsViewHtml, INSIGHTS_VIEW_URI } from '../apps/view.js';
import { loadEnvValues } from '../core/env.js';
import type { ProjectStore } from '../core/store.js';
import { buildCoverage, type CoverageData, renderCoverageHtml, renderCoverageMarkdown } from '../insights/coverage.js';
import { buildDashboard, buildMetrics, collectDashboardSources, METRICS_FILE, type Metrics, readSavedRuns, renderDashboardHtml } from '../insights/metrics.js';
import {
    type ExplicitLinks,
    inferRequirements,
    LINKS_FILE,
    readJiraRequirements,
    readRequirementsFile,
    readSavedLinks,
    readSavedRequirements,
    REQUIREMENTS_FILE,
    RequirementsError,
    type RequirementSet,
    saveLinks,
    saveRequirements
} from '../insights/requirements.js';
import { REPORTS_DIR } from '../report/report.js';
import { readLatestRun } from '../run/playwright.js';
import { ImportError } from '../testcases/importers/types.js';
import { failure, guarded, openProject, projectRootArg, result, type ServerOptions, WRITES_STATE } from './common.js';

const COVERAGE_HTML = `${REPORTS_DIR}/coverage.html`;
const COVERAGE_MD = `${REPORTS_DIR}/coverage.md`;
const DASHBOARD_HTML = `${REPORTS_DIR}/team-dashboard.html`;
/** Most requirement rows sent to the chat view; the HTML report always has all of them. */
const VIEW_ROW_LIMIT = 400;

type InsightsArgs = {
    projectRoot?: string;
    action: 'coverage' | 'metrics' | 'dashboard';
    requirementsFile?: string;
    sheet?: string;
    jql?: string;
    limit: number;
    links?: Record<string, string[]>;
    manualMinutesPerCase?: number;
    team?: string;
    sources?: string[];
    includeThisRepo: boolean;
};

export function registerInsightsTools(server: McpServer, options: ServerOptions): void {
    registerUiResource(server, {
        name: 'insights-view',
        uri: INSIGHTS_VIEW_URI,
        title: 'TestPilot insights view',
        description: 'Interactive coverage heat map and metrics cards shown inside the chat by AI tools that support MCP Apps.',
        html: insightsViewHtml
    });

    server.registerTool(
        'insights',
        {
            title: 'Coverage map, metrics and team dashboard',
            description:
                'Shows how well tests cover the requirements and how automation is going. ' +
                'action "coverage" builds the requirement to test case to automated test to latest result map: requirements come from requirementsFile (CSV or Excel with id, title, area, priority columns), from jql (Jira stories or epics, read-only, using the Jira keys in .env), from the last saved list, or else are inferred from test-case areas (clearly marked as inferred). ' +
                'Cases are linked when a requirement id appears in their tags, title, description or source, through Jira issue links, or through explicit links you pass. Writes .testpilot/reports/coverage.html (for managers) and coverage.md, and saves the requirements and links under .testpilot/requirements/. ' +
                'action "metrics" writes .testpilot/reports/metrics.json for this repository: case counts, requirement coverage, latest pass rate, flaky rate across saved runs, runs in the last 30 days and an estimate of manual hours saved. ' +
                'action "dashboard" combines several metrics.json files (sources: files, folders where CI drops them, or other repository roots) into .testpilot/reports/team-dashboard.html. ' +
                'AI tools that support MCP Apps also show the result as an interactive view in the chat.',
            inputSchema: z.object({
                projectRoot: projectRootArg,
                action: z.enum(['coverage', 'metrics', 'dashboard']).default('coverage').describe('"coverage" for the traceability map, "metrics" for this repository\'s numbers, "dashboard" to combine several repositories'),
                requirementsFile: z.string().optional().describe('Action "coverage": path inside the repository of a CSV or .xlsx file listing requirements (columns such as id, title, area or feature, priority; optional tests column with case ids)'),
                sheet: z.string().optional().describe('Excel sheet name for requirementsFile (default: the first visible sheet)'),
                jql: z.string().optional().describe('Action "coverage": Jira JQL that selects the requirements, e.g. project = SHOP AND issuetype in (Story, Epic). Read-only; uses JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN from .env'),
                limit: z.number().int().min(1).max(5000).default(1000).describe('Most Jira issues to read for jql'),
                links: z
                    .record(z.string(), z.array(z.string()))
                    .optional()
                    .describe('Action "coverage": extra links from test-case id to requirement ids, e.g. {"TC-001": ["REQ-1"]}. Saved to .testpilot/requirements/links.json and used from then on'),
                manualMinutesPerCase: z.number().min(0.5).max(480).optional().describe('Action "metrics": minutes a person needs to run one test case by hand, for the hours-saved estimate (default 5, or the value used last time)'),
                team: z.string().max(80).optional().describe('Action "metrics": team name shown on the team dashboard'),
                sources: z
                    .array(z.string())
                    .max(100)
                    .optional()
                    .describe('Action "dashboard": metrics.json files, folders holding one per team (e.g. a shared folder CI writes to), or other repository roots. On this machine absolute paths outside the project may be given; they are only read'),
                includeThisRepo: z.boolean().default(true).describe('Action "dashboard": also include this repository (its metrics are refreshed first)')
            }),
            annotations: { ...WRITES_STATE, openWorldHint: true },
            _meta: toolUiMeta(INSIGHTS_VIEW_URI)
        },
        guarded('insights', options, async (args: InsightsArgs, ctx: unknown) => {
            const { store } = openProject(options, args.projectRoot);
            const project = projectName(store);
            const rerunBase = args.projectRoot ? { projectRoot: args.projectRoot } : {};
            const inChat = clientSupportsApps(server, ctx) ? '\nThe interactive view is shown in the chat.' : '';

            if (args.action === 'coverage') {
                let set: RequirementSet;
                try {
                    set = await requirementsFor(store, args);
                } catch (error) {
                    if (error instanceof RequirementsError || error instanceof ImportError) return failure(error.message);
                    throw error;
                }
                const cases = store.readCases();
                if (!cases.length && set.source === 'inferred') return failure('There are no test cases and no requirements yet. Import test cases with import_test_cases, or give a requirementsFile or jql to see which requirements have no tests.');
                const fresh = Boolean(args.requirementsFile || args.jql);
                if (fresh) {
                    saveRequirements(store, set);
                    store.recordDecision(`Coverage map uses ${set.requirements.length} requirement(s) from ${set.source === 'jira' ? `Jira (${set.ref})` : set.ref}`, 'insights coverage', 'user');
                }
                let links = readSavedLinks(store);
                if (args.links && Object.keys(args.links).length) {
                    links = { ...links, ...cleanLinks(args.links) };
                    saveLinks(store, links);
                    store.recordDecision(`Linked ${Object.keys(args.links).length} test case(s) to requirements by hand`, 'insights coverage links', 'user');
                }
                const data = buildCoverage({ project, set, cases, run: readLatestRun(store), links });
                store.write(COVERAGE_HTML, renderCoverageHtml(data));
                store.write(COVERAGE_MD, renderCoverageMarkdown(data));
                const files = [COVERAGE_HTML, COVERAGE_MD, ...(fresh ? [REQUIREMENTS_FILE] : []), ...(args.links ? [LINKS_FILE] : [])];
                const t = data.totals;
                const gaps = data.rows.filter(r => r.state === 'missing');
                const summary = [
                    data.inferred
                        ? `No requirements were given, so the ${t.requirements} test-case area(s) are used as requirements (inferred, not true requirement coverage). Give requirementsFile or jql for a real map.`
                        : `Requirements: ${t.requirements} from ${set.source === 'jira' ? 'Jira' : set.ref}${!fresh ? ` (saved list from ${set.readAt.slice(0, 10)})` : ''}.`,
                    `${t.pctWithTests}% have at least one test case, ${t.pctAutomated}% have an automated test, ${t.pctPassing}% are automated and passing.`,
                    `${t.missing} requirement(s) have no tests${gaps.length ? `: ${gaps.slice(0, 8).map(r => r.id).join(', ')}${gaps.length > 8 ? ', ...' : ''}` : ''}. ${t.failing} have a failing or flaky test.`,
                    data.unlinkedCases.length ? `${data.unlinkedCases.length} test case(s) are not linked to any requirement (add the requirement id to their tags, or pass links).` : '',
                    `Report: ${COVERAGE_HTML} (open in a browser) and ${COVERAGE_MD}.${inChat}`
                ]
                    .filter(Boolean)
                    .join('\n');
                return result(summary, coveragePayload(data, files, { tool: 'insights', arguments: { ...rerunBase, action: 'coverage' } }));
            }

            if (args.action === 'metrics') {
                const metrics = writeMetrics(store, project, args);
                const m = metrics;
                const summary = [
                    `${m.cases.total} test case(s): ${m.cases.automated} automated (${m.cases.pctAutomated}%), ${m.cases.manual} manual, ${m.cases.rework} need rework.`,
                    m.requirements ? `Requirements with at least one test: ${m.requirements.pctWithTests}% of ${m.requirements.total}.` : 'Requirement coverage is not known yet (run insights with action "coverage" and a requirements file or Jira query).',
                    m.latestRun ? `Latest run ${m.latestRun.at.slice(0, 10)}: ${m.latestRun.passRate}% passed.` : 'No test runs saved yet.',
                    `Flaky rate across ${m.flaky.runsConsidered} saved run(s): ${m.flaky.ratePct}% (${m.flaky.flakyTests} of ${m.flaky.testsSeen} tests). Runs in the last 30 days: ${m.runsLast30Days}.`,
                    `Manual hours saved in the last 30 days: about ${m.manualHoursSaved.last30Days} (estimate: ${m.manualHoursSaved.automatedCases} automated cases x ${m.runsLast30Days} runs x ${m.manualHoursSaved.minutesPerCase} min).`,
                    `Written to ${METRICS_FILE}. Teams can collect these files (for example from CI) into one folder and build a dashboard with action "dashboard".${inChat}`
                ].join('\n');
                return result(summary, { view: 'metrics', title: `Test automation metrics: ${project}`, subtitle: `Generated ${m.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, metrics: m, files: [METRICS_FILE], rerun: { tool: 'insights', arguments: { ...rerunBase, action: 'metrics' } } } satisfies ViewPayload);
            }

            // dashboard
            const sources = [...(args.sources ?? [])];
            if (args.includeThisRepo) {
                writeMetrics(store, project, args);
                sources.unshift(METRICS_FILE);
            }
            if (!sources.length) return failure('Give sources: metrics.json files, a folder where each team\'s CI drops its metrics.json, or other repository roots.');
            const resolve = (p: string) => {
                if (options.mode === 'remote') return store.resolve(p);
                return path.isAbsolute(p) ? p : path.resolve(store.root, p);
            };
            const input = collectDashboardSources(sources, resolve);
            if (!input.entries.length) return failure(`No TestPilot metrics.json found in the sources.${input.skipped.length ? ` ${input.skipped.map(s => `${s.path}: ${s.reason}`).join('; ')}.` : ''}`);
            const data = buildDashboard(input);
            store.write(DASHBOARD_HTML, renderDashboardHtml(data));
            const t = data.totals;
            const summary = [
                `Team dashboard: ${t.teams} team(s) or repositories, ${t.cases} test cases, ${t.pctAutomated}% automated${t.avgPassRate !== undefined ? `, average latest pass rate ${t.avgPassRate}%` : ''}.`,
                `Runs in the last 30 days: ${t.runsLast30Days}. Manual hours saved in that time: about ${t.hoursSaved30} (an estimate).`,
                input.skipped.length ? `Not used: ${input.skipped.map(s => `${s.path} (${s.reason})`).join(', ')}.` : '',
                `Written to ${DASHBOARD_HTML} (open in a browser).${inChat}`
            ]
                .filter(Boolean)
                .join('\n');
            return result(summary, {
                view: 'dashboard',
                title: 'Team test dashboard',
                totals: t,
                teams: data.teams.map(row => ({
                    team: row.team,
                    project: row.project,
                    cases: row.latest.cases.total,
                    automatedPct: row.latest.cases.pctAutomated,
                    requirementsWithTestsPct: row.latest.requirements?.pctWithTests,
                    passRate: row.latest.latestRun?.passRate,
                    flakyPct: row.latest.flaky.ratePct,
                    runsLast30Days: row.latest.runsLast30Days,
                    hoursSaved30: row.latest.manualHoursSaved.last30Days,
                    updated: row.latest.generatedAt.slice(0, 10)
                })),
                skipped: input.skipped,
                files: [DASHBOARD_HTML, ...(args.includeThisRepo ? [METRICS_FILE] : [])],
                rerun: { tool: 'insights', arguments: { ...rerunBase, action: 'dashboard', ...(args.sources ? { sources: args.sources } : {}), includeThisRepo: args.includeThisRepo } }
            } satisfies ViewPayload);
        })
    );
}

function projectName(store: ProjectStore): string {
    try {
        return store.readConfig().project.name ?? path.basename(store.root);
    } catch {
        return path.basename(store.root);
    }
}

async function requirementsFor(store: ProjectStore, args: InsightsArgs): Promise<RequirementSet> {
    if (args.requirementsFile) return readRequirementsFile(store, args.requirementsFile, args.sheet);
    if (args.jql) return readJiraRequirements(store, args.jql, loadEnvValues(store), args.limit);
    return readSavedRequirements(store) ?? inferRequirements(store.readCases());
}

function cleanLinks(links: Record<string, string[]>): ExplicitLinks {
    const out: ExplicitLinks = {};
    for (const [caseId, reqs] of Object.entries(links)) {
        const id = caseId.trim().slice(0, 120);
        if (id) out[id] = [...new Set((reqs ?? []).map(r => String(r).trim().slice(0, 120)).filter(Boolean))];
    }
    return out;
}

/** Saved requirements (not inferred ones) count as known requirement coverage in metrics. */
function writeMetrics(store: ProjectStore, project: string, args: InsightsArgs): Metrics {
    const previous = (() => {
        try {
            return JSON.parse(store.read(METRICS_FILE) ?? 'null') as Partial<Metrics> | null;
        } catch {
            return null;
        }
    })();
    const minutesPerCase = args.manualMinutesPerCase ?? previous?.manualHoursSaved?.minutesPerCase ?? 5;
    const cases = store.readCases();
    const saved = readSavedRequirements(store);
    const coverage: CoverageData | undefined = saved ? buildCoverage({ project, set: saved, cases, run: readLatestRun(store), links: readSavedLinks(store) }) : undefined;
    const metrics = buildMetrics({ project, team: args.team ?? previous?.team, cases, runs: readSavedRuns(store), latest: readLatestRun(store), coverage, minutesPerCase });
    store.write(METRICS_FILE, JSON.stringify(metrics, null, 2) + '\n');
    return metrics;
}

/** A compact coverage payload for structuredContent and the chat view. */
function coveragePayload(d: CoverageData, files: string[], rerun: ViewPayload['rerun']): ViewPayload {
    return {
        view: 'coverage',
        title: `Requirement coverage: ${d.project}`,
        subtitle: `${d.inferred ? 'Requirements inferred from test-case areas' : `Requirements from ${d.source === 'jira' ? 'Jira' : d.sourceRef}`}${d.run ? ` · latest run ${d.run.at.slice(0, 16).replace('T', ' ')} UTC` : ' · no test run yet'}`,
        inferred: d.inferred,
        source: d.source,
        totals: d.totals,
        areas: d.areas,
        rows: d.rows.slice(0, VIEW_ROW_LIMIT).map(r => ({ id: r.id, title: r.title, area: r.area, priority: r.priority, state: r.state, cases: r.cases.length, caseIds: r.cases.map(c => `${c.id} (${c.state})`) })),
        truncated: d.rows.length > VIEW_ROW_LIMIT,
        unlinkedCases: d.unlinkedCases.slice(0, 100).map(c => c.id),
        warnings: d.warnings,
        files,
        rerun
    };
}
