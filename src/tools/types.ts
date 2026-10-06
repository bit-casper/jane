import path from 'node:path';
import { structuredPatch } from 'diff';

export type ToolContext = {
	cwd: string;
	signal: AbortSignal;
};

/** One line of a rendered diff. `old`/`new` are line numbers. */
export type DiffLine = { kind: 'add' | 'remove' | 'context' | 'gap'; text: string; old?: number; new?: number };

/** What the UI shows for a tool call, before (permission prompt) or after it runs. */
export type ToolDisplay = {
	/** Extra short text after the tool label, e.g. "Read 120 lines". */
	summary?: string;
	diff?: DiffLine[];
	/** Raw text shown in a box, e.g. a bash command or its output. */
	text?: string;
};

export type ToolResult = {
	/** What the model sees. */
	output: string;
	isError?: boolean;
	display?: ToolDisplay;
};

export type ParamSpec = {
	type: 'string' | 'integer' | 'boolean';
	description: string;
	required?: boolean;
};

export type Tool<Args = Record<string, unknown>> = {
	name: string;
	description: string;
	params: Record<string, ParamSpec>;
	/** A full JSON schema for the arguments, used instead of `params` (MCP tools bring their own). */
	schema?: Record<string, unknown>;
	/** True if the tool can change things, so always-ask mode asks first. */
	needsPermission: boolean;
	/**
	 * What "yes for this session" covers, if narrower than the whole tool,
	 * e.g. one website for web_fetch. `label` is shown in the permission prompt.
	 */
	permissionScope?(args: Args): { key: string; label: string };
	/** Files the tool will change, so a checkpoint can be saved first for /undo. */
	files?(args: Args, ctx: { cwd: string }): string[];
	/** Short label for the UI, e.g. `src/app.ts` or the command. */
	label(args: Args, ctx: { cwd: string }): string;
	/** What to show in the permission prompt. Can throw a ToolError. */
	preview?(args: Args, ctx: ToolContext): Promise<ToolDisplay>;
	run(args: Args, ctx: ToolContext): Promise<ToolResult>;
};

/** An error whose message is shown to the model as the tool result. */
export class ToolError extends Error {}

export function resolvePath(cwd: string, file: string): string {
	return path.resolve(cwd, file.startsWith('~/') ? path.join(process.env['HOME'] ?? '', file.slice(2)) : file);
}

/** A path relative to cwd if it's inside it, otherwise absolute. */
export function displayPath(cwd: string, file: string): string {
	const rel = path.relative(cwd, file);
	if (rel === '') return '.';
	return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

export function makeDiff(oldText: string, newText: string): DiffLine[] {
	const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context: 3 });
	const lines: DiffLine[] = [];
	for (const [i, hunk] of patch.hunks.entries()) {
		if (i > 0) lines.push({ kind: 'gap', text: '…' });
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		for (const raw of hunk.lines) {
			const mark = raw[0];
			const text = raw.slice(1);
			if (mark === '+') lines.push({ kind: 'add', text, new: newNo++ });
			else if (mark === '-') lines.push({ kind: 'remove', text, old: oldNo++ });
			else if (mark === ' ') lines.push({ kind: 'context', text, old: oldNo++, new: newNo++ });
		}
	}
	return lines;
}

export function countChanges(diff: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff) {
		if (line.kind === 'add') added++;
		else if (line.kind === 'remove') removed++;
	}
	return { added, removed };
}

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Cut long text, keeping the start and end, and say how much was cut. */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.6);
	const tail = max - head;
	const cut = text.length - head - tail;
	return `${text.slice(0, head)}\n\n[… ${cut} characters cut …]\n\n${text.slice(-tail)}`;
}
