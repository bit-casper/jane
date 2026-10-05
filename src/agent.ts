import { type ChatMessage, type StreamResult, type ToolCall, streamChat } from './client.js';
import type { PermissionMode } from './config.js';
import type { Checkpoints } from './checkpoints.js';
import { type BlockRule, blockedBy, describeRule } from './blocklist.js';
import type { Session } from './session.js';
import { findTool, parseArgs, toolSchemas, tools } from './tools/index.js';
import { type Tool, type ToolDisplay, ToolError, type ToolResult } from './tools/types.js';

export const MAX_BAD_CALLS = 3;
const MAX_STEPS = 200;

export type PermissionRequest = { tool: Tool<any>; label: string; preview: ToolDisplay };
export type PermissionDecision = { kind: 'yes' } | { kind: 'always' } | { kind: 'no'; feedback?: string };

export type AgentEvents = {
	onReasoning?(delta: string): void;
	onContent?(delta: string): void;
	/** A model reply finished streaming (it may still have tool calls to run). */
	onReply?(reply: { content: string; reasoning: string }): void;
	onToolStart?(call: { id: string; name: string; label: string }): void;
	onToolEnd?(call: { id: string; name: string; label: string; result: ToolResult }): void;
	onUsage?(tokens: number): void;
	askPermission(request: PermissionRequest): Promise<PermissionDecision>;
};

export type TurnOutcome = 'done' | 'interrupted' | 'denied' | 'too-many-bad-calls' | 'step-limit';

export type ModelSettings = { baseUrl: string; apiKey?: string; model: string };

/** Rough token count for when the server hasn't told us yet. Includes the tool definitions. */
export function estimateTokens(messages: ChatMessage[], toolList: Tool<any>[] = tools): number {
	let chars = JSON.stringify(toolSchemas(toolList)).length;
	for (const m of messages) {
		chars += (m.content ?? '').length;
		if (m.role === 'assistant') for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + 20;
	}
	return Math.ceil(chars / 4);
}

/** A user message without the notes Jane added in front of it. */
export function stripNotes(content: string): string {
	return content.replace(/^(\[Note from Jane: [^\n]*\]\n)+\n/, '');
}

export class Agent {
	/** Tools the user said yes to for the rest of the session. */
	readonly allowedForSession = new Set<string>();
	/** The tools the model can use. */
	tools: Tool<any>[] = tools;
	/** Where file copies are kept for /undo. Undefined turns checkpoints off. */
	checkpoints?: Checkpoints;
	/** Notes for the model, sent with the next user message (e.g. "the user undid these changes"). */
	readonly notes: string[] = [];
	private currentPrompt = '';
	/** Bash commands matching these are refused, whatever the permission mode. */
	blockRules: BlockRule[] = [];

	constructor(
		public settings: ModelSettings,
		public mode: PermissionMode,
		public system: string,
		readonly cwd: string,
		readonly session: Session,
		readonly messages: ChatMessage[] = [],
	) {}

	private push(message: ChatMessage): void {
		this.messages.push(message);
		this.session.addMessage(message);
	}

