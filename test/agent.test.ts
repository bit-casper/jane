import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type AgentEvents, type PermissionDecision } from '../src/agent.js';
import { ModelError } from '../src/client.js';
import { Session, loadSession } from '../src/session.js';

// A fake OpenAI-compatible server. Each test queues the replies it should stream.
type Reply = { content?: string; reasoning?: string; calls?: { name: string; args: string }[] } | { status: number };
let replies: Reply[] = [];
let requests: any[] = [];
let server: http.Server;
let baseUrl: string;

function sse(reply: Exclude<Reply, { status: number }>): string {
	const chunks: unknown[] = [];
	if (reply.reasoning) chunks.push({ choices: [{ delta: { reasoning_content: reply.reasoning } }] });
	for (const piece of (reply.content ?? '').match(/.{1,4}/gs) ?? []) chunks.push({ choices: [{ delta: { content: piece } }] });
	(reply.calls ?? []).forEach((call, index) => {
		chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `id${index}`, function: { name: call.name, arguments: '' } }] } }] });
		chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: call.args } }] } }] });
	});
	chunks.push({ choices: [{ delta: {}, finish_reason: reply.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
	return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			requests.push(JSON.parse(body));
			const reply = replies.shift() ?? { content: 'out of replies' };
			if ('status' in reply) {
				res.writeHead(reply.status).end('{"error":"boom"}');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(sse(reply));
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
	server.close();
});

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-agent-'));
	replies = [];
	requests = [];
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function makeAgent(mode: 'always-ask' | 'unrestricted' = 'unrestricted') {
	const session = new Session(dir, 'test', { root: path.join(dir, '.sessions') });
	return new Agent({ baseUrl, model: 'test' }, mode, 'system prompt', dir, session);
}

function recorder(decide: () => PermissionDecision = () => ({ kind: 'yes' })) {
	const log: string[] = [];
	const events: AgentEvents = {
		onToolStart: (c) => log.push(`start ${c.name}`),
		onToolEnd: (c) => log.push(`end ${c.name}${c.result.isError ? ' error' : ''}`),
		onReply: (r) => log.push(`reply ${r.content}`),
		askPermission: async (r) => {
			log.push(`ask ${r.tool.name}`);
			return decide();
		},
	};
	return { log, events };
}

describe('agent loop', () => {
	it('runs tools and feeds the results back until the model is done', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
		replies = [
			{ reasoning: 'look first', calls: [{ name: 'read', args: '{"path":"a.txt"}' }] },
			{ calls: [{ name: 'edit', args: '{"path":"a.txt","old_string":"hello","new_string":"bye"}' }] },
			{ content: 'Done.' },
		];
		const agent = makeAgent();
		const { log, events } = recorder();
		const outcome = await agent.run('change it', events, new AbortController().signal);

		expect(outcome).toBe('done');
		expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('bye\n');
		expect(log).toEqual(['reply ', 'start read', 'end read', 'reply ', 'start edit', 'end edit', 'reply Done.']);
		expect(requests[0].messages[0]).toEqual({ role: 'system', content: 'system prompt' });
		expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(['read', 'write', 'edit', 'bash', 'glob', 'grep']);
		expect(requests[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'id0', content: '1\thello' });
		expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
	});

	it('asks before changing things in always-ask mode, but not for reads', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
		replies = [
			{ calls: [{ name: 'read', args: '{"path":"a.txt"}' }, { name: 'bash', args: '{"command":"echo hi"}' }] },
			{ calls: [{ name: 'bash', args: '{"command":"echo again"}' }] },
			{ content: 'ok' },
		];
		const agent = makeAgent('always-ask');
		const { log, events } = recorder(() => ({ kind: 'always' }));
		await agent.run('go', events, new AbortController().signal);
		// Asked once for bash; "always" covered the second bash call.
		expect(log.filter((l) => l.startsWith('ask'))).toEqual(['ask bash']);
		expect(requests[1].messages.at(-1).content).toBe('hi');
	});

	it('stops when the user says no without feedback, and continues with feedback', async () => {
		replies = [{ calls: [{ name: 'write', args: '{"path":"f","content":"x"}' }, { name: 'bash', args: '{"command":"ls"}' }] }];
		const agent = makeAgent('always-ask');
		const no = await agent.run('go', recorder(() => ({ kind: 'no' })).events, new AbortController().signal);
		expect(no).toBe('denied');
		expect(fs.existsSync(path.join(dir, 'f'))).toBe(false);
		// Both calls got an answer, so the conversation stays valid.
		expect(agent.messages.slice(-2).map((m) => m.role)).toEqual(['tool', 'tool']);
		expect(agent.messages.at(-1)).toMatchObject({ content: 'Not run: the turn was stopped.' });

		replies = [{ calls: [{ name: 'write', args: '{"path":"f","content":"x"}' }] }, { content: 'fine' }];
		const yes = await agent.run('go', recorder(() => ({ kind: 'no', feedback: 'call it g' })).events, new AbortController().signal);
		expect(yes).toBe('done');
		expect(requests.at(-1).messages.at(-1).content).toBe('The user did not allow this. They said: call it g');
	});

	it("tells the model about bad tool calls and gives up after three in a row", async () => {
		replies = [
			{ calls: [{ name: 'nope', args: '{}' }] },
			{ calls: [{ name: 'read', args: '{bad json' }] },
			{ calls: [{ name: 'read', args: '{}' }] },
		];
		const agent = makeAgent();
		const outcome = await agent.run('go', recorder().events, new AbortController().signal);
		expect(outcome).toBe('too-many-bad-calls');
		expect(requests[1].messages.at(-1).content).toMatch(/^Error: There is no tool called "nope". The tools are: read, write/);
		expect(requests[2].messages.at(-1).content).toMatch(/not valid JSON/);
	});

	it("doesn't ask permission for an edit that would fail anyway", async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
		replies = [{ calls: [{ name: 'edit', args: '{"path":"a.txt","old_string":"zzz","new_string":"y"}' }] }, { content: 'oops' }];
		const { log, events } = recorder();
		await makeAgent('always-ask').run('go', events, new AbortController().signal);
		expect(log).not.toContain('ask edit');
		expect(requests[1].messages.at(-1).content).toMatch(/^Error: old_string was not found/);
	});

	it('reports server errors and interrupts', async () => {
		replies = [{ status: 500 }];
		await expect(makeAgent().run('go', recorder().events, new AbortController().signal)).rejects.toThrow(ModelError);

		replies = [{ calls: [{ name: 'bash', args: '{"command":"sleep 30"}' }] }];
		const controller = new AbortController();
		const events = { ...recorder().events, onToolStart: () => setTimeout(() => controller.abort(), 100) };
		const agent = makeAgent();
		expect(await agent.run('go', events, controller.signal)).toBe('interrupted');
		expect(agent.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringMatching(/interrupted/) });
	});

	it('saves the conversation to the session file', async () => {
		replies = [{ content: 'hi there' }];
		const agent = makeAgent();
		await agent.run('hello', recorder().events, new AbortController().signal);
		const lines = fs.readFileSync(agent.session.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
		expect(lines.map((l) => l.type)).toEqual(['meta', 'message', 'message']);
		expect(lines[2].message).toEqual({ role: 'assistant', content: 'hi there' });
	});

	it('saves what the screen showed for each tool call, for resuming', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
		replies = [{ calls: [{ name: 'edit', args: '{"path":"a.txt","old_string":"x","new_string":"y"}' }] }, { content: 'ok' }];
		const agent = makeAgent();
		await agent.run('go', recorder().events, new AbortController().signal);
		const saved = loadSession(agent.session.file).toolDisplays.get('id0');
		expect(saved?.label).toBe('a.txt');
		expect(saved?.result.display?.summary).toBe('1 line added, 1 removed');
		expect(saved?.result.display?.diff).toHaveLength(2);
	});
});
