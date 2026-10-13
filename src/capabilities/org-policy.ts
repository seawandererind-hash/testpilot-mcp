import YAML from 'yaml';
import * as z from 'zod/v4';

import { CI_PROVIDERS, type Config } from '../core/schema.js';
import type { ProjectStore } from '../core/store.js';
import { inTestRoot } from '../scaffold/engine.js';
import { type CapabilityPlan, emptyPlan, fetchText, type PlanOutcome, walk } from './shared.js';

export const POLICY_FILE = '.testpilot/org-policy.yaml';
export const POLICY_SOURCE_FILE = '.testpilot/org-policy.source';
export const POLICY_REPORT = '.testpilot/reports/policy.md';

const regex = z.string().refine(
    s => {
        try {
            new RegExp(s);
            return true;
        } catch {
            return false;
        }
    },
    { message: 'is not a valid regular expression' }
);

export const OrgPolicySchema = z
    .object({
        name: z.string().optional(),
        version: z.union([z.string(), z.number()]).optional(),
        allowedFrameworks: z.array(z.string()).optional(),
        allowedLanguages: z.array(z.string()).optional(),
        allowedPatterns: z.array(z.string()).optional(),
        requiredTags: z
            .array(z.union([z.string().transform(tag => ({ tag, min: 1 })), z.object({ tag: z.string(), min: z.number().int().min(1).default(1) })]))
            .optional(),
        testNamePattern: regex.optional(),
        ci: z.union([z.enum(CI_PROVIDERS), z.array(z.enum(CI_PROVIDERS))]).optional(),
        reporting: z.array(z.string()).optional(),
        forbidden: z
            .array(
                z.union([
                    z.string().transform(pattern => ({ pattern, regex: false, message: undefined as string | undefined })),
                    z.object({ pattern: z.string(), regex: z.boolean().default(false), message: z.string().optional() })
                ])
            )
            .optional()
    })
    .strict();
export type OrgPolicy = z.infer<typeof OrgPolicySchema>;

