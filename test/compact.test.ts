import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/client.js';
import { SUMMARY_MARKER, fittingTranscript, summaryText, isContextOverflow, isSummary, summaryMessage, summaryRequest, transcript } from '../src/compact.js';

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
		expect(request).toContain('## In progress');
		expect(request).not.toContain('focus on');
		expect(summaryRequest('x', '  the API errors ')).toMatch(/focus on: the API errors$/);
	});

	it('recognises summary messages and context overflow errors', () => {
		expect(isSummary(summaryMessage('s'))).toBe(true);
		expect(summaryMessage('  s \n').content).toMatch(new RegExp(`^\\${SUMMARY_MARKER.slice(0, -1)}\\]\\n\\ns\\n\\n\\[If you need a detail`));
		expect(summaryText(summaryMessage(' the summary '))).toBe('the summary');
		expect(isSummary({ role: 'user', content: 'hello' })).toBe(false);
		expect(isContextOverflow('model server returned 400: the request exceeds the available context size, try increasing it')).toBe(true);
		expect(isContextOverflow("This model's maximum context length is 8192 tokens")).toBe(true);
		expect(isContextOverflow('model server returned 500: boom')).toBe(false);
	});
});
