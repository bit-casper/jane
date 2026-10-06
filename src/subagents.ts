// Helper agents: the model hands a task to a helper with its own fresh
// conversation and the same tools, on another host when one is free. A helper
// runs in the foreground (the model waits for its report) or in the
// background (the report arrives with the user's next message).

import { Agent, type AgentEvents, type PermissionDecision, type PermissionRequest } from './agent.js';
import { type Host, type HostManager, probe } from './hosts.js';
import { Session } from './session.js';
import { type Tool, ToolError } from './tools/types.js';

export type HelperState = 'running' | 'done' | 'failed' | 'stopped';

export type Helper = {
	id: number;
	name: string;
	task: string;
	host: Host;
	background: boolean;
	state: HelperState;
	started: number;
	ended?: number;
	toolCalls: number;
	/** What the helper is doing right now, e.g. "Read src/app.ts". */
	activity: string;
	report?: string;
	error?: string;
	agent: Agent;
	controller: AbortController;
	done: Promise<void>;
};

/** What the app does for helpers: show them, and ask the user for permission on their behalf. */
export type HelperUi = {
	changed(helper: Helper): void;
	finished(helper: Helper): void;
	askPermission(helper: Helper, request: PermissionRequest): Promise<PermissionDecision>;
	notice(text: string, tone: 'info' | 'warning' | 'error'): void;
};

export const MAX_RUNNING = 3;

export const HELPER_INSTRUCTIONS = `# You are a helper agent
Jane's main conversation started you to do one task on your own. The user doesn't see your messages and you can't ask them anything: work it out with your tools. When you're done, your final reply is passed back as your report, so make it a complete answer on its own: what you found or did, with file paths and key details, and anything that didn't work.`;

export function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'helper';
}

export function seconds(helper: Helper): number {
	return Math.round(((helper.ended ?? Date.now()) - helper.started) / 1000);
}

/** Keeps track of helpers and starts them on a suitable host. */
export class Helpers {
	readonly list: Helper[] = [];
	private nextId = 1;

	constructor(
		private hosts: HostManager,
		/** The main conversation's agent (for its tools, settings and session). */
		private main: () => Agent | null,
		/** The system prompt for a helper on a given host. */
		private systemFor: (host: Host) => string,
		private ui: HelperUi,
		private check: (host: Host) => ReturnType<typeof probe> = probe,
	) {}

	running(): Helper[] {
		return this.list.filter((h) => h.state === 'running');
	}

	/**
	 * The host for a new helper: the one asked for, else the first reachable host
	 * that neither the main conversation nor another helper is using, else the
	 * main conversation's host (they then take turns).
	 */
	async pickHost(requested?: string): Promise<Host> {
		if (requested) {
			const host = this.hosts.find(requested);
			if (!host) throw new ToolError(`There is no host called "${requested}". The hosts are: ${this.hosts.hosts.map((h) => h.name).join(', ')}.`);
			const status = await this.check(host);
			this.hosts.status.set(host.name, status);
			if (!status.ok) throw new ToolError(`The host "${requested}" isn't available (${status.reason}).`);
			return host;
		}
		const busy = new Set([this.hosts.current.name, ...this.running().map((h) => h.host.name)]);
		for (const host of this.hosts.hosts) {
			if (busy.has(host.name)) continue;
			const status = await this.check(host);
			this.hosts.status.set(host.name, status);
			if (status.ok) return host;
		}
		return this.hosts.current;
	}

