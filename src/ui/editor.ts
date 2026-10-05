// Pure text-editing helpers for the prompt input, kept separate so they're easy to test.

export type EditorState = { text: string; cursor: number };

export const empty: EditorState = { text: '', cursor: 0 };

export function insert(s: EditorState, chunk: string): EditorState {
	const clean = chunk.replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
	return { text: s.text.slice(0, s.cursor) + clean + s.text.slice(s.cursor), cursor: s.cursor + clean.length };
}

export function backspace(s: EditorState): EditorState {
	if (s.cursor === 0) return s;
	return { text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1 };
}

export function deleteForward(s: EditorState): EditorState {
	if (s.cursor >= s.text.length) return s;
	return { text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), cursor: s.cursor };
}

export function deleteWordBack(s: EditorState): EditorState {
	const before = s.text.slice(0, s.cursor);
	const start = before.replace(/\S+\s*$|\s+$/, '').length;
	return { text: s.text.slice(0, start) + s.text.slice(s.cursor), cursor: start };
}

function lineStart(text: string, cursor: number): number {
	return text.lastIndexOf('\n', cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
	const i = text.indexOf('\n', cursor);
	return i === -1 ? text.length : i;
}

export function home(s: EditorState): EditorState {
	return { ...s, cursor: lineStart(s.text, s.cursor) };
}

export function end(s: EditorState): EditorState {
	return { ...s, cursor: lineEnd(s.text, s.cursor) };
}

export function killToLineStart(s: EditorState): EditorState {
	const start = lineStart(s.text, s.cursor);
	return { text: s.text.slice(0, start) + s.text.slice(s.cursor), cursor: start };
}

export function killToLineEnd(s: EditorState): EditorState {
	const stop = lineEnd(s.text, s.cursor);
	return { text: s.text.slice(0, s.cursor) + s.text.slice(stop), cursor: s.cursor };
}

export function left(s: EditorState): EditorState {
	return { ...s, cursor: Math.max(0, s.cursor - 1) };
}

export function right(s: EditorState): EditorState {
	return { ...s, cursor: Math.min(s.text.length, s.cursor + 1) };
}

export function isOnFirstLine(s: EditorState): boolean {
	return !s.text.slice(0, s.cursor).includes('\n');
}

export function isOnLastLine(s: EditorState): boolean {
	return !s.text.slice(s.cursor).includes('\n');
}

/** Move the cursor up or down one line, keeping the column where possible. */
export function vertical(s: EditorState, direction: -1 | 1): EditorState {
	const start = lineStart(s.text, s.cursor);
	const column = s.cursor - start;
	if (direction === -1) {
		if (start === 0) return s;
		const prevStart = lineStart(s.text, start - 1);
		return { ...s, cursor: Math.min(prevStart + column, start - 1) };
	}
	const stop = lineEnd(s.text, s.cursor);
	if (stop === s.text.length) return s;
	const nextStart = stop + 1;
	return { ...s, cursor: Math.min(nextStart + column, lineEnd(s.text, nextStart)) };
}
