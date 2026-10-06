// MCP servers: programs (local, or on a URL) that offer tools, like a browser
// Jane can drive. Jane connects to them and the model sees their tools next to
// its own, named <server>__<tool>.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolResult } from './tools/types.js';
import { truncateMiddle } from './tools/types.js';

export type McpServerConfig = {
	/** A local server: the command to start it, e.g. ["npx", "@playwright/mcp@latest"]. */
	command?: string[];
	/** A server running somewhere else. */
	url?: string;
	/** Extra environment variables for a local server. */
	env?: Record<string, string>;
	/** Extra HTTP headers for a server on a URL (e.g. Authorization). */
	headers?: Record<string, string>;
	/** Only these of the server's tools (empty = all). Fewer tools use less context. */
	tools: string[];
	enabled: boolean;
	/** Seconds a tool call may take. */
	timeout: number;
	source: 'user' | 'project';
};

export type McpStatus =
	| { state: 'connecting' }
	| { state: 'connected'; tools: number; tokens: number }
	| { state: 'failed'; reason: string }
	| { state: 'disabled' };

type McpToolInfo = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; title?: string };
};

const CONNECT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 30_000;
const MAX_DESCRIPTION = 1000;

const version = (() => {
	try {
		const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
		return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
	} catch {
		return '0.0.0';
	}
})();

/** The name the model sees: <server>__<tool>, only characters model APIs accept, at most 64 long. */
export function mcpToolName(server: string, tool: string): string {
	return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** Turn an MCP tool result's content into text for the model. */
export function resultText(content: unknown): string {
	if (!Array.isArray(content)) return '';
	return content
		.map((item: Record<string, unknown>) => {
			if (item['type'] === 'text') return String(item['text'] ?? '');
			if (item['type'] === 'image') return `[image (${item['mimeType'] ?? 'unknown type'}); Jane can't look at images]`;
			if (item['type'] === 'audio') return `[audio (${item['mimeType'] ?? 'unknown type'})]`;
			if (item['type'] === 'resource') {
				const resource = item['resource'] as Record<string, unknown> | undefined;
				return typeof resource?.['text'] === 'string' ? resource['text'] : `[resource ${resource?.['uri'] ?? ''}]`;
			}
			if (item['type'] === 'resource_link') return `[link: ${item['uri'] ?? ''}]`;
			return `[${String(item['type'])} content]`;
		})
		.join('\n');
}

/** A Jane tool that calls an MCP server's tool. */
export function toJaneTool(server: string, info: McpToolInfo, call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>): Tool<Record<string, unknown>> {
	const description = (info.description ?? info.annotations?.title ?? info.name).trim();
	return {
		name: mcpToolName(server, info.name),
		description: description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION - 1) + '…' : description,
		params: {},
		schema: info.inputSchema,
		// Read-only tools don't need asking; anything else might change things.
		needsPermission: info.annotations?.readOnlyHint !== true,
		label: (args) => {
			const text = JSON.stringify(args);
			return text === '{}' ? '' : text.length > 100 ? text.slice(0, 99) + '…' : text;
		},
		async preview(args) {
			return { text: JSON.stringify(args, null, 2) };
		},
		run: (args, ctx) => call(args, ctx.signal),
	};
}

type Connection = { client: Client; transport: { close(): Promise<void> }; tools: Tool<Record<string, unknown>>[]; stderr: string };

/** Starts or connects to the configured servers and keeps their tools up to date. */
export class McpManager {
	readonly status = new Map<string, McpStatus>();
	private connections = new Map<string, Connection>();
	private closed = false;

	constructor(
		readonly servers: Record<string, McpServerConfig>,
		private cwd: string,
		/** Called whenever a server's status or tools change. */
		private onChange: () => void = () => {},
	) {
		for (const [name, config] of Object.entries(servers)) {
			this.status.set(name, config.enabled ? { state: 'connecting' } : { state: 'disabled' });
		}
	}

	/** Connect to every enabled server, in parallel. Never throws; failures end up in `status`. */
	async connectAll(names = Object.keys(this.servers)): Promise<void> {
		await Promise.all(names.filter((n) => this.servers[n]?.enabled).map((n) => this.connect(n)));
	}

