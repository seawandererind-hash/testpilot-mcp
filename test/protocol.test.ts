import { afterEach, describe, expect, it } from 'vitest';

import { connect, type Era, tempRepo } from './helpers.js';

const eras: Era[] = ['legacy', 'modern'];

describe.each(eras)('protocol era: %s', era => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it('lists tools with titles and annotations', async () => {
        const c = await connect(tempRepo(), era);
        close = c.close;
        const { tools } = await c.client.listTools();
        const names = tools.map(t => t.name);
        expect(names).toContain('wizard');
        expect(names).toContain('testpilot_status');
        for (const tool of tools) {
            expect(tool.title, tool.name).toBeTruthy();
            expect(tool.annotations?.readOnlyHint, tool.name).not.toBeUndefined();
            expect(tool.name.length).toBeLessThanOrEqual(64);
        }
        expect(tools.length).toBeLessThanOrEqual(20);
    });

    it('lists the qa-* prompts', async () => {
        const c = await connect(tempRepo(), era);
        close = c.close;
        const { prompts } = await c.client.listPrompts();
        expect(prompts.map(p => p.name)).toEqual(expect.arrayContaining(['qa-setup', 'qa-import', 'qa-plan', 'qa-generate', 'qa-run', 'qa-status']));
    });

    it('walks the first wizard steps over chat and saves them in the repo', async () => {
        const root = tempRepo();
        const c = await connect(root, era);
        close = c.close;
        const first = await c.call('wizard', { action: 'next' });
        expect(first.isError).toBeFalsy();
        expect(first.structuredContent.step.step).toBe('APP_TYPE');
        const answered = await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'Web app' });
        expect(answered.structuredContent.saved).toContain('Web app');
        expect(answered.structuredContent.next.step).toBe('FRAMEWORK');
        expect(answered.structuredContent.next.recommended).toBe('playwright');
        const status = await c.call('testpilot_status');
        expect(status.structuredContent.config.appType).toBe('web');
        expect(status.structuredContent.completedSteps).toEqual(['APP_TYPE']);
    });

    it('asks with a form when the client supports elicitation', async () => {
        const root = tempRepo();
        const seen: string[] = [];
        const c = await connect(root, era, {
            elicit: params => {
                seen.push(params.message);
                return { answer: 'android' };
            }
        });
        close = c.close;
        const res = await c.call('wizard', { action: 'next' });
        expect(res.isError).toBeFalsy();
        if (era === 'modern') {
            expect(seen[0]).toContain('What kind of application');
            expect(res.structuredContent.saved).toContain('Android');
        } else {
            // Stateless legacy HTTP has no session for server-to-client requests,
            // so TestPilot falls back to asking in chat. stdio is covered in stdio.test.ts.
            expect(seen).toHaveLength(0);
            expect(res.structuredContent.step.step).toBe('APP_TYPE');
        }
    });

    it('rejects unknown answers with a readable error', async () => {
        const c = await connect(tempRepo(), era);
        close = c.close;
        const res = await c.call('wizard', { action: 'answer', step: 'APP_TYPE', answer: 'mainframe' });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('is not one of');
    });
});
