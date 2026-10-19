// Print mode (jane -p): run one turn without the interface and print Jane's
// answer, so scripts and other agents can hand her a task. Progress goes to
// stderr, the answer to stdout. Nobody can answer a permission question here,
// so Jane runs unrestricted unless --mode says otherwise; the block list and
// hooks still apply.

import path from 'node:path';
import { Agent, type AgentEvents, MAX_BAD_CALLS, type TurnOutcome } from './agent.js';
import { compileBlockList } from './blocklist.js';
import { Checkpoints } from './checkpoints.js';
import { ModelError } from './client.js';
import type { Config, PermissionMode } from './config.js';
import { type HookEvent, type HookPayload, blockMessage, hookProblem, isTrusted, isTrustedPrint, runHooks } from './hooks.js';
import { type HostManager, describeHost, hostVision, hostsPromptSection } from './hosts.js';
import { checkImage, imagePathsIn } from './images.js';
import { loadInstructions } from './instructions.js';
import { log } from './log.js';
import { McpManager, mcpFingerprint } from './mcp.js';
import { loadPromptBase, systemPrompt } from './prompt.js';
import { Session, type SessionSummary, loadSession } from './session.js';
import { discoverSkills, skillDirs, skillsPrompt } from './skills.js';
import { HELPER_INSTRUCTIONS, Helpers, makeAgentTool, reportText } from './subagents.js';
import { tools as baseTools } from './tools/index.js';
import { makeSkillTool } from './tools/skill.js';
import { type Tool, resolvePath } from './tools/types.js';
import { webTools } from './tools/web.js';

export type PrintOptions = {
	prompt: string;
	cwd: string;
	config: Config;
	hosts: HostManager;
	/** Notes from picking a host and loading the config, shown on stderr. */
	notes: string[];
	resume?: SessionSummary;
	/** From --mode; without it, unrestricted. */
	mode?: PermissionMode;
	json: boolean;
	/** For tests: where sessions are kept, and where output goes. */
	sessionsRoot?: string;
	out?: (text: string) => void;
	err?: (text: string) => void;
};