	/** Run one user turn: the model replies, uses tools, and repeats until it's done. */
	async run(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnOutcome> {
		this.currentPrompt = prompt;
		const notes = this.notes.splice(0);
		this.push({ role: 'user', content: notes.length ? `${notes.map((n) => `[Note from Jane: ${n}]`).join('\n')}\n\n${prompt}` : prompt });
		let badCalls = 0;

		for (let step = 0; step < MAX_STEPS; step++) {
			let reply: StreamResult;
			let content = '';
			try {
				reply = await streamChat({
					baseUrl: this.settings.baseUrl,
					apiKey: this.settings.apiKey,
					model: this.settings.model,
					messages: [{ role: 'system', content: this.system }, ...this.messages],
					tools: toolSchemas(this.tools),
					signal,
					onReasoning: events.onReasoning,
					onContent: (delta) => {
						content += delta;
						events.onContent?.(delta);
					},
				});
			} catch (error) {
				if (signal.aborted) {
					// Keep what the model had written so far.
					if (content.trim()) this.push({ role: 'assistant', content: content + '\n\n[interrupted by the user]' });
					return 'interrupted';
				}
				throw error;
			}

			events.onReply?.({ content: reply.content, reasoning: reply.reasoning });
			if (reply.usage) events.onUsage?.(reply.usage.prompt_tokens + reply.usage.completion_tokens);
			else events.onUsage?.(estimateTokens(this.messages, this.tools) + Math.ceil((this.system.length + reply.content.length) / 4));

			this.push({
				role: 'assistant',
				content: reply.content || null,
				...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
			});
			if (reply.toolCalls.length === 0) return 'done';

			let outcome: TurnOutcome | undefined;
			for (const call of reply.toolCalls) {
				// Every tool call needs an answer, even if we stop early.
				if (outcome || signal.aborted) {
					this.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: the turn was stopped.' });
					continue;
				}
				const result = await this.runCall(call, events, signal);
				if (result.bad) badCalls++;
				else badCalls = 0;
				this.push({ role: 'tool', tool_call_id: call.id, content: result.output });
				if (result.denied) outcome = 'denied';
				else if (badCalls >= MAX_BAD_CALLS) outcome = 'too-many-bad-calls';
			}
			if (signal.aborted) return 'interrupted';
			if (outcome) return outcome;
		}
		return 'step-limit';
	}

	private async runCall(
		call: ToolCall,
		events: AgentEvents,
		signal: AbortSignal,
	): Promise<{ output: string; bad?: boolean; denied?: boolean }> {
		const name = call.function.name;
		const tool = findTool(name, this.tools);
		const finish = (label: string, result: ToolResult) => {
			this.session.addToolDisplay(call.id, label, result);
			events.onToolEnd?.({ id: call.id, name, label, result });
			return result.isError ? `Error: ${result.output}` : result.output;
		};

		if (!tool) {
			const known = this.tools.map((t) => t.name).join(', ');
			events.onToolStart?.({ id: call.id, name: name || '(no name)', label: '' });
			return { output: finish('', { output: `There is no tool called "${name}". The tools are: ${known}.`, isError: true }), bad: true };
		}
		const parsed = parseArgs(tool, call.function.arguments);
		if ('error' in parsed) {
			events.onToolStart?.({ id: call.id, name, label: '' });
			return { output: finish('', { output: parsed.error, isError: true }), bad: true };
		}
		const args = parsed.args;
		const label = tool.label(args, { cwd: this.cwd });
		const ctx = { cwd: this.cwd, signal };

		const rule = tool.name === 'bash' ? blockedBy(String(args['command']), this.blockRules) : undefined;
		if (rule) {
			events.onToolStart?.({ id: call.id, name, label });
			finish(label, { output: '', isError: true, display: { summary: `Blocked by the block list: ${describeRule(rule.pattern)}` } });
			return {
				output:
					`Error: this command was blocked by Jane's block list (${describeRule(rule.pattern)}), so it did not run. ` +
					'Do not try to get around the block list with a different command. If the command is really needed, tell the user and let them run it themselves.',
			};
		}

		if (tool.needsPermission && this.mode === 'always-ask' && !this.allowedForSession.has(tool.name)) {
			let preview: ToolDisplay = {};
			try {
				preview = (await tool.preview?.(args, ctx)) ?? {};
			} catch (error) {
				// The call would fail anyway (e.g. edit text not found): tell the model without asking.
				if (error instanceof ToolError) {
					events.onToolStart?.({ id: call.id, name, label });
					return { output: finish(label, { output: error.message, isError: true }) };
				}
				throw error;
			}
			const decision = await events.askPermission({ tool, label, preview });
			if (signal.aborted) return { output: 'Not run: the turn was stopped.' };
			if (decision.kind === 'no') {
				events.onToolStart?.({ id: call.id, name, label });
				const feedback = decision.feedback?.trim();
				const output = feedback
					? `The user did not allow this. They said: ${feedback}`
					: 'The user did not allow this. Stop and wait for their next message.';
				finish(label, { output: 'Not allowed', isError: true, display: { summary: feedback ? `Not allowed: ${feedback}` : 'Not allowed' } });
				return { output, denied: !feedback };
			}
			if (decision.kind === 'always') this.allowedForSession.add(tool.name);
		}

		events.onToolStart?.({ id: call.id, name, label });
		let checkpoint: number | undefined;
		const files = tool.files?.(args, { cwd: this.cwd });
		if (files?.length && this.checkpoints) {
			try {
				checkpoint = this.checkpoints.capture(files, { tool: name, label, prompt: this.currentPrompt.slice(0, 120) });
			} catch (error) {
				// Rather not change a file we can't undo.
				return { output: finish(label, { output: `Could not save a checkpoint before changing the file: ${(error as Error).message}`, isError: true }) };
			}
		}
		let result: ToolResult;
		try {
			result = await tool.run(args, ctx);
		} catch (error) {
			if (error instanceof ToolError) result = { output: error.message, isError: true };
			else if (signal.aborted) result = { output: 'Interrupted by the user.', isError: true };
			else result = { output: `Unexpected error: ${(error as Error).message}`, isError: true };
		}
		if (checkpoint !== undefined) {
			if (result.isError) this.checkpoints!.discard(checkpoint);
			else this.checkpoints!.commit(checkpoint);
		}
		return { output: finish(label, result) };
	}
}
