import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import { ModelError, streamChat } from '../src/client.js';
import { defaultConfig, loadConfig } from '../src/config.js';
import { type Host, type HostStatus, HostManager, hostsFromConfig, probe } from '../src/hosts.js';
import { Session } from '../src/session.js';

let dir: string;
let servers: http.Server[] = [];
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-hosts-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	for (const s of servers) s.closeAllConnections?.(), s.close();
	servers = [];
});

/** A tiny model server: /models, and chat replies that say which server answered. */
async function fakeServer(name: string, options: { key?: string; dropMidStream?: boolean } = {}): Promise<{ url: string; server: http.Server }> {
	const server = http.createServer((req, res) => {
		if (options.key && req.headers.authorization !== `Bearer ${options.key}`) return res.writeHead(401).end('{"error":"unauthorized"}');
		if (req.url?.endsWith('/models')) return res.writeHead(200).end(JSON.stringify({ data: [{ id: `${name}-model` }] }));
		req.resume();
		req.on('end', () => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `from ${name}` } }] })}\n\n`);
			if (options.dropMidStream) return res.destroy();
			res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	servers.push(server);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server };
}

const host = (name: string, extra: Partial<Host> = {}): Host => ({ name, baseUrl: `http://${name}/v1`, model: `${name}-m`, contextWindow: 65536, ...extra });