/** Exit codes: 0 Jane finished, 1 an error (e.g. the model server), 2 she was stopped (refused, step limit, Ctrl+C). */
export async function runPrint(o: PrintOptions): Promise<number> {
	const out = o.out ?? ((t) => process.stdout.write(t));
	const err = o.err ?? ((t) => process.stderr.write(t));
	const say = (line: string) => err(`${line}\n`);
	const { cwd, config, hosts } = o;
	for (const note of o.notes) say(`jane: ${note}`);

	const instructions = loadInstructions(cwd, config.instructions.filenames);
	const base = loadPromptBase(config.prompt.file, cwd);
	if (base.warning) say(`jane: ${base.warning}`);
	const found = discoverSkills(skillDirs(cwd, config.skills.sources, config.skills.extra_dirs));
	for (const w of found.warnings) say(`jane: skills: ${w}`);
	const listed = skillsPrompt(found.skills);

	const loaded = o.resume ? loadSession(o.resume.file) : undefined;
	const host = hosts.current;
	const session = new Session(cwd, host.model, { id: o.resume?.id, root: o.sessionsRoot });
	const mode = o.mode ?? 'unrestricted';
	const agent = new Agent(
		{ baseUrl: host.baseUrl, apiKey: host.apiKey, model: host.model },
		mode,
		systemPrompt(cwd, instructions, [hostsPromptSection(hosts), ...(listed ? [listed] : [])], base.text),
		cwd,
		session,
		loaded?.messages ?? [],
	);
	session.setMode(mode);
	if (config.checkpoints.enabled) agent.checkpoints = new Checkpoints(session.file.replace(/\.jsonl$/, '.checkpoints'));
	if (config.block_list.enabled) agent.blockRules = compileBlockList(config.block_list.patterns).rules;
	agent.contextWindow = host.contextWindow;
	agent.vision = hostVision(hosts.status.get(host.name));
	agent.autoCompactPercent = config.compact.auto ? config.compact.at_percent : 0;
	agent.failover = async () => {
		const failed = hosts.current;
		const next = await hosts.failover();
		if (!next) return false;
		agent.settings = { baseUrl: next.baseUrl, apiKey: next.apiKey, model: next.model };
		agent.contextWindow = next.contextWindow;
		agent.vision = hostVision(hosts.status.get(next.name));
		session.setModel(next.model);
		say(`jane: ${failed.name} stopped answering, so Jane switched to ${next.name} (${describeHost(next)}).`);
		return true;
	};

	// Project hooks and MCP servers only run once trusted in the interface: nobody can say yes here.
	const projectHooks = config.hooks.filter((h) => h.source === 'project');
	const hooksTrusted = projectHooks.length > 0 && isTrusted(cwd, projectHooks);
	const hooks = hooksTrusted ? config.hooks : config.hooks.filter((h) => h.source === 'user');
	if (projectHooks.length && !hooksTrusted) say("jane: this project's hooks aren't trusted yet, so they don't run. Allow them once in the interface.");
	const hookRuns = async (event: HookEvent, payload: HookPayload, options: { stopOnBlock?: boolean } = {}) => {
		if (!hooks.some((h) => h.event === event)) return [];
		const runs = await runHooks(hooks, event, payload, { cwd, sessionId: session.id }, options);
		for (const run of runs) {
			const problem = hookProblem(run);
			if (problem) say(`jane: ${problem}`);
		}
		return runs;
	};
	const toolPayload = (call: { name: string; args: Record<string, unknown> }): HookPayload => {
		const file = typeof call.args['path'] === 'string' && ['read', 'write', 'edit'].includes(call.name) ? resolvePath(cwd, call.args['path']) : undefined;
		return { tool: call.name, args: call.args, file };
	};
	agent.hooks = {
		async before(call) {
			const blocked = (await hookRuns('before_tool', toolPayload(call), { stopOnBlock: true })).find((r) => r.exitCode === 2);
			return blocked ? blockMessage(blocked) : undefined;
		},
		async after(call) {
			const runs = await hookRuns('after_tool', { ...toolPayload(call), result: { output: call.result.output, isError: Boolean(call.result.isError) } });
			const messages = runs.filter((r) => r.exitCode === 2).map((r) => blockMessage(r));
			return messages.length ? messages.join('\n\n') : undefined;
		},
	};

	const user = Object.fromEntries(Object.entries(config.mcp).filter(([, s]) => s.source === 'user'));
	const project = Object.fromEntries(Object.entries(config.mcp).filter(([, s]) => s.source === 'project'));
	const mcpTrusted = Object.keys(project).length > 0 && isTrustedPrint(cwd, 'mcp', mcpFingerprint(project));
	if (Object.keys(project).length && !mcpTrusted) say("jane: this project's MCP servers aren't trusted yet, so they're not started. Allow them once in the interface.");
	const servers = mcpTrusted ? { ...user, ...project } : user;
	const mcp = Object.keys(servers).length ? new McpManager(servers, cwd) : undefined;
	if (mcp) {
		await mcp.connectAll();
		for (const [name, status] of mcp.status) if (status.state === 'failed') say(`jane: MCP server "${name}" isn't available: ${status.reason}`);
	}

	// Helpers run in the foreground: the process ends with the turn, so nothing could pick up a background report.
	const helpers = new Helpers(
		hosts,
		() => agent,
		(h) => systemPrompt(cwd, instructions, [hostsPromptSection(hosts, h), ...(listed ? [listed] : []), HELPER_INSTRUCTIONS], base.text),
		{
			changed: () => {},
			finished: (helper) => {
				if (helper.background) agent.helperReports.push(reportText(helper));
			},
			askPermission: async () => ({ kind: 'no', feedback: 'Nobody can answer permission questions in print mode (jane -p).' }),
			notice: (text) => say(`jane: ${text}`),
		},
	);
	agent.tools = [
		...baseTools,
		foregroundOnly(makeAgentTool(helpers)),
		...webTools(config.web),
		...(found.skills.some((s) => !s.userOnly) ? [makeSkillTool(() => found.skills)] : []),
		...(mcp?.tools() ?? []),
	];

	const images = imagePathsIn(o.prompt, cwd).filter((file) => {
		try {
			checkImage(file);
			return true;
		} catch (error) {
			say(`jane: ${(error as Error).message}`);
			return false;
		}
	});
	if (images.length && agent.vision === false) {
		say(`jane: the model on ${host.name} can't see images, so ${images.map((f) => path.basename(f)).join(', ')} wasn't sent.`);
		images.length = 0;
	}

	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once('SIGINT', onSigint);

	let answer = '';
	let outcome: TurnOutcome | 'blocked' | 'error' = 'error';
	let error: string | undefined;
	const events: AgentEvents = {
		onReply: ({ content }) => {
			answer = content;
		},
		onToolStart: ({ name, label }) => say(`● ${name}${label ? `(${label.split('\n')[0]!.slice(0, 100)})` : ''}`),
		onToolEnd: ({ result }) => {
			const summary = result.display?.summary ?? (result.isError ? result.output.split('\n')[0] : undefined);
			if (summary) say(`  ⎿ ${result.isError ? 'Error: ' : ''}${summary.slice(0, 160)}`);
		},
		onCompacted: ({ before, after }) => say(`jane: compacted the conversation (${before} → ${after} tokens)`),
		onCleared: ({ before, after }) => say(`jane: cleared old tool output (${before} → ${after} tokens)`),
		onNotice: (text) => say(`jane: ${text}`),
		askPermission: async () => ({ kind: 'no', feedback: 'Nobody can answer permission questions in print mode (jane -p).' }),
	};

	try {
		await hookRuns('session_start', {});
		const runs = await hookRuns('prompt_submit', { prompt: o.prompt }, { stopOnBlock: true });
		const blocked = runs.find((r) => r.exitCode === 2);
		if (blocked) {
			outcome = 'blocked';
			error = `a hook stopped this message from being sent: ${blockMessage(blocked)}`;
		} else {
			for (const r of runs) if (r.exitCode === 0 && r.stdout) agent.hookContext.push(r.stdout);
			outcome = await agent.run(o.prompt, events, controller.signal, images);
			await hookRuns('turn_end', {});
		}
	} catch (e) {
		outcome = 'error';
		error = e instanceof ModelError ? e.message : `unexpected error: ${(e as Error).message}`;
		if (!(e instanceof ModelError)) log('print mode failed', e);
	} finally {
		process.off('SIGINT', onSigint);
		helpers.stopAll();
		await hookRuns('session_end', {}).catch(() => []);
		await mcp?.closeAll();
	}

	const problem =
		error ??
		(outcome === 'too-many-bad-calls'
			? `the model made ${MAX_BAD_CALLS} bad tool calls in a row`
			: outcome === 'step-limit'
				? 'stopped after too many steps in one turn'
				: outcome === 'interrupted'
					? 'interrupted'
					: outcome === 'denied'
						? 'a tool call was refused'
						: undefined);
	const started = agent.messages.length > 0;
	if (o.json) {
		out(JSON.stringify({ result: answer, outcome, error: problem, session_id: started ? session.id : undefined, tokens: agent.contextTokens() }) + '\n');
	} else {
		if (answer.trim()) out(answer.trimEnd() + '\n');
		if (problem) say(`jane: ${problem}`);
		if (started) say(`jane: session ${session.id} (continue with: jane -p -r ${session.id} "...")`);
	}
	return outcome === 'done' ? 0 : outcome === 'error' ? 1 : 2;
}

/** The helper tool without background mode. */
function foregroundOnly(tool: Tool<any>): Tool<any> {
	const { background: _, ...params } = tool.params;
	return {
		...tool,
		description: tool.description.replace(/ Set background to true[^.]*\./, ''),
		params,
		run: (args, ctx) => tool.run({ ...args, background: false }, ctx),
	};
}