	/** Tools from all connected servers. */
	tools(): Tool<Record<string, unknown>>[] {
		return [...this.connections.values()].flatMap((c) => c.tools);
	}

	/** Tools of one server, for /mcp. */
	serverTools(name: string): Tool<Record<string, unknown>>[] {
		return this.connections.get(name)?.tools ?? [];
	}

	private async connect(name: string): Promise<void> {
		const config = this.servers[name]!;
		this.status.set(name, { state: 'connecting' });
		this.onChange();
		const client = new Client({ name: 'jane', version });
		let stderr = '';
		let transport: StdioClientTransport | StreamableHTTPClientTransport;
		try {
			if (config.command?.length) {
				const [command, ...args] = config.command;
				transport = new StdioClientTransport({
					command: command!,
					args,
					env: { ...(process.env as Record<string, string>), ...config.env },
					cwd: this.cwd,
					stderr: 'pipe',
				});
				transport.stderr?.on('data', (d: Buffer) => {
					stderr = (stderr + d.toString()).slice(-2000);
				});
			} else if (config.url) {
				transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } });
			} else {
				throw new Error('needs a command or a url');
			}
			await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'took too long to start');
			const tools = await this.listTools(name, client, config);
			if (this.closed) {
				await client.close();
				return;
			}
			this.connections.set(name, { client, transport, tools, stderr });
			this.setConnected(name, tools);
			// Servers can change their tools while running; follow along.
			client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				const connection = this.connections.get(name);
				if (!connection) return;
				connection.tools = await this.listTools(name, client, config).catch(() => connection.tools);
				this.setConnected(name, connection.tools);
			});
			client.onclose = () => {
				if (this.closed || !this.connections.has(name)) return;
				this.connections.delete(name);
				const last = stderr.trim().split('\n').at(-1);
				this.status.set(name, { state: 'failed', reason: `the server stopped${last ? ` (${last})` : ''}` });
				this.onChange();
			};
		} catch (error) {
			const last = stderr.trim().split('\n').at(-1);
			const reason = describeError(error) + (last && !describeError(error).includes(last) ? ` (${last})` : '');
			this.status.set(name, { state: 'failed', reason });
			this.onChange();
			await client.close().catch(() => {});
		}
	}

	private setConnected(name: string, tools: Tool<Record<string, unknown>>[]) {
		const tokens = Math.ceil(tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.schema).length, 0) / 4);
		this.status.set(name, { state: 'connected', tools: tools.length, tokens });
		this.onChange();
	}

	private async listTools(name: string, client: Client, config: McpServerConfig): Promise<Tool<Record<string, unknown>>[]> {
		const found: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor ? { cursor } : undefined);
			found.push(...(page.tools as McpToolInfo[]));
			cursor = page.nextCursor;
		} while (cursor);
		const wanted = config.tools.length ? found.filter((t) => config.tools.includes(t.name)) : found;
		return wanted.map((info) =>
			toJaneTool(name, info, async (args, signal) => {
				const connection = this.connections.get(name);
				if (!connection) return { output: `The MCP server "${name}" isn't connected right now.`, isError: true };
				const result = await connection.client.callTool({ name: info.name, arguments: args }, undefined, {
					signal,
					timeout: config.timeout * 1000,
				});
				const text = resultText(result.content) || (result.structuredContent ? JSON.stringify(result.structuredContent) : '(no output)');
				const lines = text.split('\n').length;
				return {
					output: truncateMiddle(text, MAX_OUTPUT),
					isError: Boolean(result.isError),
					display: { summary: result.isError ? text.split('\n')[0]!.slice(0, 200) : `${lines} line${lines === 1 ? '' : 's'} of output` },
				};
			}),
		);
	}

	/** Disconnect from everything and stop the local servers. */
	async closeAll(): Promise<void> {
		this.closed = true;
		const all = [...this.connections.values()];
		this.connections.clear();
		await Promise.all(all.map((c) => c.client.close().catch(() => {})));
	}
}

function describeError(error: unknown): string {
	const message = (error as Error)?.message ?? String(error);
	if (/ENOENT/.test(message)) return 'the command was not found';
	if (/ECONNREFUSED|fetch failed/.test(message)) return 'not reachable';
	return message.split('\n')[0]!.slice(0, 300);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
