import type { McpServer } from '@modelcontextprotocol/server';

/**
 * MCP Apps (extension "io.modelcontextprotocol/ui", spec 2026-01-26,
 * https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
 * A tool names a ui:// resource in `_meta.ui.resourceUri`; hosts that support the
 * extension (Claude, ChatGPT, VS Code, Goose, ...) render that HTML in a sandboxed
 * iframe and push the tool result into it. Hosts that do not support it ignore
 * the unknown `_meta` and show the normal text and structuredContent.
 */

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

export interface UiResourceOptions {
    /** Registered resource name. */
    name: string;
    /** Must start with ui:// */
    uri: string;
    title: string;
    description: string;
    /** The complete, self-contained HTML document. */
    html: () => string;
    /** Ask the host to draw a border around the view. */
    prefersBorder?: boolean;
}

/** The `_meta.ui` block for a resource: no network, no external assets (the view is fully inline). */
function resourceUiMeta(options: UiResourceOptions): Record<string, unknown> {
    return { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: options.prefersBorder ?? true } };
}

/** Registers one MCP App view as a ui:// resource with the MCP App mime type. */
export function registerUiResource(server: McpServer, options: UiResourceOptions): void {
    if (!options.uri.startsWith('ui://')) throw new Error(`MCP App resources must use a ui:// URI (got ${options.uri}).`);
    const meta = resourceUiMeta(options);
    server.registerResource(options.name, options.uri, { title: options.title, description: options.description, mimeType: UI_MIME_TYPE, _meta: meta }, async uri => ({
        contents: [{ uri: uri.href, mimeType: UI_MIME_TYPE, text: options.html(), _meta: meta }]
    }));
}

/**
 * The `_meta` to put on a tool so hosts render its results in the view.
 * Both the current nested key and the older flat "ui/resourceUri" key are set,
 * so hosts built against the earlier draft still find it.
 */
export function toolUiMeta(resourceUri: string, visibility: Array<'model' | 'app'> = ['model', 'app']): Record<string, unknown> {
    return { ui: { resourceUri, visibility }, 'ui/resourceUri': resourceUri };
}

const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

/**
 * True when the client declared the MCP Apps extension (capabilities.extensions
 * at initialize on 2025-era connections, or the per-request envelope on 2026-07-28).
 * Tools never depend on it: the view is an extra, the text result always comes too.
 */
export function clientSupportsApps(server: McpServer, ctx?: unknown): boolean {
    try {
        const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_KEY] as { extensions?: Record<string, unknown> } | undefined;
        const caps = envelope ?? (server.server.getClientCapabilities() as { extensions?: Record<string, unknown> } | undefined);
        const ext = caps?.extensions?.[UI_EXTENSION] as { mimeTypes?: string[] } | undefined;
        return Boolean(ext && (!Array.isArray(ext.mimeTypes) || ext.mimeTypes.includes(UI_MIME_TYPE)));
    } catch {
        return false;
    }
}

/**
 * The data contract for the shared view. Any tool can return structuredContent
 * with a `view` field; the view draws 'coverage' and 'metrics' and falls back to
 * a generic table for anything else ('run', 'heal', 'dashboard', ...). `rerun`
 * tells the view's refresh button which tool call to repeat.
 */
export interface ViewPayload {
    view: string;
    title?: string;
    subtitle?: string;
    rerun?: { tool: string; arguments: Record<string, unknown> };
    [key: string]: unknown;
}
