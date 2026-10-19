// Compaction: make a long conversation fit in the context window again.
//
// Two steps, cheapest first:
// 1. Clear old tool output (file contents, command output). The calls stay, so
//    the model still knows what it did and can run them again.
// 2. If that isn't enough, summarise the older part of the conversation and keep
//    the most recent messages word for word, so Jane can carry on mid-task.

import type { ChatMessage } from './client.js';

/** Start of the user message that carries a summary. Used to recognise it later. */
export const SUMMARY_MARKER = '[Note from Jane: this conversation was compacted to save space. Summary of everything before this point:]';

const SUMMARY_END = '[End of summary]';

const SUMMARY_FOOTER =
	'[If you need a detail that is not in this summary (exact file contents, values, output), look it up again with your tools instead of guessing.]';

const CONTINUE_NOTE =
	'[Jane was in the middle of this task when the conversation was compacted. Carry on from where you stopped. ' +
	"Don't start over and don't ask the user to repeat anything.]";

/** What replaces a tool result that was cleared to save space. */
export const CLEARED_OUTPUT = '[Old tool output cleared to save space. Run the tool again if you need it.]';

/** Tool output shorter than this isn't worth clearing. */
const MIN_CLEAR_CHARS = 400;

/** Tools whose `path` argument is a file Jane read or changed. */
const FILE_TOOLS = new Set(['read', 'write', 'edit']);

export type SummaryExtras = {
	/** The user's latest request, word for word, when it isn't among the messages that are kept. */
	request?: string;
	/** Files Jane read or changed in the part that was summarised. */
	files?: string[];
	/** Jane was in the middle of a task: tell her to carry on. */
	continueTask?: boolean;
};

export function summaryMessage(summary: string, extras: SummaryExtras = {}): ChatMessage {
	const parts = [SUMMARY_MARKER, summary.trim(), SUMMARY_END];
	if (extras.files?.length) parts.push(`[Files Jane read or changed before this point: ${extras.files.join(', ')}]`);
	if (extras.request?.trim()) {
		parts.push(`[The user's latest request, word for word:]\n${extras.request.trim()}\n[End of the user's latest request]`);
	}
	parts.push(SUMMARY_FOOTER);
	if (extras.continueTask) parts.push(CONTINUE_NOTE);
	return { role: 'user', content: parts.join('\n\n') };
}

/** The summary text of a summary message, without Jane's notes around it. */
export function summaryText(message: ChatMessage): string {
	const text = (message.content ?? '').slice(SUMMARY_MARKER.length);
	const end = text.lastIndexOf(SUMMARY_END);
	// Summaries from before SUMMARY_END existed end with the footer.
	return (end >= 0 ? text.slice(0, end) : text.replace(SUMMARY_FOOTER, '')).trim();
}

export function isSummary(message: ChatMessage): boolean {
	return message.role === 'user' && message.content.startsWith(SUMMARY_MARKER);
}

export const SUMMARY_SYSTEM =
	'You write summaries of coding sessions between a user and Jane, a coding agent. ' +
	'The summary replaces the conversation, so Jane can carry on from it without the original messages.';

/** The line in the transcript above which everything is summarised; below it, messages are kept. */
export const KEPT_LINE = '----- Everything below this line stays in the conversation word for word -----';

export function summaryRequest(transcript: string, focus?: string): string {
	const keeps = transcript.includes(KEPT_LINE);
	return [
		'Here is the conversation so far:',
		'',
		'<conversation>',
		transcript,
		'</conversation>',
		'',
		keeps
			? `Summarise the conversation above the line "${KEPT_LINE}". ` +
				"The messages below that line stay as they are, so don't repeat them in detail, but do use them to describe the current task and next step. "
			: '',
		'Write a summary that lets Jane carry on exactly where she left off. Use these headings:',
		'',
		"## Current task: the user's most recent request, quoted word for word, and what finishing it looks like. If the user changed or replaced an earlier request, say so.",
		'## Progress on the current task: what is done, what is left, and exactly where Jane stopped (the last step, file or error)',
		'## Next step: the very next thing Jane should do. If the task is finished and Jane is waiting for the user, say that instead.',
		"## User's messages: every message the user sent, in order, briefly, quoting the parts that matter. Mark each one [done], [open] or [replaced by a later message].",
		'## Files: every file read, created or changed: its path, what it is for and what was changed. Include short code snippets the next steps need.',
		'## Errors and fixes: errors that came up (quote the exact message), how they were fixed, and anything the user corrected',
		"## Key facts: commands, names, settings, values, decisions and the user's preferences that will be needed later",
		'',
		"If the conversation starts with an earlier summary, carry over everything from it that still matters. Don't drop details just because they are old.",
		'Be specific and complete, but leave out chit-chat and tool output that no longer matters. Aim for 800 to 1500 words.',
		...(focus?.trim() ? ['', `The user asked the summary to focus on: ${focus.trim()}`] : []),
	]
		.filter((line, i, all) => line !== '' || all[i - 1] !== '')
		.join('\n');
}

