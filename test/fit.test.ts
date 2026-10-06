import { describe, expect, it } from 'vitest';
import { fitToRows, rowsFor } from '../src/ui/fit.js';

describe('fitting the live reply to the screen', () => {
	it('counts wrapped lines as the rows they take', () => {
		expect(rowsFor('', 10)).toBe(1);
		expect(rowsFor('a'.repeat(10), 10)).toBe(1);
		expect(rowsFor('a'.repeat(11), 10)).toBe(2);
		expect(rowsFor('\x1b[31m' + 'a'.repeat(10) + '\x1b[39m', 10)).toBe(1); // colour codes take no space
		expect(rowsFor('漢字漢字漢字', 10)).toBe(2); // wide characters take two columns
	});

	it('keeps the end that fits, counting wrapped rows rather than lines', () => {
		const text = ['first', 'b'.repeat(25), 'third', 'last'].join('\n');
		// At width 10: first=1, b..=3, third=1, last=1 rows.
		expect(fitToRows(text, 10, 6)).toBe(text);
		expect(fitToRows(text, 10, 5)).toBe(['b'.repeat(25), 'third', 'last'].join('\n'));
		expect(fitToRows(text, 10, 4)).toBe(['third', 'last'].join('\n'));
	});

	it('keeps the end of a single line that is too long on its own', () => {
		expect(fitToRows('x'.repeat(50) + 'END', 10, 2)).toBe('x'.repeat(17) + 'END');
	});
});
