// Compaction: replace a long conversation with a summary, so it fits in the context window.

import type { ChatMessage } from './client.js';

/** Start of the user message that carries a summary. Used to recognise it later. */
export const SUMMARY_MARKER = '[Note from Jane: this conversation was compacted to save space. Summary of everything before this point:]';

const SUMMARY_FOOTER =
	'[If you need a detail that is not in this summary (exact file contents, values, output), look it up again with your tools instead of guessing.]';

export function summaryMessage(summary: string): ChatMessage {
	return { role: 'user', content: `${SUMMARY_MARKER}\n\n${summary.trim()}\n\n${SUMMARY_FOOTER}` };
}

/** The summary text of a summary message, without Jane's notes around it. */
export function summaryText(message: ChatMessage): string {
	return (message.content ?? '').slice(SUMMARY_MARKER.length).replace(SUMMARY_FOOTER, '').trim();
}

export function isSummary(message: ChatMessage): boolean {
	return message.role === 'user' && message.content.startsWith(SUMMARY_MARKER);
}

export const SUMMARY_SYSTEM =
	'You write summaries of coding sessions between a user and Jane, a coding agent. ' +
	'The summary replaces the conversation, so Jane can carry on from it without the original messages.';

export function summaryRequest(transcript: string, focus?: string): string {
	return [
		'Here is the conversation so far:',
		'',
		'<conversation>',
		transcript,
		'</conversation>',
		'',
		'Write a summary that lets Jane continue the work exactly where it left off. Use these headings:',
		'',
		"## User's requests: what the user asked for, in their own words where it matters, including preferences and corrections",
		'## Work done: what was changed, file by file (paths), and what was checked or tested',
		'## Current state: what is working, what is not, open errors (quote exact error messages)',
		'## In progress: what Jane was doing right before this summary, and the next steps',
		'## Key facts: paths, commands, names, settings and decisions that will be needed later, and any specific values found in files or tool output that the task needs (exact names, numbers, words)',
		'',
		'Be specific and complete, but leave out chit-chat and tool output that no longer matters. Aim for under 800 words.',
		...(focus?.trim() ? ['', `The user asked the summary to focus on: ${focus.trim()}`] : []),
	].join('\n');
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
 */
export function transcript(messages: ChatMessage[], maxResult: number): string {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			parts.push(isSummary(m) ? `[Summary of earlier conversation]\n${summaryText(m)}` : `User: ${m.content}`);
		} else if (m.role === 'assistant') {
			if (m.content?.trim()) parts.push(`Jane: ${m.content}`);
			for (const call of m.tool_calls ?? []) parts.push(`Jane used ${call.function.name}: ${cut(call.function.arguments, maxResult)}`);
		} else if (m.role === 'tool') {
			parts.push(`Result: ${cut(m.content, maxResult)}`);
		}
	}
	return parts.join('\n\n');
}

/**
 * A transcript that fits in about `budgetTokens`: first shorten tool output,
 * then drop the oldest part (the start of the conversation matters least).
 */
export function fittingTranscript(messages: ChatMessage[], budgetTokens: number): string {
	const budgetChars = Math.max(2000, budgetTokens * 3); // ~3 characters per token, on the safe side
	for (const maxResult of [2000, 500, 150]) {
		const text = transcript(messages, maxResult);
		if (text.length <= budgetChars) return text;
	}
	const text = transcript(messages, 150);
	return `[… the start of the conversation was cut to fit …]\n\n${text.slice(text.length - budgetChars)}`;
}

/** Does this model server error mean the request didn't fit in the context? */
export function isContextOverflow(message: string): boolean {
	return /exceeds? the (available )?context|context (size|length|window)|too many tokens|maximum context|n_ctx/i.test(message);
}
