import stringWidth from 'string-width';

/** How many terminal rows a line takes when it wraps at `width` columns. */
export function rowsFor(line: string, width: number): number {
	return Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, width)));
}

/**
 * The end of `text` that fits in `maxRows` terminal rows at `width` columns,
 * counting wrapped lines. Used for the live (redrawn) part of the screen: if
 * it were taller than the terminal, redrawing would leave copies in the
 * scrollback.
 */
export function fitToRows(text: string, width: number, maxRows: number): string {
	const lines = text.split('\n');
	const kept: string[] = [];
	let rows = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const need = rowsFor(line, width);
		if (rows + need > maxRows) {
			// Nothing fits yet: keep the end of this one line.
			if (kept.length === 0) kept.unshift(tail(line, width * maxRows));
			break;
		}
		kept.unshift(line);
		rows += need;
	}
	return kept.join('\n');
}

/** The last characters of a line that fit in `columns`, skipping ANSI codes when counting. */
function tail(line: string, columns: number): string {
	let out = '';
	for (const char of [...line].reverse()) {
		if (stringWidth(char + out) > columns) break;
		out = char + out;
	}
	return out;
}
