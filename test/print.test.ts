import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { HostManager } from '../src/hosts.js';
import { runPrint } from '../src/print.js';
import { listSessions } from '../src/session.js';

// A fake model server: each test queues replies (text, tool calls, or an HTTP error).
type Reply = { content?: string; calls?: { name: string; args: string }[] } | { status: number };
let replies: Reply[] = [];
let requests: any[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		if (req.method === 'GET') return res.writeHead(404).end();
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			requests.push(JSON.parse(body));
			const reply = replies.shift() ?? { content: 'out of replies' };
			if ('status' in reply) return res.writeHead(reply.status).end('{"error":"boom"}');
			const chunks: unknown[] = [{ choices: [{ delta: { content: reply.content ?? '' } }] }];
			(reply.calls ?? []).forEach((c, index) =>
				chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `c${requests.length}${index}`, function: { name: c.name, arguments: c.args } }] } }] }),
			);
			chunks.push({ choices: [{ delta: {}, finish_reason: reply.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
			res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
	server.close();
});

let dir: string;
let sessionsRoot: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-print-'));
	sessionsRoot = path.join(dir, '.sessions');
	replies = [];
	requests = [];
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function print(prompt: string, extra: Partial<Parameters<typeof runPrint>[0]> = {}) {
	const config = structuredClone(defaultConfig);
	config.hooks = [];
	config.mcp = {};
	config.skills.sources = [];
	const hosts = new HostManager([{ name: 'local', baseUrl, model: 'm', contextWindow: 65536 }], async () => ({ ok: true, models: [] }));
	let out = '';
	let err = '';
	const code = await runPrint({ prompt, cwd: dir, config, hosts, notes: [], json: false, sessionsRoot, out: (t) => (out += t), err: (t) => (err += t), ...extra });
	return { code, out, err };
}

describe('print mode', () => {
	it('prints the answer on stdout and progress on stderr', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
		replies = [{ calls: [{ name: 'read', args: '{"path":"a.txt"}' }] }, { content: 'It says hello.' }];
		const { code, out, err } = await print('What is in a.txt?');
		expect(code).toBe(0);
		expect(out).toBe('It says hello.\n');
		expect(err).toMatch(/● read\(a\.txt\)\n {2}⎿ Read 1 line\n/);
		expect(err).toMatch(/jane: session \S+ \(continue with: jane -p -r /);
	});

	it('runs unrestricted by default, and refuses permission questions with --mode always-ask', async () => {
		replies = [{ calls: [{ name: 'write', args: '{"path":"x.txt","content":"x"}' }] }, { content: 'Written.' }];
		expect((await print('write x.txt')).code).toBe(0);
		expect(fs.existsSync(path.join(dir, 'x.txt'))).toBe(true);

		replies = [{ calls: [{ name: 'write', args: '{"path":"y.txt","content":"y"}' }] }, { content: 'I could not write it.' }];
		const { code, out } = await print('write y.txt', { mode: 'always-ask' });
		expect(code).toBe(0);
		expect(out).toBe('I could not write it.\n');
		expect(fs.existsSync(path.join(dir, 'y.txt'))).toBe(false);
		expect(requests.at(-1).messages.at(-1).content).toMatch(/Nobody can answer permission questions in print mode/);
	});

	it('gives JSON with the session id, and the session can be continued', async () => {
		replies = [{ content: 'Four.' }];
		const first = await print('2+2?', { json: true });
		const result = JSON.parse(first.out);
		expect(result).toMatchObject({ result: 'Four.', outcome: 'done', session_id: expect.any(String) });

		replies = [{ content: 'Six.' }];
		const resume = listSessions(dir, sessionsRoot).find((s) => s.id === result.session_id)!;
		await print('and 3+3?', { resume });
		expect(requests.at(-1).messages.slice(1).map((m: any) => m.content)).toEqual(['2+2?', 'Four.', 'and 3+3?']);
	});

	it('exits with 1 when the model server fails', async () => {
		replies = [{ status: 500 }];
		const { code, out, err } = await print('hi');
		expect(code).toBe(1);
		expect(out).toBe('');
		expect(err).toMatch(/jane: model server returned 500/);
	});

	it('offers helpers without background mode', async () => {
		replies = [{ content: 'ok' }];
		await print('hi');
		const agentTool = requests[0].tools.find((t: any) => t.function.name === 'agent');
		expect(Object.keys(agentTool.function.parameters.properties)).not.toContain('background');
		expect(agentTool.function.description).not.toMatch(/background/);
	});
});
