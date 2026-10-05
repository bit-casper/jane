import fs from 'node:fs/promises';
import path from 'node:path';
import {
	type Tool,
	ToolError,
	countChanges,
	displayPath,
	makeDiff,
	plural,
	resolvePath,
} from './types.js';

const DEFAULT_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_READ_BYTES = 10 * 1024 * 1024;

async function readText(file: string, cwd: string): Promise<string> {
	let stat;
	try {
		stat = await fs.stat(file);
	} catch {
		throw new ToolError(`File not found: ${displayPath(cwd, file)}`);
	}
	if (stat.isDirectory()) throw new ToolError(`${displayPath(cwd, file)} is a directory. Use glob to list files.`);
	if (stat.size > MAX_READ_BYTES) throw new ToolError(`${displayPath(cwd, file)} is too big (${stat.size} bytes).`);
	const buffer = await fs.readFile(file);
	if (buffer.subarray(0, 8000).includes(0)) throw new ToolError(`${displayPath(cwd, file)} looks like a binary file.`);
	return buffer.toString('utf8');
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

type ReadArgs = { path: string; offset?: number; limit?: number };

export const readTool: Tool<ReadArgs> = {
	name: 'read',
	description:
		'Read a text file. Returns lines prefixed with their line number. ' +
		`Reads up to ${DEFAULT_LINES} lines; use offset and limit for longer files.`,
	params: {
		path: { type: 'string', description: 'File path, absolute or relative to the working directory', required: true },
		offset: { type: 'integer', description: 'Line number to start from (1-based)' },
		limit: { type: 'integer', description: 'Number of lines to read' },
	},
	needsPermission: false,
	label: (args, { cwd }) => displayPath(cwd, resolvePath(cwd, args.path)),
	async run(args, { cwd }) {
		const file = resolvePath(cwd, args.path);
		const text = await readText(file, cwd);
		if (text.length === 0) return { output: '(empty file)', display: { summary: 'Empty file' } };
		const lines = text.split('\n');
		if (lines.at(-1) === '') lines.pop();
		const start = Math.max(1, args.offset ?? 1);
		const limit = Math.max(1, args.limit ?? DEFAULT_LINES);
		const slice = lines.slice(start - 1, start - 1 + limit);
		if (slice.length === 0) throw new ToolError(`The file has ${lines.length} lines; offset ${start} is past the end.`);
		const width = String(start + slice.length - 1).length;
		let output = slice
			.map((line, i) => {
				const cut = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + ' [line cut]' : line;
				return `${String(start + i).padStart(width)}\t${cut}`;
			})
			.join('\n');
		const end = start + slice.length - 1;
		if (end < lines.length) output += `\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset to read more.]`;
		return { output, display: { summary: `Read ${plural(slice.length, 'line')}` } };
	},
};

type WriteArgs = { path: string; content: string };

export const writeTool: Tool<WriteArgs> = {
	name: 'write',
	description: 'Create a file, or overwrite an existing one, with the given content. Creates parent folders as needed.',
	params: {
		path: { type: 'string', description: 'File path, absolute or relative to the working directory', required: true },
		content: { type: 'string', description: 'The full content of the file', required: true },
	},
	needsPermission: true,
	files: (args, { cwd }) => [resolvePath(cwd, args.path)],
	label: (args, { cwd }) => displayPath(cwd, resolvePath(cwd, args.path)),
	async preview(args, { cwd }) {
		const file = resolvePath(cwd, args.path);
		const old = (await exists(file)) ? await readText(file, cwd) : '';
		return { diff: makeDiff(old, args.content) };
	},
	async run(args, { cwd }) {
		const file = resolvePath(cwd, args.path);
		const existed = await exists(file);
		const old = existed ? await readText(file, cwd) : '';
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, args.content);
		const diff = makeDiff(old, args.content);
		const lines = args.content.split('\n').length - (args.content.endsWith('\n') ? 1 : 0);
		const summary = existed
			? (({ added, removed }) => `Updated: ${plural(added, 'line')} added, ${removed} removed`)(countChanges(diff))
			: `Created with ${plural(lines, 'line')}`;
		return {
			output: `${existed ? 'Overwrote' : 'Created'} ${displayPath(cwd, file)} (${plural(lines, 'line')}).`,
			display: { summary, diff },
		};
	},
};

type EditArgs = { path: string; old_string: string; new_string: string; replace_all?: boolean };

function applyEdit(text: string, args: EditArgs, shown: string): string {
	if (args.old_string === '') throw new ToolError('old_string is empty. Use write to create a file.');
	if (args.old_string === args.new_string) throw new ToolError('old_string and new_string are the same.');
	const count = text.split(args.old_string).length - 1;
	if (count === 0) {
		throw new ToolError(
			`old_string was not found in ${shown}. It must match the file exactly, including spaces and indentation. Read the file again and copy the text exactly.`,
		);
	}
	if (count > 1 && !args.replace_all) {
		throw new ToolError(
			`old_string appears ${count} times in ${shown}. Include more surrounding lines to make it unique, or set replace_all to true.`,
		);
	}
	return args.replace_all
		? text.split(args.old_string).join(args.new_string)
		: text.replace(args.old_string, () => args.new_string);
}

export const editTool: Tool<EditArgs> = {
	name: 'edit',
	description:
		'Replace an exact piece of text in a file. old_string must match the file exactly (including indentation) ' +
		'and appear exactly once, unless replace_all is true. Read the file first.',
	params: {
		path: { type: 'string', description: 'File path, absolute or relative to the working directory', required: true },
		old_string: { type: 'string', description: 'The exact text to replace', required: true },
		new_string: { type: 'string', description: 'The text to put in its place', required: true },
		replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
	},
	needsPermission: true,
	files: (args, { cwd }) => [resolvePath(cwd, args.path)],
	label: (args, { cwd }) => displayPath(cwd, resolvePath(cwd, args.path)),
	async preview(args, { cwd }) {
		const file = resolvePath(cwd, args.path);
		const text = await readText(file, cwd);
		return { diff: makeDiff(text, applyEdit(text, args, displayPath(cwd, file))) };
	},
	async run(args, { cwd }) {
		const file = resolvePath(cwd, args.path);
		const shown = displayPath(cwd, file);
		const text = await readText(file, cwd);
		const updated = applyEdit(text, args, shown);
		await fs.writeFile(file, updated);
		const diff = makeDiff(text, updated);
		const { added, removed } = countChanges(diff);
		return {
			output: `Edited ${shown}.`,
			display: { summary: `${plural(added, 'line')} added, ${removed} removed`, diff },
		};
	},
};
