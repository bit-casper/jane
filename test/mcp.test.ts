import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { McpManager, type McpServerConfig, mcpToolName, resultText } from '../src/mcp.js';
import { parseArgs, toolSchemas } from '../src/tools/index.js';
import { toolTitle } from '../src/ui/History.js';

const fixture = path.join(import.meta.dirname, 'fixtures', 'mcp-server.mjs');
const server = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
	command: ['node', fixture],
	tools: [],
	enabled: true,
	timeout: 30,
	source: 'user',
	...extra,
});

let dir: string;
let managers: McpManager[] = [];
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-mcp-'));
});
afterEach(async () => {
	await Promise.all(managers.map((m) => m.closeAll()));
	managers = [];
	fs.rmSync(dir, { recursive: true, force: true });
});
const manager = (servers: Record<string, McpServerConfig>) => {
	const m = new McpManager(servers, dir);
	managers.push(m);
	return m;
};
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

describe('MCP config', () => {
	it('reads [mcp.<name>] servers from the user and project configs', () => {
		const user = path.join(dir, 'user.toml');
		const project = path.join(dir, 'project.toml');
		fs.writeFileSync(user, '[mcp.browser]\ncommand = ["npx", "@playwright/mcp@latest"]\ntools = ["browser_navigate"]\n');
		fs.writeFileSync(project, '[mcp.issues]\nurl = "https://example.com/mcp"\nheaders = { Authorization = "Bearer x" }\n\n[mcp.browser]\ncommand = ["evil"]\n');
		const { config, warnings } = loadConfig(dir, [user, project], () => undefined);
		expect(config.mcp).toEqual({
			browser: { command: ['npx', '@playwright/mcp@latest'], env: {}, headers: {}, tools: ['browser_navigate'], enabled: true, timeout: 120, source: 'user' },
			issues: { url: 'https://example.com/mcp', env: {}, headers: { Authorization: 'Bearer x' }, tools: [], enabled: true, timeout: 120, source: 'project' },
		});
		// A project can't replace your server under the same name.
		expect(warnings).toEqual([expect.stringMatching(/mcp\.browser is already defined in your user config/)]);
	});

	it('skips broken servers with a clear warning', () => {
		const file = path.join(dir, 'c.toml');
		fs.writeFileSync(file, '[mcp.both]\ncommand = ["x"]\nurl = "http://a"\n\n[mcp.none]\nenabled = "yes"\n\n["mcp"."bad name"]\nurl = "http://a"\n');
		const { config, warnings } = loadConfig(dir, [file], () => undefined);
		expect(config.mcp).toEqual({});
		expect(warnings).toEqual([
			expect.stringMatching(/mcp\.both was skipped: it needs either command .* or url/),
			expect.stringMatching(/mcp\.none was skipped: it needs either command .*; enabled \(true or false\)/),
			expect.stringMatching(/mcp\.bad name was skipped: server names can only use/),
		]);
	});
});

describe('MCP helpers', () => {
	it('names tools <server>__<tool> and shows them as "server: tool"', () => {
		expect(mcpToolName('browser', 'browser_navigate')).toBe('browser__browser_navigate');
		expect(mcpToolName('my server', 'do.it')).toBe('my_server__do_it');
		expect(mcpToolName('s', 'x'.repeat(100))).toHaveLength(64);
		expect(toolTitle('browser__browser_navigate')).toBe('browser: browser_navigate');
		expect(toolTitle('read')).toBe('Read');
		expect(toolTitle('web_fetch')).toBe('Web fetch');
	});

	it('turns result content into text, describing what the model can\'t see', () => {
		expect(
			resultText([
				{ type: 'text', text: 'hello' },
				{ type: 'image', data: 'x', mimeType: 'image/png' },
				{ type: 'resource', resource: { uri: 'file:///a', text: 'file text' } },
				{ type: 'resource_link', uri: 'file:///b' },
			]),
		).toBe("hello\n[image (image/png); Jane can't look at images]\nfile text\n[link: file:///b]");
		expect(resultText(undefined)).toBe('');
	});
});

describe('McpManager', () => {
	it('starts a local server and offers its tools', async () => {
		const m = manager({ test: server() });
		await m.connectAll();
		expect(m.status.get('test')).toMatchObject({ state: 'connected', tools: 3 });
		const tools = m.tools();
		expect(tools.map((t) => [t.name, t.needsPermission])).toEqual([
			['test__echo', false], // read-only: no need to ask
			['test__shout', true],
			['test__broken', true],
		]);
		// The model gets the server's own schema, and arguments pass straight through.
		const [schema] = toolSchemas([tools[0]!]);
		expect(schema!.function.parameters).toMatchObject({ type: 'object', properties: { message: { type: 'string' } } });
		expect(parseArgs(tools[0]!, '{"message":"hi","extra":1}')).toEqual({ args: { message: 'hi', extra: 1 } });

		expect(await tools[0]!.run({ message: 'hi' }, ctx())).toMatchObject({ output: 'echo: hi', isError: false });
		expect((await tools[1]!.run({ message: 'hi' }, ctx())).output).toBe("HI\n[image (image/png); Jane can't look at images]");
		expect(await tools[2]!.run({}, ctx())).toMatchObject({ output: 'it broke', isError: true });
		expect(tools[0]!.label({ message: 'hi' }, { cwd: dir })).toBe('{"message":"hi"}');
	});

	it('loads only the tools asked for', async () => {
		const m = manager({ test: server({ tools: ['echo'] }) });
		await m.connectAll();
		expect(m.tools().map((t) => t.name)).toEqual(['test__echo']);
		expect(m.status.get('test')).toMatchObject({ state: 'connected', tools: 1 });
	});

	it('reports servers that fail to start, and skips disabled ones', async () => {
		const m = manager({
			missing: server({ command: ['no-such-mcp-command-xyz'] }),
			crashing: server({ command: ['node', '-e', 'console.error("bad config"); process.exit(1)'] }),
			off: server({ enabled: false }),
		});
		await m.connectAll();
		expect(m.status.get('missing')).toEqual({ state: 'failed', reason: expect.stringMatching(/not found|ENOENT|closed/i) });
		expect(m.status.get('crashing')).toEqual({ state: 'failed', reason: expect.stringMatching(/bad config/) });
		expect(m.status.get('off')).toEqual({ state: 'disabled' });
		expect(m.tools()).toEqual([]);
	});

	it('stops local servers on close', async () => {
		const m = manager({ test: server() });
		await m.connectAll();
		const tool = m.tools()[0]!;
		await m.closeAll();
		expect(m.tools()).toEqual([]);
		expect(await tool.run({ message: 'x' }, ctx())).toMatchObject({ isError: true, output: expect.stringMatching(/isn't connected/) });
	});
});
