import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { paint } from './theme.js';

const cache = new Map<string, Marked>();

function renderer(color: string, accent: string, width: number): Marked {
	const key = `${color}|${accent}|${width}`;
	let marked = cache.get(key);
	if (!marked) {
		const base = paint(color);
		const accentFn = paint(accent);
		marked = new Marked(
			markedTerminal({
				text: base,
				paragraph: base,
				listitem: base,
				strong: base.bold,
				em: base.italic,
				heading: accentFn.bold,
				firstHeading: accentFn.bold,
				code: chalk.yellow,
				codespan: chalk.yellow,
				link: accentFn,
				href: accentFn.underline,
				showSectionPrefix: false,
				reflowText: true,
				width,
				tab: 2,
			}) as never,
		);
		// Keep single line breaks: in a terminal, a line break the model wrote is meant (poems, lists of lines, addresses).
		marked.use({ breaks: true });
		// Text in list items can still hold **bold**, `code` and links; marked-terminal prints it as is.
		// Render those parts too, and leave plain text to marked-terminal (returning false falls back to it).
		marked.use({
			renderer: {
				text(token) {
					return 'tokens' in token && token.tokens?.length ? this.parser.parseInline(token.tokens) : false;
				},
			},
		});
		cache.set(key, marked);
	}
	return marked;
}

/** Render Markdown to ANSI text for the terminal. Falls back to plain text. */
export function renderMarkdown(text: string, color: string, accent: string, width: number): string {
	try {
		const out = renderer(color, accent, Math.max(20, width)).parse(text, { async: false }) as string;
		return out.replace(/\n+$/, '');
	} catch {
		return paint(color)(text);
	}
}