/** Shorten from the middle: the start and the end of output usually matter most. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6);
	const tail = max - head;
	return `${text.slice(0, head)} […${text.length - max} characters cut…] ${text.slice(text.length - tail)}`;
}

/**
 * The conversation as plain text. Plain text, not chat messages, so any chat
 * template accepts it and shortened tool calls don't have to stay valid JSON.
 * With `keepFrom`, a line marks where the messages that are kept begin.
 */
export function transcript(messages: ChatMessage[], maxResult: number, keepFrom?: number): string {
	const parts: string[] = [];
	messages.forEach((m, i) => {
		if (i === keepFrom) parts.push(KEPT_LINE);
		if (m.role === 'user') {
			parts.push(isSummary(m) ? `[Summary of earlier conversation]\n${summaryText(m)}` : `User: ${m.content}`);
		} else if (m.role === 'assistant') {
			if (m.content?.trim()) parts.push(`Jane: ${m.content}`);
			for (const call of m.tool_calls ?? []) parts.push(`Jane used ${call.function.name}: ${cut(call.function.arguments, maxResult)}`);
		} else if (m.role === 'tool') {
			parts.push(`Result: ${cut(m.content, maxResult)}`);
		}
	});
	return parts.join('\n\n');
}

/**
 * A transcript that fits in about `budgetTokens`: first shorten tool output,
 * then drop the oldest part (the start of the conversation matters least).
 */
export function fittingTranscript(messages: ChatMessage[], budgetTokens: number, keepFrom?: number): string {
	const budgetChars = Math.max(2000, budgetTokens * 3); // ~3 characters per token, on the safe side
	for (const maxResult of [2000, 500, 150]) {
		const text = transcript(messages, maxResult, keepFrom);
		if (text.length <= budgetChars) return text;
	}
	const text = transcript(messages, 150, keepFrom);
	return `[… the start of the conversation was cut to fit …]\n\n${text.slice(text.length - budgetChars)}`;
}

function size(m: ChatMessage): number {
	let chars = (m.content ?? '').length;
	if (m.role === 'assistant') for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + 20;
	return chars;
}

/**
 * Where the kept part of the conversation starts: as many of the newest
 * messages as fit in `keepTokens`, starting at a user or assistant message (a
 * tool result can't come without its call). Never 0, so something is always
 * summarised; `messages.length` means nothing is kept.
 */
export function keptStart(messages: ChatMessage[], keepTokens: number): number {
	let start = messages.length;
	let chars = 0;
	for (let i = messages.length - 1; i >= 1; i--) {
		chars += size(messages[i]!);
		if (chars > keepTokens * 4) break;
		if (messages[i]!.role !== 'tool') start = i;
	}
	return start;
}

/**
 * Positions of long tool results older than the newest `keepTokens` worth of
 * messages. Results the model hasn't replied to yet are never cleared.
 */
export function oldToolOutputs(messages: ChatMessage[], keepTokens: number): number[] {
	const found: number[] = [];
	const lastReply = messages.findLastIndex((m) => m.role === 'assistant');
	let chars = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		chars += size(m);
		if (i > lastReply || chars <= keepTokens * 4 || m.role !== 'tool') continue;
		if (m.content.length >= MIN_CLEAR_CHARS && m.content !== CLEARED_OUTPUT) found.push(i);
	}
	return found.reverse();
}

/** Replace the tool results at these positions with a short note. */
export function clearToolOutputs(messages: ChatMessage[], positions: number[]): void {
	for (const i of positions) {
		const m = messages[i];
		if (m?.role === 'tool') messages[i] = { ...m, content: CLEARED_OUTPUT };
	}
}

/** Files Jane read or changed, most recent first. */
export function touchedFiles(messages: ChatMessage[], max = 15): string[] {
	const files: string[] = [];
	for (let i = messages.length - 1; i >= 0 && files.length < max; i--) {
		const m = messages[i]!;
		if (m.role !== 'assistant') continue;
		for (const call of [...(m.tool_calls ?? [])].reverse()) {
			if (!FILE_TOOLS.has(call.function.name)) continue;
			try {
				const file = (JSON.parse(call.function.arguments) as { path?: unknown }).path;
				if (typeof file === 'string' && file && !files.includes(file)) files.push(file);
			} catch {
				// Arguments that weren't valid JSON; that call failed anyway.
			}
		}
	}
	return files.slice(0, max);
}

/** Does this model server error mean the request didn't fit in the context? */
export function isContextOverflow(message: string): boolean {
	return /exceeds? the (available )?context|context (size|length|window)|too many tokens|maximum context|n_ctx/i.test(message);
}