/** Parses and validates a policy file, with readable errors for whoever maintains it. */
export function parsePolicy(text: string): { policy: OrgPolicy } | { error: string } {
    let raw: unknown;
    try {
        raw = YAML.parse(text, { maxAliasCount: 50 });
    } catch (error) {
        return { error: `The policy is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'The policy file is empty or not a list of keys.' };
    const parsed = OrgPolicySchema.safeParse(raw);
    if (!parsed.success) {
        return { error: `The policy has problems: ${parsed.error.issues.map(i => `${i.path.join('.') || '(top level)'} ${i.message}`).join('; ')}.` };
    }
    for (const f of parsed.data.forbidden ?? []) {
        if (f.regex) {
            try {
                new RegExp(f.pattern);
            } catch {
                return { error: `forbidden pattern "${f.pattern}" is not a valid regular expression.` };
            }
        }
    }
    return { policy: parsed.data };
}

export interface RuleResult {
    rule: string;
    ok: boolean;
    details: string;
    fix?: string;
}

export interface SpecTest {
    file: string;
    line: number;
    title: string;
    tags: string[];
}

const TEST_CALL = /\b(?:test|it)(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Test titles and tags found in a spec file (simple static reading; titles built at run time are not seen). */
export function extractTests(file: string, content: string): SpecTest[] {
    const out: SpecTest[] = [];
    for (const m of content.matchAll(TEST_CALL)) {
        const start = m.index ?? 0;
        const before = content.slice(Math.max(0, start - 1), start);
        if (before === '.') continue; // e.g. something.test(...)
        const title = m[2];
        const after = content.slice(start + m[0].length, start + m[0].length + 400);
        const options = after.split(/async\s*\(|=>|function\s*\(/)[0];
        const tags = new Set<string>([...title.matchAll(/@[\w-]+/g)].map(t => t[0]));
        const tagOption = options.match(/tag\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/);
        if (tagOption) for (const t of tagOption[1].matchAll(/['"](@[\w-]+)['"]/g)) tags.add(t[1]);
        out.push({ file, line: content.slice(0, start).split('\n').length, title, tags: [...tags] });
    }
    return out;
}

const CI_FILES: Record<string, (store: ProjectStore) => boolean> = {
    'github-actions': store => store.list('.github/workflows', n => /\.ya?ml$/.test(n)).length > 0,
    'azure-devops': store => store.exists('azure-pipelines.yml'),
    gitlab: store => store.exists('.gitlab-ci.yml'),
    jenkins: store => store.exists('Jenkinsfile'),
    none: () => true
};

const matchesAllowed = (value: string | undefined, allowed: string[]) => Boolean(value) && allowed.some(a => a.toLowerCase() === value!.toLowerCase() || value!.toLowerCase().startsWith(`${a.toLowerCase()}-`));

/** Checks the repository against the policy. Reads only; nothing is written. */
export function checkPolicy(store: ProjectStore, config: Config, policy: OrgPolicy): { results: RuleResult[]; testsFound: number; filesScanned: number } {
    const results: RuleResult[] = [];
    const list = (a: string[]) => a.join(', ');
    if (policy.allowedFrameworks) {
        const fw = config.stack.framework;
        results.push({ rule: 'Allowed frameworks', ok: matchesAllowed(fw, policy.allowedFrameworks), details: `Uses ${fw ?? 'none chosen'}; allowed: ${list(policy.allowedFrameworks)}.`, fix: `Choose one of ${list(policy.allowedFrameworks)} in the wizard (step FRAMEWORK), or ask the policy owners for an exception.` });
    }
    if (policy.allowedLanguages) {
        const lang = config.stack.language;
        results.push({ rule: 'Allowed languages', ok: matchesAllowed(lang, policy.allowedLanguages), details: `Uses ${lang ?? 'none chosen'}; allowed: ${list(policy.allowedLanguages)}.`, fix: `Choose one of ${list(policy.allowedLanguages)} in the wizard (step LANGUAGE).` });
    }
    if (policy.allowedPatterns) {
        const pattern = config.stack.pattern;
        results.push({ rule: 'Allowed patterns', ok: matchesAllowed(pattern, policy.allowedPatterns), details: `Uses ${pattern ?? 'none chosen'}; allowed: ${list(policy.allowedPatterns)}.`, fix: `Choose one of ${list(policy.allowedPatterns)} in the wizard (step PATTERN).` });
    }
    if (policy.ci) {
        const allowed = Array.isArray(policy.ci) ? policy.ci : [policy.ci];
        const chosen = config.integrations.ci;
        const okChoice = Boolean(chosen) && allowed.includes(chosen!);
        const hasFile = okChoice && CI_FILES[chosen!]?.(store);
        results.push({
            rule: 'CI system',
            ok: Boolean(okChoice && hasFile),
            details: !okChoice ? `CI is ${chosen ?? 'not chosen'}; required: ${list(allowed)}.` : hasFile ? `Uses ${chosen} and its pipeline file is in the repository.` : `Uses ${chosen} but no pipeline file was found.`,
            fix: !okChoice ? `Pick ${list(allowed)} in the wizard (step CI).` : 'Write the pipeline with publish_results (action "ci") and commit it.'
        });
    }
    if (policy.reporting) {
        const have = config.integrations.reporting ?? [];
        const missing = policy.reporting.filter(r => !have.includes(r));
        results.push({ rule: 'Reporting', ok: !missing.length, details: missing.length ? `Missing ${list(missing)} (has ${have.length ? list(have) : 'none'}).` : `Has ${list(policy.reporting)}.`, fix: `Add ${list(missing)} in the wizard (step REPORTING) and run regenerate_docs / scaffold_project again.` });
    }

    const roots = [...new Set([inTestRoot(config, 'tests'), inTestRoot(config, 'test'), inTestRoot(config, 'src'), inTestRoot(config, 'features')])].filter(d => store.exists(d));
    const codeFiles = roots.flatMap(dir => walk(store, dir, f => /\.(ts|js|mjs|cjs|tsx|jsx|java|py|cs|feature)$/.test(f)));
    const specFiles = codeFiles.filter(f => /\.(spec|test)\.(ts|js|mjs|cjs|tsx|jsx)$/.test(f) || f.endsWith('.setup.ts') || f.endsWith('.setup.js'));
    const tests = specFiles.filter(f => !/\.setup\.(ts|js)$/.test(f)).flatMap(f => extractTests(f, store.read(f) ?? ''));

    if (policy.testNamePattern) {
        const re = new RegExp(policy.testNamePattern);
        const bad = tests.filter(t => !re.test(t.title));
        results.push({
            rule: 'Test names',
            ok: tests.length > 0 && !bad.length,
            details: !tests.length ? 'No tests found to check.' : bad.length ? `${bad.length} of ${tests.length} test title(s) do not match /${policy.testNamePattern}/:\n${bad.slice(0, 15).map(t => `  - ${t.file}:${t.line} "${t.title.slice(0, 100)}"`).join('\n')}${bad.length > 15 ? `\n  - …and ${bad.length - 15} more` : ''}` : `All ${tests.length} test title(s) match /${policy.testNamePattern}/.`,
            fix: 'Rename those tests so the title starts the way the policy asks (usually the test-case id, e.g. "SHOP-12 Add to cart").'
        });
    }
    for (const req of policy.requiredTags ?? []) {
        const count = tests.filter(t => t.tags.includes(req.tag)).length;
        results.push({ rule: `Tag ${req.tag}`, ok: count >= req.min, details: `${count} test(s) tagged ${req.tag}; at least ${req.min} required.`, fix: `Add ${req.tag} to the most important tests, in the title or with { tag: ['${req.tag}'] }.` });
    }
    for (const f of policy.forbidden ?? []) {
        const re = f.regex ? new RegExp(f.pattern) : undefined;
        const hits: string[] = [];
        for (const file of codeFiles) {
            const lines = (store.read(file) ?? '').split('\n');
            lines.forEach((line, i) => {
                const text = line.slice(0, 2000);
                // Comments that warn against the pattern (e.g. "never use waitForTimeout") are not uses of it.
                if (/^\s*(\/\/|\/?\*|#)/.test(text)) return;
                if (re ? re.test(text) : text.includes(f.pattern)) hits.push(`${file}:${i + 1}`);
            });
        }
        results.push({
            rule: `Forbidden: ${f.pattern}`,
            ok: !hits.length,
            details: hits.length ? `Found ${hits.length} time(s): ${hits.slice(0, 15).join(', ')}${hits.length > 15 ? ', …' : ''}` : 'Not used.',
            fix: f.message ?? `Remove ${f.pattern} from those files.`
        });
    }
    return { results, testsFound: tests.length, filesScanned: codeFiles.length };
}

export function renderPolicyReport(policyName: string, source: string, check: ReturnType<typeof checkPolicy>, at = new Date().toISOString()): string {
    const failed = check.results.filter(r => !r.ok);
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
    return [
        `# Company rules check: ${policyName}`,
        '',
        `Checked ${at.slice(0, 16).replace('T', ' ')} UTC against ${source}. ${check.testsFound} test(s) in ${check.filesScanned} file(s).`,
        '',
        failed.length ? `**${failed.length} of ${check.results.length} rule(s) need attention.**` : `**All ${check.results.length} rule(s) pass.**`,
        '',
        '| Rule | Result | Details | How to fix |',
        '|---|---|---|---|',
        ...check.results.map(r => `| ${cell(r.rule)} | ${r.ok ? 'pass' : '**fail**'} | ${cell(r.details)} | ${r.ok ? '' : cell(r.fix ?? '')} |`),
        '',
        'Re-check any time with add_capability (capability "org-policy") and no policy argument.',
        'The wizard does not enforce these rules yet; this report is how the team checks them.',
        ''
    ].join('\n');
}

export async function planOrgPolicy(store: ProjectStore, config: Config, policyArg: string | undefined, doFetch?: typeof fetch): Promise<PlanOutcome> {
    let text: string;
    let source: string;
    if (policyArg?.trim()) {
        source = policyArg.trim();
        if (/^https:\/\//i.test(source)) {
            try {
                text = await fetchText(source, doFetch, 15_000, 500_000);
            } catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
        } else if (/^http:\/\//i.test(source)) {
            return { error: 'Use an https:// address for the policy file, so nobody can change it on the way.' };
        } else {
            const relative = source.replace(/\\/g, '/');
            const found = store.read(relative);
            if (found === undefined) return { error: `${relative} was not found in the repository.` };
            text = found;
        }
    } else {
        const saved = store.read(POLICY_FILE);
        if (saved === undefined) return { error: 'No company policy saved yet. Give policy: a path in the repository or an https address of testpilot.org.yaml (see examples/org-policy/testpilot.org.yaml in the TestPilot package).' };
        text = saved;
        source = store.read(POLICY_SOURCE_FILE)?.trim() || POLICY_FILE;
    }
    const parsed = parsePolicy(text);
    if ('error' in parsed) return parsed;
    const policyName = parsed.policy.name ?? 'company test rules';
    const check = checkPolicy(store, config, parsed.policy);
    const failed = check.results.filter(r => !r.ok);
    const plan: CapabilityPlan = emptyPlan(
        'org-policy',
        'Company rule pack',
        `${policyArg?.trim() ? `Saves the company rules "${policyName}" in ${POLICY_FILE} and checks the project against them` : `Checked the project against the saved company rules "${policyName}"`}: ${check.results.length - failed.length} pass, ${failed.length} need attention. The full list goes to ${POLICY_REPORT}.`,
        `Adopted the company rule pack "${policyName}" from ${source}`
    );
    plan.files.push(compareStatus(store, POLICY_FILE, text.endsWith('\n') ? text : `${text}\n`));
    plan.files.push(compareStatus(store, POLICY_SOURCE_FILE, `${source}\n`));
    plan.notes.push(...check.results.map(r => `${r.ok ? 'pass' : 'FAIL'}: ${r.rule}. ${r.details.split('\n')[0]}${r.ok ? '' : ` Fix: ${r.fix}`}`));
    plan.notes.push('The wizard does not enforce these rules yet (that part is being built separately); re-run this check after changes, or in CI review.');
    plan.data = { policyName, source, results: check.results, testsFound: check.testsFound, recheck: !policyArg?.trim() };
    plan.data.report = renderPolicyReport(policyName, source, check);
    return plan;
}

function compareStatus(store: ProjectStore, file: string, content: string) {
    const current = store.read(file);
    if (current === undefined) return { path: file, status: 'new' as const, content };
    if (current === content) return { path: file, status: 'unchanged' as const, content };
    // The saved copy belongs to TestPilot: a new policy replaces it.
    return { path: file, status: 'merge' as const, content, note: 'Replaces the saved copy with this policy.' };
}
