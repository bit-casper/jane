import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { type Tool, ToolError, displayPath, plural, resolvePath, truncateMiddle } from './types.js';

const MAX_FILES = 200;
const MAX_OUTPUT = 30_000;

/** Run ripgrep and return stdout. Exit code 1 means "no matches", not an error. */
function rg(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('rg', args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => {
			if (out.length < MAX_OUTPUT * 4) out += d;
		});
		child.stderr.on('data', (d) => (err += d));
		child.on('error', (error) => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new ToolError('ripgrep (rg) is not installed.'));
			else reject(error);
		});
		child.on('close', (code) => {
			if (code === 0 || code === 1) resolve(out);
			else reject(new ToolError(err.trim() || `rg exited with code ${code}`));
		});
	});
}

type GlobArgs = { pattern: string; path?: string };

/**
 * Split a pattern into the folder to search from and the glob to use there,
 * e.g. "/etc/x/*.conf" -> ["/etc/x", "*.conf"] and "../lib/**\/*.ts" -> ["../lib", "**\/*.ts"].
 * ripgrep's --glob only matches paths relative to where it searches.
 */
export function splitGlob(pattern: string): { base: string; glob: string } {
	const parts = pattern.split('/');
	const firstGlob = parts.findIndex((p) => /[*?[\]{}]/.test(p));
	if (firstGlob === -1) return { base: parts.slice(0, -1).join('/') || (pattern.startsWith('/') ? '/' : '.'), glob: parts.at(-1)! };
	const base = parts.slice(0, firstGlob).join('/');
	return { base: base || (pattern.startsWith('/') ? '/' : '.'), glob: parts.slice(firstGlob).join('/') };
}

export const globTool: Tool<GlobArgs> = {
	name: 'glob',
	description:
		'Find files by name pattern, e.g. "**/*.ts" or "src/**/test_*.py". Skips files ignored by .gitignore. ' +
		'Returns paths, most recently changed first.',
	params: {
		pattern: { type: 'string', description: 'Glob pattern', required: true },
		path: { type: 'string', description: 'Folder to search in (default: working directory)' },
	},
	needsPermission: false,
	label: (args) => args.pattern + (args.path ? ` in ${args.path}` : ''),
	async run(args, { cwd, signal }) {
		const { base, glob } = splitGlob(args.pattern);
		const root = resolvePath(resolvePath(cwd, args.path ?? '.'), base);
		try {
			if (!fs.statSync(root).isDirectory()) throw new Error();
		} catch {
			return { output: `No files found: ${displayPath(cwd, root)} is not a folder.`, display: { summary: 'No files found' } };
		}
		// "dir/*.ts" means files directly in dir; a leading / anchors the glob there (gitignore rules).
		const anchored = base !== '.' && !glob.includes('/') ? `/${glob}` : glob;
		const out = await rg(['--files', '--hidden', '--glob', '!.git', '--glob', anchored, '--sortr', 'modified'], root, signal);
		const files = out.split('\n').filter(Boolean);
		if (files.length === 0) return { output: 'No files found.', display: { summary: 'No files found' } };
		const shown = files.slice(0, MAX_FILES).map((f) => displayPath(cwd, resolvePath(root, f)));
		let output = shown.join('\n');
		if (files.length > MAX_FILES) output += `\n\n[${files.length - MAX_FILES} more files not shown. Use a narrower pattern.]`;
		return { output, display: { summary: `Found ${plural(files.length, 'file')}` } };
	},
};

type GrepArgs = {
	pattern: string;
	path?: string;
	glob?: string;
	ignore_case?: boolean;
	files_only?: boolean;
};

export const grepTool: Tool<GrepArgs> = {
	name: 'grep',
	description:
		'Search file contents with a regular expression (ripgrep syntax). Skips files ignored by .gitignore. ' +
		'Returns matching lines as path:line:text, or only file paths if files_only is true.',
	params: {
		pattern: { type: 'string', description: 'Regular expression to search for', required: true },
		path: { type: 'string', description: 'File or folder to search (default: working directory)' },
		glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
		ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
		files_only: { type: 'boolean', description: 'Only list the files that match' },
	},
	needsPermission: false,
	label: (args) => `"${args.pattern}"` + (args.path ? ` in ${args.path}` : '') + (args.glob ? ` (${args.glob})` : ''),
	async run(args, { cwd, signal }) {
		const target = resolvePath(cwd, args.path ?? '.');
		const flags = ['--hidden', '--glob', '!.git', '--max-columns', '500', '--max-columns-preview'];
		if (args.files_only) flags.push('--files-with-matches');
		else flags.push('--line-number', '--no-heading', '--with-filename');
		if (args.ignore_case) flags.push('--ignore-case');
		if (args.glob) flags.push('--glob', args.glob);
		// Without a path, rg searches cwd and prints paths without a "./" prefix.
		const where = target === cwd ? [] : ['--', displayPath(cwd, target)];
		const out = await rg([...flags, '--regexp', args.pattern, ...where], cwd, signal);
		const lines = out.split('\n').filter(Boolean);
		if (lines.length === 0) return { output: 'No matches.', display: { summary: 'No matches' } };
		return {
			output: truncateMiddle(lines.join('\n'), MAX_OUTPUT),
			display: { summary: `Found ${plural(lines.length, args.files_only ? 'file' : 'match')}` },
		};
	},
};
