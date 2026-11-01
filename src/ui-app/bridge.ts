import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createServer } from '../server.js';
import { VERSION } from '../version.js';

/** What the app gets back from one tool call: the tool's own summary, its data, and whether it failed. */
export interface ToolOutcome {
    ok: boolean;
    text: string;
    data?: Record<string, unknown>;
}

/** Tools the app never offers: hosted-only, or driven step by step by an AI in a chat. */
export const APP_HIDDEN_TOOLS = new Set(['hosted_workspace']);

/**
 * An in-process MCP client talking to its own TestPilot server, so the app goes through
 * exactly the same tools, checks and approval gates as Cursor or Claude Code do.
 * The app declares no form (elicitation) support: approvals come back as
 * "Approval needed" and the app asks the person with its own Yes/No dialog.
 */
export class ToolBridge {
    private readonly handler: ReturnType<typeof createMcpHandler>;
    private client?: Client;
    private connecting?: Promise<Client>;

    constructor(readonly root: string) {
        this.handler = createMcpHandler(() => createServer({ root, mode: 'local' }));
    }

    private async connected(): Promise<Client> {
        if (this.client) return this.client;
        this.connecting ??= (async () => {
            const transport = new StreamableHTTPClientTransport(new URL('http://testpilot.app.local/mcp'), {
                fetch: (url, init) => this.handler.fetch(new Request(url, init))
            });
            const client = new Client({ name: 'testpilot-app', version: VERSION }, { versionNegotiation: { mode: 'legacy' }, capabilities: {} });
            await client.connect(transport);
            this.client = client;
            return client;
        })();
        try {
            return await this.connecting;
        } finally {
            this.connecting = undefined;
        }
    }

    async listTools(): Promise<Array<{ name: string; title?: string; description?: string; inputSchema: unknown }>> {
        const client = await this.connected();
        const { tools } = await client.listTools();
        return tools.filter(t => !APP_HIDDEN_TOOLS.has(t.name)).map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema }));
    }

    async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
        if (APP_HIDDEN_TOOLS.has(name)) return { ok: false, text: `${name} is not available in the app.` };
        const client = await this.connected();
        // Test runs and installs can take a long time; the person sees a "working" screen meanwhile.
        const res = (await client.callTool({ name, arguments: { ...args, projectRoot: this.root } }, { timeout: 60 * 60 * 1000 })) as {
            content?: Array<{ type: string; text?: string }>;
            structuredContent?: Record<string, unknown>;
            isError?: boolean;
        };
        const text = (res.content ?? [])
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('\n');
        // result() repeats the JSON after the summary; the app shows the summary and draws the data itself.
        const summary = res.structuredContent ? text.split('\n\n{')[0] : text;
        return { ok: !res.isError, text: summary.trim(), data: res.structuredContent };
    }

    async close(): Promise<void> {
        await this.client?.close().catch(() => undefined);
        await this.handler.close();
    }
}
