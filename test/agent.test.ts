import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type AgentEvents, type PermissionDecision } from '../src/agent.js';
import { DEFAULT_BLOCK_PATTERNS, compileBlockList } from '../src/blocklist.js';
import { ModelError } from '../src/client.js';
import { Checkpoints } from '../src/checkpoints.js';
import { SUMMARY_SYSTEM, isSummary } from '../src/compact.js';
import { Session, loadSession } from '../src/session.js';

// A fake OpenAI-compatible server. Each test queues the replies it should stream.
type Reply = { content?: string; reasoning?: string; calls?: { name: string; args: string }[]; promptTokens?: number; delay?: number } | { status: number; body?: string };
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
	chunks.push({ choices: [{ delta: {}, finish_reason: reply.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: reply.promptTokens ?? 100, completion_tokens: 20 } });
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
				res.writeHead(reply.status).end(reply.body ?? '{"error":"boom"}');
				return;
			}
			setTimeout(() => res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(sse(reply)), reply.delay ?? 0);
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

	it('saves checkpoints for write and edit, and tells the model about an undo', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
		replies = [
			{ calls: [{ name: 'edit', args: '{"path":"a.txt","old_string":"old","new_string":"new"}' }] },
			{ calls: [{ name: 'edit', args: '{"path":"a.txt","old_string":"missing","new_string":"x"}' }] },
			{ calls: [{ name: 'write', args: '{"path":"b.txt","content":"b"}' }] },
			{ content: 'done' },
		];
		const agent = makeAgent();
		agent.checkpoints = new Checkpoints(path.join(dir, '.cp'));
		await agent.run('change things', recorder().events, new AbortController().signal);
		const changes = agent.checkpoints.list();
		// The failed edit left no checkpoint.
		expect(changes.map((c) => `${c.tool} ${c.label}`)).toEqual(['write b.txt', 'edit a.txt']);
		expect(changes[0]!.prompt).toBe('change things');

		agent.checkpoints.undo(changes);
		expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('old\n');
		expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);

		agent.notes.push('The user undid your changes.');
		replies = [{ content: 'ok' }];
		await agent.run('next', recorder().events, new AbortController().signal);
		expect(requests.at(-1).messages.at(-1)).toEqual({ role: 'user', content: '[Note from Jane: The user undid your changes.]\n\nnext' });
		expect(agent.notes).toEqual([]);
	});

	it('refuses blocked commands in every mode, without asking', async () => {
		for (const mode of ['unrestricted', 'always-ask'] as const) {
			replies = [{ calls: [{ name: 'bash', args: '{"command":"touch ran.txt; rm -rf ~"}' }] }, { content: 'ok' }];
			const agent = makeAgent(mode);
			agent.blockRules = compileBlockList(DEFAULT_BLOCK_PATTERNS).rules;
			const { log, events } = recorder();
			expect(await agent.run('clean up', events, new AbortController().signal)).toBe('done');
			expect(log.filter((l) => l.startsWith('ask'))).toEqual([]);
			expect(log).toContain('end bash error');
			expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
			expect(requests.at(-1).messages.at(-1).content).toMatch(/^Error: this command was blocked by Jane's block list/);
		}
	});

	describe('compaction', () => {
		const isSummaryRequest = (r: any) => r.messages[0].content === SUMMARY_SYSTEM;

		it('replaces the conversation with a summary on /compact, and keeps it on resume', async () => {
			replies = [{ content: 'Paris.' }];
			const agent = makeAgent();
			await agent.run('What is the capital of France?', recorder().events, new AbortController().signal);
			replies = [{ reasoning: 'thinking about it', content: '## User\'s requests\nAsked for the capital of France.' }];
			const compacted: any[] = [];
			const events = { ...recorder().events, onCompacted: (i: any) => compacted.push(i) };
			const result = await agent.compact(events, new AbortController().signal, { focus: 'geography' });

			const req = requests.at(-1);
			expect(isSummaryRequest(req)).toBe(true);
			expect(req.tools).toBeUndefined();
			expect(req.messages[1].content).toContain('User: What is the capital of France?');
			expect(req.messages[1].content).toContain('Jane: Paris.');
			expect(req.messages[1].content).toContain('focus on: geography');

			expect(agent.messages).toHaveLength(1);
			expect(isSummary(agent.messages[0]!)).toBe(true);
			expect(agent.messages[0]!.content).toContain('Asked for the capital of France.');
			expect(compacted).toEqual([{ ...result, auto: false }]);

			replies = [{ content: 'ok' }];
			await agent.run('and Spain?', recorder().events, new AbortController().signal);
			const loaded = loadSession(agent.session.file);
			expect(loaded.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
			expect(isSummary(loaded.messages[0]!)).toBe(true);
			expect(loaded.allMessages.map((m) => m.content)).toEqual([
				'What is the capital of France?',
				'Paris.',
				agent.messages[0]!.content,
				'and Spain?',
				'ok',
			]);
		});

		it('compacts before a new prompt when the context is nearly full, keeping the prompt word for word', async () => {
			const agent = makeAgent();
			agent.contextWindow = 1000;
			agent.autoCompactPercent = 80;
			replies = [{ content: 'first answer', promptTokens: 900 }];
			await agent.run('first', recorder().events, new AbortController().signal);
			replies = [{ content: 'summary of first' }, { content: 'second answer' }];
			await agent.run('second question', recorder().events, new AbortController().signal);
			expect(isSummaryRequest(requests.at(-2))).toBe(true);
			const last = requests.at(-1).messages;
			expect(last.slice(1).map((m: any) => m.content)).toEqual([expect.stringContaining('summary of first'), 'second question']);
		});

		it('compacts in the middle of a task and carries on', async () => {
			fs.writeFileSync(path.join(dir, 'big.txt'), ('x'.repeat(100) + '\n').repeat(60));
			const agent = makeAgent();
			agent.contextWindow = 1500;
			agent.autoCompactPercent = 80;
			const notices: string[] = [];
			replies = [
				{ calls: [{ name: 'read', args: '{"path":"big.txt"}' }], promptTokens: 300 },
				{ content: 'Summary: reading big.txt for the user.' },
				{ content: 'It is full of x.' },
			];
			const events = { ...recorder().events, onCompacted: () => notices.push('compacted') };
			expect(await agent.run('what is in big.txt?', events, new AbortController().signal)).toBe('done');
			expect(notices).toEqual(['compacted']);
			expect(requests.map(isSummaryRequest)).toEqual([false, true, false]);
			// The summary request had the long tool output shortened.
			expect(requests[1].messages[1].content).toMatch(/characters cut/);
			expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		});

		it('compacts and retries once when the server says the context is full', async () => {
			const agent = makeAgent();
			replies = [{ content: 'a' }];
			await agent.run('one', recorder().events, new AbortController().signal);
			replies = [
				{ status: 400, body: '{"error":{"message":"the request exceeds the available context size, try increasing it"}}' },
				{ content: 'summary' },
				{ content: 'answer' },
			];
			const notices: string[] = [];
			const events = { ...recorder().events, onNotice: (t: string) => notices.push(t) };
			expect(await agent.run('two', events, new AbortController().signal)).toBe('done');
			expect(notices).toEqual([expect.stringMatching(/no longer fits/)]);
			expect(requests.slice(-3).map(isSummaryRequest)).toEqual([false, true, false]);

			// A second overflow in the same turn is reported, not retried forever.
			replies = [
				{ status: 400, body: 'exceeds the available context size' },
				{ content: 'summary' },
				{ status: 400, body: 'exceeds the available context size' },
			];
			await expect(agent.run('three', recorder().events, new AbortController().signal)).rejects.toThrow(/context size/);
		});

		it('leaves the conversation alone when compacting is interrupted', async () => {
			const agent = makeAgent();
			replies = [{ content: 'a' }];
			await agent.run('one', recorder().events, new AbortController().signal);
			const before = [...agent.messages];
			replies = [{ content: 'summary', delay: 500 }];
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			await expect(agent.compact(recorder().events, controller.signal)).rejects.toThrow();
			expect(agent.messages).toEqual(before);
			expect(loadSession(agent.session.file).messages).toEqual(before);
		});

		it('refuses to compact an empty conversation or keep an empty summary', async () => {
			const agent = makeAgent();
			await expect(agent.compact(recorder().events, new AbortController().signal)).rejects.toThrow(/nothing to compact/);
			replies = [{ content: 'a' }, { content: '   ' }];
			await agent.run('one', recorder().events, new AbortController().signal);
			await expect(agent.compact(recorder().events, new AbortController().signal)).rejects.toThrow(/empty summary/);
			expect(agent.messages).toHaveLength(2);
		});
	});

	it('runs the beforeTurn hook at the start of every turn', async () => {
		const agent = makeAgent();
		let calls = 0;
		agent.beforeTurn = () => {
			calls++;
			agent.system = `system v${calls}`;
		};
		replies = [{ content: 'a' }, { content: 'b' }];
		await agent.run('one', recorder().events, new AbortController().signal);
		await agent.run('two', recorder().events, new AbortController().signal);
		expect(calls).toBe(2);
		expect(requests.at(-1).messages[0]).toEqual({ role: 'system', content: 'system v2' });
	});
});
