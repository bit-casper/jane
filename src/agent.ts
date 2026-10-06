import { type ChatMessage, ModelError, type StreamResult, type ToolCall, streamChat } from './client.js';
import { SUMMARY_SYSTEM, fittingTranscript, isContextOverflow, summaryMessage, summaryRequest } from './compact.js';
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
	/** Jane is about to compact the conversation (the model is writing a summary). */
	onCompacting?(info: { auto: boolean }): void;
	onCompacted?(info: { before: number; after: number; auto: boolean }): void;
	/** Something worth telling the user that isn't part of the conversation. */
	onNotice?(text: string, tone: 'info' | 'warning' | 'error'): void;
	askPermission(request: PermissionRequest): Promise<PermissionDecision>;
};

export type TurnOutcome = 'done' | 'interrupted' | 'denied' | 'too-many-bad-calls' | 'step-limit';

export type ModelSettings = { baseUrl: string; apiKey?: string; model: string };

/** Rough token count for when the server hasn't told us yet. Includes the tool definitions. */
export function estimateTokens(messages: ChatMessage[], toolList: Tool<any>[] = tools): number {
	return Math.ceil(JSON.stringify(toolSchemas(toolList)).length / 4) + estimateMessages(messages);
}

function estimateMessages(messages: ChatMessage[]): number {
	let chars = 0;
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
	/** How many tokens the model can hold. */
	contextWindow = 65536;
	/** Compact automatically when the context is fuller than this percentage (0 turns it off). */
	autoCompactPercent = 80;
	/** Tokens in use according to the server's last reply, and how many messages that covered. */
	private usage = { tokens: 0, messages: 0 };

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

	/** Tokens the next request will use, about: the server's last count plus an estimate for what came after. */
	contextTokens(): number {
		if (this.usage.messages > this.messages.length) this.usage = { tokens: 0, messages: 0 };
		const base = this.usage.tokens || estimateTokens([], this.tools) + Math.ceil(this.system.length / 4);
		return base + estimateMessages(this.messages.slice(this.usage.messages));
	}

	private needsCompacting(extra = 0): boolean {
		return this.autoCompactPercent > 0 && this.messages.length > 1 && this.contextTokens() + extra > (this.contextWindow * this.autoCompactPercent) / 100;
	}

	/**
	 * Replace the conversation with a summary written by the model. On failure
	 * (or Esc) the conversation is left as it was.
	 */
	async compact(events: AgentEvents, signal: AbortSignal, options: { focus?: string; auto?: boolean } = {}): Promise<{ before: number; after: number }> {
		if (this.messages.length === 0) throw new ModelError('there is nothing to compact yet');
		const auto = Boolean(options.auto);
		const before = this.contextTokens();
		events.onCompacting?.({ auto });
		// Leave room for the instructions, the model's thinking and the summary itself.
		const budget = Math.max(2000, this.contextWindow - 12000);
		const reply = await streamChat({
			baseUrl: this.settings.baseUrl,
			apiKey: this.settings.apiKey,
			model: this.settings.model,
			messages: [
				{ role: 'system', content: SUMMARY_SYSTEM },
				{ role: 'user', content: summaryRequest(fittingTranscript(this.messages, budget), options.focus) },
			],
			tools: [],
			signal,
		});
		const summary = reply.content.trim();
		if (!summary) throw new ModelError('the model returned an empty summary, so nothing was compacted');
		this.session.addCompaction(before);
		this.messages.splice(0);
		this.push(summaryMessage(summary));
		this.usage = { tokens: 0, messages: 0 };
		const after = this.contextTokens();
		events.onCompacted?.({ before, after, auto });
		events.onUsage?.(after);
		return { before, after };
	}

	/** Compact automatically; if that fails, say so and carry on with the full conversation. */
	private async autoCompact(events: AgentEvents, signal: AbortSignal): Promise<void> {
		try {
			await this.compact(events, signal, { auto: true });
		} catch (error) {
			if (signal.aborted) return;
			events.onNotice?.(`Couldn't compact the conversation: ${(error as Error).message}`, 'warning');
		}
	}

	/** Run one user turn: the model replies, uses tools, and repeats until it's done. */
	async run(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnOutcome> {
		this.currentPrompt = prompt;
		const notes = this.notes.splice(0);
		const content = notes.length ? `${notes.map((n) => `[Note from Jane: ${n}]`).join('\n')}\n\n${prompt}` : prompt;
		// Compact before adding the new prompt, so the prompt itself stays word for word.
		if (this.needsCompacting(Math.ceil(content.length / 4))) {
			await this.autoCompact(events, signal);
			if (signal.aborted) return 'interrupted';
		}
		this.push({ role: 'user', content });
		let badCalls = 0;
		let overflowRetried = false;

		for (let step = 0; step < MAX_STEPS; step++) {
			if (step > 0 && this.needsCompacting()) {
				await this.autoCompact(events, signal);
				if (signal.aborted) return 'interrupted';
			}
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
				// The conversation didn't fit: compact and try once more.
				if (error instanceof ModelError && isContextOverflow(error.message) && !overflowRetried && this.messages.length > 1) {
					overflowRetried = true;
					events.onNotice?.('The conversation no longer fits in the context window, so Jane is compacting it.', 'warning');
					await this.compact(events, signal, { auto: true });
					step--;
					continue;
				}
				throw error;
			}

			events.onReply?.({ content: reply.content, reasoning: reply.reasoning });
			this.push({
				role: 'assistant',
				content: reply.content || null,
				...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
			});
			if (reply.usage) this.usage = { tokens: reply.usage.prompt_tokens + reply.usage.completion_tokens, messages: this.messages.length };
			events.onUsage?.(this.contextTokens());
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
