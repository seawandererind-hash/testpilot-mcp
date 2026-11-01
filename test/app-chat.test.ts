import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCommand, connectCursor, type EngineInfo, parseStreamLine } from '../src/ui-app/chat.js';
import { type RunningApp, startApp } from '../src/ui-app/server.js';
import { tempRepo } from './helpers.js';

process.env.TESTPILOT_NO_BROWSER = '1';

const cursor: EngineInfo = { id: 'cursor', name: 'Cursor', found: true, command: 'agent', install: '', signIn: 'agent login' };
const claude: EngineInfo = { id: 'claude', name: 'Claude', found: true, command: 'claude', install: '', signIn: 'claude' };

describe('app chat: commands and parsing', () => {
    it('runs the Cursor CLI headless in the project, resuming the chat', () => {
        const first = buildCommand(cursor, '/repo', 'Set up tests', 'chat-1', true);
        expect(first.args.slice(0, 9)).toEqual(['-p', '--output-format', 'stream-json', '--workspace', '/repo', '--trust', '--approve-mcps', '--resume', 'chat-1']);
        expect(first.args.at(-1)).toContain('The person says: Set up tests');
        expect(first.args).not.toContain('--force');
        const next = buildCommand(cursor, '/repo', 'yes', 'chat-1', false);
        expect(next.args.at(-1)).toBe('yes');
    });

    it('gives Claude Code only TestPilot and file tools, no shell', () => {
        const { args } = buildCommand(claude, '/repo', 'hello');
        const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
        expect(mcp.mcpServers.testpilot.args).toContain('/repo');
        expect(args).toContain('--strict-mcp-config');
        expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__testpilot,Read,Glob,Grep,Edit,Write');
        expect(args.join(' ')).not.toMatch(/Bash/);
        expect(buildCommand(claude, '/repo', 'yes', 's-9').args.slice(-3)).toEqual(['--resume', 's-9', 'yes']);
    });

    it('reads Cursor and Claude stream-json', () => {
        expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]},"session_id":"s"}')).toEqual([{ type: 'text', text: 'Hi' }]);
        expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__testpilot__wizard"}]}}')).toEqual([{ type: 'tool', name: 'TestPilot: wizard', status: 'started' }]);
        expect(parseStreamLine('{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"a"}}}}')).toEqual([{ type: 'tool', name: 'read', status: 'started' }]);
        expect(parseStreamLine('{"type":"result","is_error":false,"result":"x","session_id":"s-1"}')).toEqual([{ type: 'done', sessionId: 's-1' }]);
        expect(parseStreamLine('not json')).toEqual([]);
    });

    it('adds TestPilot to .cursor/mcp.json and keeps other servers', () => {
        const root = tempRepo({ '.cursor/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }) });
        expect(connectCursor(root).status).toBe('merge');
        const json = JSON.parse(readFileSync(path.join(root, '.cursor/mcp.json'), 'utf8'));
        expect(Object.keys(json.mcpServers)).toEqual(['other', 'testpilot']);
        expect(connectCursor(root).status).toBe('unchanged');
    });
});

describe.skipIf(process.platform === 'win32')('app chat: end to end with a stand-in Cursor CLI', () => {
    let app: RunningApp;
    let key: string;
    let bin: string;
    const oldPath = process.env.PATH;

    beforeAll(async () => {
        bin = tempRepo();
        mkdirSync(path.join(bin, 'bin'));
        const fake = path.join(bin, 'bin', 'agent');
        writeFileSync(
            fake,
            `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2026.10.30"; exit 0; fi
if [ "$1" = "create-chat" ]; then echo "chat-abc12345"; exit 0; fi
echo "$@" >> "${bin}/args.log"
echo '{"type":"tool_call","subtype":"started","tool_call":{"function":{"name":"testpilot_status"}}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"What kind of app is it?"}]}}'
echo '{"type":"result","is_error":false,"result":"x","session_id":"s-1"}'
`
        );
        chmodSync(fake, 0o755);
        process.env.PATH = `${path.join(bin, 'bin')}${path.delimiter}${oldPath}`;
        process.env.TESTPILOT_CLAUDE_CLI = path.join(bin, 'bin', 'no-such-claude');
        app = await startApp({ root: tempRepo() });
        key = new URL(app.url).searchParams.get('key')!;
    });
    afterAll(async () => {
        process.env.PATH = oldPath;
        delete process.env.TESTPILOT_CLAUDE_CLI;
        await app.close();
    });

    const post = (p: string, body: unknown) =>
        new Promise<{ status: number; text: string }>((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port: app.port, method: 'POST', path: p, headers: { 'content-type': 'application/json', 'x-testpilot-key': key } }, res => {
                let text = '';
                res.on('data', d => (text += d));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
            });
            req.on('error', reject);
            req.end(JSON.stringify(body));
        });

    it('finds the engines and streams a reply, resuming the same chat', async () => {
        const engines = await new Promise<any>((resolve, reject) => {
            request({ host: '127.0.0.1', port: app.port, path: '/api/chat/engines', headers: { 'x-testpilot-key': key } }, res => {
                let t = '';
                res.on('data', d => (t += d));
                res.on('end', () => resolve(JSON.parse(t)));
            })
                .on('error', reject)
                .end();
        });
        expect(engines.engines.find((e: EngineInfo) => e.id === 'cursor').found).toBe(true);
        expect(engines.engines.find((e: EngineInfo) => e.id === 'claude').found).toBe(false);

        const one = await post('/api/chat', { engine: 'cursor', message: 'Set up tests' });
        const events = one.text.trim().split('\n').map(l => JSON.parse(l));
        expect(events.map(e => e.type)).toEqual(['status', 'start', 'tool', 'text', 'done']);
        expect(events[3].text).toBe('What kind of app is it?');
        await post('/api/chat', { engine: 'cursor', message: 'yes' });
        const log = readFileSync(path.join(bin, 'args.log'), 'utf8').trim().split('\n').filter(l => l.startsWith('-p '));
        expect(log).toHaveLength(2);
        expect(log[0]).toContain('--resume chat-abc12345');
        expect(log[1]).toContain('--resume chat-abc12345');
        expect(log[1].endsWith(' yes')).toBe(true);

        expect((await post('/api/chat', { engine: 'claude', message: 'hi' })).status).toBe(400);
    });
});