	/** Start a helper. Foreground: resolves when it's done. Background: resolves right away. */
	async start(options: { task: string; name?: string; host?: string; background: boolean; signal: AbortSignal }): Promise<Helper> {
		const main = this.main();
		if (!main) throw new ToolError('Jane is not ready yet.');
		if (this.running().length >= MAX_RUNNING) {
			throw new ToolError(`${MAX_RUNNING} helpers are already running. Wait for one to finish (or use a foreground helper later).`);
		}
		const host = await this.pickHost(options.host);
		const id = this.nextId++;
		const name = (options.name?.trim() || options.task.split('\n')[0]!).slice(0, 40);
		const session = new Session(main.cwd, host.model, { id: `${main.session.id}.agents/${id}-${slug(name)}`, root: main.session.root });
		const agent = new Agent({ baseUrl: host.baseUrl, apiKey: host.apiKey, model: host.model }, main.mode, this.systemFor(host), main.cwd, session);
		// Same tools and safety as the main conversation, but no helpers of its own.
		agent.tools = main.tools.filter((t) => t.name !== 'agent');
		agent.checkpoints = main.checkpoints;
		agent.blockRules = main.blockRules;
		agent.hooks = main.hooks;
		agent.allowedForSession = main.allowedForSession;
		agent.contextWindow = host.contextWindow;
		agent.autoCompactPercent = main.autoCompactPercent;

		const controller = new AbortController();
		// A foreground helper stops when the main turn is interrupted; a background one only when stopped itself.
		if (!options.background) options.signal.addEventListener('abort', () => controller.abort(), { once: true });

		const helper: Helper = {
			id,
			name,
			task: options.task,
			host,
			background: options.background,
			state: 'running',
			started: Date.now(),
			toolCalls: 0,
			activity: 'starting',
			agent,
			controller,
			done: Promise.resolve(),
		};
		agent.failover = async () => {
			// The helper's host went away: carry on elsewhere if possible.
			for (const other of this.hosts.hosts) {
				if (other === helper.host) continue;
				const status = await this.check(other);
				if (!status.ok) continue;
				helper.host = other;
				agent.settings = { baseUrl: other.baseUrl, apiKey: other.apiKey, model: other.model };
				agent.contextWindow = other.contextWindow;
				this.ui.notice(`Helper "${name}" lost its host, so it moved to ${other.name}.`, 'warning');
				return true;
			}
			return false;
		};

		const events: AgentEvents = {
			onToolStart: (call) => {
				helper.toolCalls++;
				helper.activity = call.label ? `${call.name} ${call.label}` : call.name;
				this.ui.changed(helper);
			},
			onReasoning: () => {
				if (helper.activity !== 'thinking') {
					helper.activity = 'thinking';
					this.ui.changed(helper);
				}
			},
			onNotice: (text, tone) => this.ui.notice(`Helper "${name}": ${text}`, tone),
			askPermission: (request) => this.ui.askPermission(helper, request),
		};

		this.list.push(helper);
		this.ui.changed(helper);
		helper.done = (async () => {
			try {
				const outcome = await agent.run(options.task, events, controller.signal);
				const last = [...agent.messages].reverse().find((m) => m.role === 'assistant' && m.content?.trim());
				helper.report = (last?.content as string | undefined)?.trim();
				if (outcome === 'interrupted') helper.state = 'stopped';
				else if (outcome === 'done') helper.state = 'done';
				else {
					helper.state = 'failed';
					helper.error = outcome === 'denied' ? 'the user said no to one of its actions' : outcome === 'too-many-bad-calls' ? 'the model kept making bad tool calls' : 'it took too many steps';
				}
			} catch (error) {
				helper.state = controller.signal.aborted ? 'stopped' : 'failed';
				helper.error = (error as Error).message;
			}
			helper.ended = Date.now();
			helper.activity = '';
			this.ui.changed(helper);
			this.ui.finished(helper);
		})();
		if (!options.background) await helper.done;
		return helper;
	}

	stop(id: number): boolean {
		const helper = this.list.find((h) => h.id === id && h.state === 'running');
		if (!helper) return false;
		helper.controller.abort();
		return true;
	}

	stopAll(): void {
		for (const helper of this.running()) helper.controller.abort();
	}
}

/** What the main conversation gets back from a helper. */
export function reportText(helper: Helper): string {
	const where = `on ${helper.host.name}, ${helper.toolCalls} tool call${helper.toolCalls === 1 ? '' : 's'}, ${seconds(helper)}s`;
	if (helper.state === 'done') return `Report from helper "${helper.name}" (${where}):\n\n${helper.report ?? '(it gave no report)'}`;
	const why = helper.state === 'stopped' ? 'was stopped' : `didn't finish: ${helper.error}`;
	return `Helper "${helper.name}" ${why} (${where}).${helper.report ? `\n\nIts last message:\n${helper.report}` : ''}`;
}

type AgentArgs = { task: string; name?: string; host?: string; background?: boolean };

export function makeAgentTool(helpers: Helpers): Tool<AgentArgs> {
	return {
		name: 'agent',
		description:
			'Hand a task to a helper agent: it works on its own with the same tools in a fresh conversation, then reports back. ' +
			'Good for self-contained work like researching a question across many files, reviewing code, or doing several things at once ' +
			'(call agent several times in one reply to run helpers in parallel). The helper does not see this conversation, so put everything ' +
			'it needs in the task. Helpers run on another host when one is free (see "Where you run"). Set background to true to keep working ' +
			"with the user while it runs; its report then arrives with the user's next message.",
		params: {
			task: { type: 'string', description: 'The complete task, with all the context the helper needs', required: true },
			name: { type: 'string', description: 'A short name for the helper, e.g. "review README"' },
			host: { type: 'string', description: 'Run on this host instead of picking one' },
			background: { type: 'boolean', description: 'Run in the background and return right away (default false)' },
		},
		// Starting a helper changes nothing; its own actions ask as usual.
		needsPermission: false,
		label: (args) => (args.name?.trim() || args.task.replace(/\s+/g, ' ')).slice(0, 60) + (args.background ? ' (background)' : ''),
		async run(args, { signal }) {
			const helper = await helpers.start({ task: args.task, name: args.name, host: args.host, background: Boolean(args.background), signal });
			if (args.background) {
				return {
					output: `Started helper "${helper.name}" (#${helper.id}) on ${helper.host.name} in the background. Its report will arrive with the user's next message after it finishes; you can carry on meanwhile.`,
					display: { summary: `started in the background on ${helper.host.name} (#${helper.id})` },
				};
			}
			const report = reportText(helper);
			return {
				output: report,
				isError: helper.state !== 'done',
				display: {
					summary: `${helper.state === 'done' ? 'done' : helper.state} on ${helper.host.name} · ${helper.toolCalls} tool calls · ${seconds(helper)}s`,
					text: helper.report ? helper.report.split('\n').slice(0, 6).join('\n') : undefined,
				},
			};
		},
	};
}
