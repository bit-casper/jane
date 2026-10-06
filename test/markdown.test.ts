import { describe, expect, it } from 'vitest';

// Colours are off when output isn't a terminal (as in tests); turn them on to see the styling.
process.env['FORCE_COLOR'] = '1';
const { renderMarkdown } = await import('../src/ui/markdown.js');

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('rendering replies', () => {
	it('formats bold, italic, code and links inside list items, not only in paragraphs', () => {
		const out = renderMarkdown('* **J** **a** bouncing\n* with `code` and [a link](https://x.y)', 'white', 'magenta', 80);
		expect(plain(out)).toBe('  * J a bouncing\n  * with code and a link (https://x.y)');
		expect(out).toMatch(/\x1b\[1m(\x1b\[[0-9;]*m)*J/); // J is bold
	});

	it('does the same in numbered and nested lists', () => {
		expect(plain(renderMarkdown('1. **First** item\n2. second', 'white', 'magenta', 80))).toBe('  1. First item\n  2. second');
		expect(plain(renderMarkdown('- nested\n  - **inner** item', 'white', 'magenta', 80))).toBe('  * nested\n    * inner item');
	});

	it('still renders plain paragraphs and text as before', () => {
		expect(plain(renderMarkdown('Plain **bold** and *italic*', 'white', 'magenta', 80))).toBe('Plain bold and italic');
		expect(plain(renderMarkdown('just text', 'white', 'magenta', 80))).toBe('just text');
	});
});
