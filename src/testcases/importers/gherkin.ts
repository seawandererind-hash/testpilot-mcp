import path from 'node:path';

import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, type Scenario, type Step } from '@cucumber/messages';

import type { Draft, ImportWarning } from '../normalize.js';
import { ImportError, type Importer } from './types.js';

const ID_TAG = /^@?([A-Z][A-Z0-9_]*-\d+|TC[-_]?\d+)$/i;

function stepText(step: Step): string {
    let text = step.text;
    if (step.docString) text += `\n${step.docString.content}`;
    if (step.dataTable) text += `\n${step.dataTable.rows.map(r => `| ${r.cells.map(c => c.value).join(' | ')} |`).join('\n')}`;
    return text;
}

/** Turns Gherkin steps into actions with expected results: Then/And-after-Then lines become the expected result of the step before. */
function toSteps(steps: readonly Step[]): { preconditions: string[]; steps: Draft['steps']; expected?: string } {
    const preconditions: string[] = [];
    const out: Draft['steps'] = [];
    let mode: 'context' | 'action' | 'outcome' = 'context';
    const outcomes: string[] = [];
    for (const step of steps) {
        const type = step.keywordType;
        if (type === 'Context') mode = 'context';
        else if (type === 'Action') mode = 'action';
        else if (type === 'Outcome') mode = 'outcome';
        const text = stepText(step);
        if (mode === 'context' && !out.length) preconditions.push(text);
        else if (mode === 'outcome') {
            const last = out[out.length - 1];
            if (last) last.expected = [last.expected, text].filter(Boolean).join('; ');
            else outcomes.push(text);
        } else out.push({ action: mode === 'context' ? `Given ${text}` : text });
    }
    return { preconditions, steps: out, expected: outcomes.join('; ') || undefined };
}

export const importGherkin: Importer = async ({ store, location, limit }) => {
    const files = store.exists(location) && !/\.feature$/i.test(location) ? store.list(location, n => n.endsWith('.feature')) : [location];
    if (!files.length) throw new ImportError(`No .feature files in ${location}.`);
    const drafts: Draft[] = [];
    const warnings: ImportWarning[] = [];
    const raw: string[] = [];
    for (const file of files) {
        if (!store.exists(file)) throw new ImportError(`No file at ${file}.`);
        const text = store.read(file)!;
        raw.push(`# ${file}\n${text}`);
        let doc;
        try {
            doc = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher()).parse(text);
        } catch (error) {
            throw new ImportError(`${file} is not valid Gherkin: ${(error as Error).message.split('\n')[0]}`);
        }
        const feature = doc.feature;
        if (!feature) continue;
        const featureTags = feature.tags.map(t => t.name);
        const backgrounds: string[] = [];
        const scenarios: Array<{ scenario: Scenario; rule?: string }> = [];
        for (const child of feature.children) {
            if (child.background) backgrounds.push(...child.background.steps.map(stepText));
            if (child.scenario) scenarios.push({ scenario: child.scenario });
            if (child.rule) {
                for (const rc of child.rule.children) {
                    if (rc.background) backgrounds.push(...rc.background.steps.map(stepText));
                    if (rc.scenario) scenarios.push({ scenario: rc.scenario, rule: child.rule.name });
                }
            }
        }
        for (const { scenario, rule } of scenarios) {
            if (drafts.length >= limit) break;
            const tags = [...featureTags, ...scenario.tags.map(t => t.name)];
            const idTag = tags.find(t => ID_TAG.test(t));
            const { preconditions, steps, expected } = toSteps(scenario.steps);
            const examples = scenario.examples
                .map(ex => (ex.tableHeader ? [ex.tableHeader, ...ex.tableBody].map(r => `| ${r.cells.map(c => c.value).join(' | ')} |`).join('\n') : ''))
                .filter(Boolean)
                .join('\n');
            drafts.push({
                id: idTag?.replace(/^@/, ''),
                title: scenario.name,
                description: scenario.description?.trim() || undefined,
                preconditions: [...backgrounds, ...preconditions],
                steps,
                expected,
                testData: examples || undefined,
                area: rule ?? feature.name,
                tags: tags.filter(t => t !== idTag).map(t => t.replace(/^@/, '')),
                sourceRef: `${path.basename(file)} line ${scenario.location.line}`
            });
        }
    }
    return { drafts, warnings, ref: location, raw: { name: `${path.basename(location)}.features.txt`, content: raw.join('\n\n') } };
};
