import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type PermissionDecision, stripNotes, withNotes } from '../src/agent.js';
import { type Host, HostManager } from '../src/hosts.js';
import { Session } from '../src/session.js';
import { type Helper, Helpers, MAX_RUNNING, makeAgentTool, reportText } from '../src/subagents.js';
import { tools } from '../src/tools/index.js';

// A fake model server per host. Each reply: text, or tool calls; `delay` makes it slow.
type Reply = { content?: string; calls?: { name: string; args: string }[]; delay?: number };
type Fake = { url: string; replies: Reply[]; requests: any[]; server: http.Server };

async function fakeHost(): Promise<Fake> {
	const fake = { replies: [] as Reply[], requests: [] as any[] } as Fake;
	fake.server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (d) => (body += d));
		req.on('end', () => {
			if (req.url?.endsWith('/models')) return res.writeHead(200).end('{"data":[]}');
			fake.requests.push(JSON.parse(body));
			const reply = fake.replies.shift() ?? { content: 'out of replies' };
			const chunks: unknown[] = [];
			if (reply.content) chunks.push({ choices: [{ delta: { content: reply.content } }] });
			(reply.calls ?? []).forEach((c, index) => chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `c${index}-${Math.random()}`, function: { name: c.name, arguments: c.args } }] } }] }));
			chunks.push({ choices: [{ delta: {}, finish_reason: reply.calls ? 'tool_calls' : 'stop' }] });
			setTimeout(() => {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
			}, reply.delay ?? 0);
		});
	});
	await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
	fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/v1`;
	return fake;
}

let dir: string;
let home: Fake;
let local: Fake;
let hosts: HostManager;
let main: Agent;
let events: { finished: Helper[]; asked: string[]; decision: PermissionDecision };
let helpers: Helpers;

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-helpers-'));
	home = await fakeHost();
	local = await fakeHost();
	const h = (name: string, fake: Fake): Host => ({ name, baseUrl: fake.url, model: `${name}-model`, contextWindow: 65536 });
	hosts = new HostManager([h('home', home), h('local', local)]);
	await hosts.start();
	main = new Agent({ baseUrl: home.url, model: 'home-model' }, 'unrestricted', 'main system', dir, new Session(dir, 'm', { root: path.join(dir, 'sessions') }));
	events = { finished: [], asked: [], decision: { kind: 'yes' } };
	helpers = new Helpers(hosts, () => main, (host) => `helper system on ${host.name}`, {
		changed: () => {},
		finished: (helper) => events.finished.push(helper),
		askPermission: async (helper, request) => {
			events.asked.push(`#${helper.id} ${request.tool.name}`);
			return events.decision;
		},
		notice: () => {},
	});
	main.tools = [...tools, makeAgentTool(helpers)];
});
afterEach(() => {
	helpers.stopAll();
	home.server.close();
	local.server.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

describe('helper agents', () => {
	it('run on a free host other than the main one, with their own conversation', async () => {
		local.replies = [{ content: 'The README explains install and use.' }];
		const helper = await helpers.start({ task: 'Summarise the README', name: 'readme', background: false, signal: signal() });
		expect(helper.host.name).toBe('local');
		expect(helper.state).toBe('done');
		expect(helper.report).toBe('The README explains install and use.');
		// Its own system prompt and task; no helpers of its own.
		expect(local.requests[0].messages.map((m: any) => m.content)).toEqual(['helper system on local', 'Summarise the README']);
		expect(local.requests[0].tools.map((t: any) => t.function.name)).not.toContain('agent');
		expect(home.requests).toEqual([]);
		// Its conversation is saved next to the main session.
		expect(helper.agent.session.file).toBe(path.join(path.dirname(main.session.file), `${main.session.id}.agents`, '1-readme.jsonl'));
		expect(fs.existsSync(helper.agent.session.file)).toBe(true);
	});

	it('share the main host when no other is free, and use a named host when asked', async () => {
		home.replies = [{ content: 'a' }];
		local.replies = [{ content: 'b' }];
		const busy = await helpers.start({ task: 'x', host: 'home', background: false, signal: signal() });
		expect(busy.host.name).toBe('home');
		local.server.close();
		await new Promise((r) => setTimeout(r, 50));
		home.replies = [{ content: 'c' }];
		const shared = await helpers.start({ task: 'y', background: false, signal: signal() });
		expect(shared.host.name).toBe('home');
		await expect(helpers.start({ task: 'z', host: 'local', background: false, signal: signal() })).rejects.toThrow(/isn't available/);
		await expect(helpers.start({ task: 'z', host: 'nas', background: false, signal: signal() })).rejects.toThrow(/no host called "nas"/);
	});

	it('report back through the agent tool, and run in parallel when asked together', async () => {
		home.replies = [
			{ calls: [{ name: 'agent', args: '{"task":"check A","name":"A"}' }, { name: 'agent', args: '{"task":"check B","name":"B","host":"home"}' }] },
			{ delay: 400, content: 'B is fine' }, // the helper on home
			{ content: 'All checked.' },
		];
		local.replies = [{ delay: 400, content: 'A is fine' }];
		const started = Date.now();
		await main.run('check both', { askPermission: async () => ({ kind: 'yes' }) }, signal());
		const took = Date.now() - started;
		expect(took).toBeLessThan(750); // two 400 ms helpers at the same time, not one after the other
		const results = main.messages.filter((m) => m.role === 'tool').map((m) => m.content);
		expect(results).toEqual([
			expect.stringMatching(/^Report from helper "A" \(on local, 0 tool calls, \d+s\):\n\nA is fine$/),
			expect.stringMatching(/^Report from helper "B" \(on home, 0 tool calls, \d+s\):\n\nB is fine$/),
		]);
	});

	it('in the background, return at once and deliver the report later', async () => {
		local.replies = [{ delay: 300, content: 'found 3 TODOs' }];
		const tool = makeAgentTool(helpers);
		const result = await tool.run({ task: 'find TODOs', name: 'todos', background: true }, { cwd: dir, signal: signal() });
		expect(result.output).toMatch(/^Started helper "todos" \(#1\) on local in the background/);
		expect(events.finished).toEqual([]);
		await helpers.list[0]!.done;
		expect(events.finished.map((h) => h.state)).toEqual(['done']);
		expect(reportText(helpers.list[0]!)).toMatch(/found 3 TODOs$/);
	});

	it('ask for permission through the user, labelled, and share "yes for this session"', async () => {
		main.mode = 'always-ask';
		local.replies = [{ calls: [{ name: 'bash', args: '{"command":"echo hi"}' }] }, { calls: [{ name: 'bash', args: '{"command":"echo again"}' }] }, { content: 'done' }];
		events.decision = { kind: 'always' };
		await helpers.start({ task: 'run things', background: false, signal: signal() });
		expect(events.asked).toEqual(['#1 bash']);
		expect(main.allowedForSession.has('bash')).toBe(true);
	});

	it('can be stopped, and are limited in number', async () => {
		local.replies = [{ delay: 5000, content: 'never' }];
		const helper = await helpers.start({ task: 'slow', background: true, signal: signal() });
		expect(helpers.stop(helper.id)).toBe(true);
		await helper.done;
		expect(helper.state).toBe('stopped');
		for (let i = 0; i < MAX_RUNNING; i++) await helpers.start({ task: `t${i}`, background: true, signal: signal() });
		await expect(helpers.start({ task: 'one too many', background: true, signal: signal() })).rejects.toThrow(/already running/);
	});

	it('send background reports in front of the next message, hidden on screen', () => {
		const message = withNotes('next question', [], [], ['Report from helper "x": all good']);
		expect(message).toBe('[Reports from helper agents]\nReport from helper "x": all good\n[End of reports from helper agents]\n\nnext question');
		expect(stripNotes(message)).toBe('next question');
	});
});