describe('hosts config', () => {
	it('reads [[hosts]] and puts [model] last as "local"', () => {
		const file = path.join(dir, 'c.toml');
		fs.writeFileSync(
			file,
			`[model]\nname = "small"\n\n[[hosts]]\nname = "home"\nbase_url = "http://192.168.86.42:8080/v1/"\nmodel = "big"\ncontext_window = 131072\napi_key = "k"\n`,
		);
		const { config, warnings } = loadConfig(dir, [file], () => undefined);
		expect(warnings).toEqual([]);
		expect(hostsFromConfig(config)).toEqual([
			{ name: 'home', baseUrl: 'http://192.168.86.42:8080/v1', model: 'big', contextWindow: 131072, apiKey: 'k' },
			{ name: 'local', baseUrl: defaultConfig.model.base_url, model: 'small', contextWindow: 65536, apiKey: undefined },
		]);
	});

	it('skips broken host entries with a clear warning', () => {
		const file = path.join(dir, 'c.toml');
		fs.writeFileSync(
			file,
			[
				'[[hosts]]\nname = "ok"\nbase_url = "http://a/v1"\nmodel = "m"',
				'[[hosts]]\nname = "local"\nbase_url = "http://b/v1"\nmodel = "m"',
				'[[hosts]]\nname = "ok"\nbase_url = "http://c/v1"\nmodel = "m"',
				'[[hosts]]\nname = "x"\nbase_url = "192.168.1.2:8080"\nmodel = "m"\ncolour = "red"',
			].join('\n\n'),
		);
		const { config, warnings } = loadConfig(dir, [file], () => undefined);
		expect(config.hosts.map((h) => h.name)).toEqual(['ok']);
		expect(config.hosts[0]!.context_window).toBe(65536);
		expect(warnings).toEqual([
			expect.stringMatching(/hosts #2 was skipped: it needs a name other than "local"/),
			expect.stringMatching(/hosts #3 was skipped: it needs a unique name/),
			expect.stringMatching(/hosts #4: unknown setting "colour"$/),
			expect.stringMatching(/hosts #4 was skipped: it needs base_url/),
		]);
	});
});

describe('probe', () => {
	it('tells apart up, wrong key and down', async () => {
		const { url } = await fakeServer('home', { key: 'secret' });
		expect(await probe({ ...host('home'), baseUrl: url, apiKey: 'secret' })).toEqual({ ok: true, models: ['home-model'] });
		expect(await probe({ ...host('home'), baseUrl: url, apiKey: 'nope' })).toEqual({ ok: false, reason: 'wrong or missing API key' });
		expect(await probe({ ...host('home'), baseUrl: 'http://127.0.0.1:9/v1' })).toEqual({ ok: false, reason: 'not reachable' });
	});

	it('gives up on a host that doesn\'t answer in time', async () => {
		const server = http.createServer(() => {}); // accepts, never answers
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		servers.push(server);
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		const started = Date.now();
		expect(await probe({ ...host('slow'), baseUrl: url }, 300)).toEqual({ ok: false, reason: 'not answering' });
		expect(Date.now() - started).toBeLessThan(1500);
	});
});

describe('HostManager', () => {
	const fake = (up: Record<string, boolean>) => async (h: Host): Promise<HostStatus> =>
		up[h.name] ? { ok: true, models: [] } : { ok: false, reason: 'not reachable' };

	it('starts on the first host that answers, or the one asked for', async () => {
		const up = { home: false, office: true, local: true };
		const manager = new HostManager([host('home'), host('office'), host('local')], fake(up));
		const { host: picked, skipped } = await manager.start();
		expect(picked.name).toBe('office');
		expect(skipped).toEqual([{ host: manager.hosts[0], reason: 'not reachable' }]);
		expect((await manager.start('home')).host.name).toBe('home');
		await expect(manager.start('nas')).rejects.toThrow('there is no host called "nas" (hosts: home, office, local)');
	});

	it('falls back to the next reachable host', async () => {
		const up = { home: true, office: false, local: true };
		const manager = new HostManager([host('home'), host('office'), host('local')], fake(up));
		await manager.start();
		up.home = false;
		expect((await manager.failover())?.name).toBe('local');
		up.local = false;
		expect(await manager.failover()).toBeUndefined();
	});

	it('says once when a preferred host is back, and again after it went away', async () => {
		const up = { home: false, local: true };
		const manager = new HostManager([host('home'), host('local')], fake(up));
		await manager.start();
		expect(await manager.preferredAvailable()).toBeUndefined();
		up.home = true;
		expect((await manager.preferredAvailable())?.name).toBe('home');
		expect(await manager.preferredAvailable()).toBeUndefined(); // already said
		up.home = false;
		await manager.preferredAvailable();
		up.home = true;
		expect((await manager.preferredAvailable())?.name).toBe('home');
		manager.current = manager.hosts[0]!;
		expect(await manager.preferredAvailable()).toBeUndefined(); // nothing is preferred over the first
	});
});

describe('failover in the agent', () => {
	it('treats a dropped connection as unreachable', async () => {
		const { url } = await fakeServer('flaky', { dropMidStream: true });
		const error = await streamChat({ baseUrl: url, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }).catch((e) => e);
		expect(error).toBeInstanceOf(ModelError);
		expect(error.unreachable).toBe(true);
	});

	it('switches host and sends the same request again', async () => {
		const home = await fakeServer('home');
		const local = await fakeServer('local');
		const agent = new Agent({ baseUrl: home.url, model: 'm' }, 'unrestricted', 'sys', dir, new Session(dir, 'm', { root: dir }));
		let switched = 0;
		agent.failover = async () => {
			switched++;
			agent.settings = { baseUrl: local.url, model: 'local-m' };
			return true;
		};
		const replies: string[] = [];
		let discarded = 0;
		const events = {
			onReply: (r: { content: string }) => replies.push(r.content),
			onDiscard: () => discarded++,
			askPermission: async () => ({ kind: 'yes' as const }),
		};

		home.server.closeAllConnections();
		await new Promise<void>((r) => home.server.close(() => r()));
		expect(await agent.run('hello', events, new AbortController().signal)).toBe('done');
		expect(switched).toBe(1);
		expect(discarded).toBe(1);
		expect(replies).toEqual(['from local']);
		expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
	});

	it('reports the error when no other host is available', async () => {
		const agent = new Agent({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }, 'unrestricted', 'sys', dir, new Session(dir, 'm', { root: dir }));
		agent.failover = async () => false;
		await expect(agent.run('hello', { askPermission: async () => ({ kind: 'yes' }) }, new AbortController().signal)).rejects.toThrow(/can't reach/);
	});
});
