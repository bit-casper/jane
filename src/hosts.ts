// Hosts: the machines Jane can send requests to. [[hosts]] in the config are
// tried first, in order; [model] is this machine ("local"), the last resort.

import type { Config } from './config.js';

export type Host = {
	name: string;
	baseUrl: string;
	model: string;
	contextWindow: number;
	apiKey?: string;
};

export type HostStatus = { ok: true; models: string[] } | { ok: false; reason: string };

export const LOCAL_HOST = 'local';
const PROBE_TIMEOUT_MS = 1500;

export function hostsFromConfig(config: Config): Host[] {
	const remote = config.hosts.map((h) => ({
		name: h.name,
		baseUrl: h.base_url,
		model: h.model,
		contextWindow: h.context_window,
		apiKey: h.api_key || undefined,
	}));
	const local: Host = {
		name: LOCAL_HOST,
		baseUrl: config.model.base_url,
		model: config.model.name,
		contextWindow: config.model.context_window,
		apiKey: config.model.api_key || undefined,
	};
	return [...remote, local];
}

/** Ask a host which models it serves, to see whether it's up and the key is right. */
export async function probe(host: Host, timeoutMs = PROBE_TIMEOUT_MS): Promise<HostStatus> {
	let response: Response;
	try {
		response = await fetch(`${host.baseUrl}/models`, {
			headers: host.apiKey ? { Authorization: `Bearer ${host.apiKey}` } : {},
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name = (error as Error).name;
		return { ok: false, reason: name === 'TimeoutError' ? 'not answering' : 'not reachable' };
	}
	if (response.status === 401 || response.status === 403) return { ok: false, reason: 'wrong or missing API key' };
	if (!response.ok) return { ok: false, reason: `server error ${response.status}` };
	try {
		const json = (await response.json()) as { data?: { id: string }[] };
		return { ok: true, models: (json.data ?? []).map((m) => m.id) };
	} catch {
		return { ok: true, models: [] };
	}
}

export function describeHost(host: Host): string {
	return `${host.model} · ${Math.round(host.contextWindow / 1024)}k context`;
}

/** Keeps track of which host is in use and finds another when it stops answering. */
export class HostManager {
	current: Host;
	/** Last known status of each host, by name. */
	readonly status = new Map<string, HostStatus>();
	/** Preferred hosts we've already said are back, so we only say it once. */
	private announced = new Set<string>();

	constructor(
		readonly hosts: Host[],
		private check: (host: Host) => Promise<HostStatus> = probe,
	) {
		this.current = hosts.at(-1)!;
	}

	find(name: string): Host | undefined {
		return this.hosts.find((h) => h.name === name);
	}

	/** Check every host at once. */
	async checkAll(): Promise<void> {
		const results = await Promise.all(this.hosts.map((h) => this.check(h)));
		this.hosts.forEach((h, i) => this.status.set(h.name, results[i]!));
	}

	/** Pick a host to start with: the forced one, or the first that answers (local if none do). */
	async start(forced?: string): Promise<{ host: Host; skipped: { host: Host; reason: string }[] }> {
		await this.checkAll();
		const skipped: { host: Host; reason: string }[] = [];
		if (forced) {
			const host = this.find(forced);
			if (!host) throw new Error(`there is no host called "${forced}" (hosts: ${this.hosts.map((h) => h.name).join(', ')})`);
			this.current = host;
			return { host, skipped };
		}
		for (const host of this.hosts) {
			const status = this.status.get(host.name)!;
			if (status.ok) {
				this.current = host;
				return { host, skipped };
			}
			skipped.push({ host, reason: status.reason });
		}
		this.current = this.hosts.at(-1)!;
		return { host: this.current, skipped };
	}

	/** The current host stopped answering: switch to the next one that answers, if any. */
	async failover(): Promise<Host | undefined> {
		const failed = this.current;
		this.status.set(failed.name, { ok: false, reason: 'stopped answering' });
		for (const host of this.hosts) {
			if (host === failed) continue;
			const status = await this.check(host);
			this.status.set(host.name, status);
			if (status.ok) {
				this.current = host;
				this.announced.delete(failed.name);
				return host;
			}
		}
		return undefined;
	}

	/**
	 * A host higher in the list than the current one that is answering again,
	 * the first time it's noticed. Used to tell the user; Jane doesn't switch by itself.
	 */
	async preferredAvailable(): Promise<Host | undefined> {
		const index = this.hosts.indexOf(this.current);
		for (const host of this.hosts.slice(0, index)) {
			const status = await this.check(host);
			this.status.set(host.name, status);
			if (!status.ok) {
				this.announced.delete(host.name);
				continue;
			}
			if (this.announced.has(host.name)) return undefined;
			this.announced.add(host.name);
			return host;
		}
		return undefined;
	}
}
