import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/client.js';
import {
	CLEARED_OUTPUT,
	KEPT_LINE,
	SUMMARY_MARKER,
	clearToolOutputs,
	fittingTranscript,
	isContextOverflow,
	isSummary,
	keptStart,
	oldToolOutputs,
	summaryMessage,
	summaryRequest,
	summaryText,
	touchedFiles,
	transcript,
} from '../src/compact.js';

const conversation: ChatMessage[] = [
	{ role: 'user', content: 'Fix the bug' },
	{ role: 'assistant', content: 'Looking.', tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
	{ role: 'tool', tool_call_id: '1', content: 'y'.repeat(3000) },
	{ role: 'assistant', content: 'Fixed.' },
];

describe('compaction helpers', () => {
	it('keeps the end of long output, where results often are', () => {
		const output = 'start\n' + 'middle\n'.repeat(500) + 'the secret word is mango';
		const text = transcript([{ role: 'tool', tool_call_id: '1', content: output }], 200);
		expect(text).toMatch(/^Result: start\n/);
		expect(text).toMatch(/the secret word is mango$/);
	});

	it('writes the conversation as a plain transcript, shortening long output', () => {
		const text = transcript(conversation, 100);
		expect(text).toBe(
			`User: Fix the bug\n\nJane: Looking.\n\nJane used read: {"path":"a.ts"}\n\nResult: ${'y'.repeat(60)} […2900 characters cut…] ${'y'.repeat(40)}\n\nJane: Fixed.`,
		);
	});

	it('shows an earlier summary as a summary, not as the user talking', () => {
		const text = transcript([summaryMessage('Earlier work.'), { role: 'user', content: 'Next' }], 100);
		expect(text).toBe('[Summary of earlier conversation]\nEarlier work.\n\nUser: Next');
	});

	it('makes the transcript fit: shorter output first, then drop the oldest part', () => {
		expect(fittingTranscript(conversation, 10_000)).toContain('y'.repeat(1200));
		expect(fittingTranscript(conversation, 400)).toContain(`${'y'.repeat(300)} […`);
		const long: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `message ${i} ${'z'.repeat(200)}` }));
		const fitted = fittingTranscript(long, 1000);
		expect(fitted.startsWith('[… the start of the conversation was cut to fit …]')).toBe(true);
		expect(fitted).toContain('message 199');
		expect(fitted).not.toContain('message 0 ');
	});

	it('asks for a structured summary, with an optional focus', () => {
		const request = summaryRequest('User: hi');
		expect(request).toContain('<conversation>\nUser: hi\n</conversation>');
		expect(request).toContain('## Current task');
		expect(request).toContain('## Next step');
		expect(request).not.toContain('focus on');
		expect(request).not.toContain('Summarise the conversation above the line');
		expect(summaryRequest(`User: old\n\n${KEPT_LINE}\n\nUser: new`)).toContain(`Summarise the conversation above the line "${KEPT_LINE}"`);
		expect(summaryRequest('x', '  the API errors ')).toMatch(/focus on: the API errors$/);
	});

	it('recognises summary messages and context overflow errors', () => {
		expect(isSummary(summaryMessage('s'))).toBe(true);
		expect(summaryMessage('  s \n').content).toBe(`${SUMMARY_MARKER}\n\ns\n\n[End of summary]\n\n${summaryMessage('').content.split('\n\n').at(-1)}`);
		expect(summaryText(summaryMessage(' the summary ', { request: 'do it', files: ['a.ts'], continueTask: true }))).toBe('the summary');
		// Summaries saved before "[End of summary]" existed.
		expect(summaryText({ role: 'user', content: `${SUMMARY_MARKER}\n\nold one\n\n[If you need a detail that is not in this summary (exact file contents, values, output), look it up again with your tools instead of guessing.]` })).toBe('old one');
		expect(isSummary({ role: 'user', content: 'hello' })).toBe(false);
		expect(isContextOverflow('model server returned 400: the request exceeds the available context size, try increasing it')).toBe(true);
		expect(isContextOverflow("This model's maximum context length is 8192 tokens")).toBe(true);
		expect(isContextOverflow('model server returned 500: boom')).toBe(false);
	});

	it('keeps the newest messages that fit, never starting at a tool result or at the very first message', () => {
		const m = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });
		const tool = (content: string): ChatMessage => ({ role: 'tool', tool_call_id: 't', content });
		const msgs = [m('user', 'a'.repeat(400)), m('assistant', 'b'.repeat(400)), m('user', 'c'.repeat(40)), m('assistant', ''), tool('d'.repeat(40))];
		expect(keptStart(msgs, 100)).toBe(2); // 120 chars fit, the 400-char reply doesn't
		expect(keptStart(msgs, 1000)).toBe(1); // everything fits, but something must be summarised
		expect(keptStart(msgs, 5)).toBe(5); // only the tool result would fit: keep nothing
	});

	it('finds old long tool output to clear, leaving recent and unseen output alone', () => {
		const call = (id: string, file: string): ChatMessage => ({
			role: 'assistant',
			content: null,
			tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }],
		});
		const msgs: ChatMessage[] = [
			{ role: 'user', content: 'go' },
			call('1', 'a.ts'),
			{ role: 'tool', tool_call_id: '1', content: 'x'.repeat(2000) },
			call('2', 'b.ts'),
			{ role: 'tool', tool_call_id: '2', content: 'short' },
			call('3', 'a.ts'),
			{ role: 'tool', tool_call_id: '3', content: 'y'.repeat(2000) },
		];
		expect(oldToolOutputs(msgs, 10)).toEqual([2]); // 6 is unseen, 4 is too short
		expect(oldToolOutputs(msgs, 2000)).toEqual([]);
		clearToolOutputs(msgs, [2]);
		expect(msgs[2]!.content).toBe(CLEARED_OUTPUT);
		expect(oldToolOutputs(msgs, 10)).toEqual([]);
		expect(touchedFiles(msgs)).toEqual(['a.ts', 'b.ts']);
	});
});
