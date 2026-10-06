import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstructionFile } from './instructions.js';
import { tildify } from './paths.js';

function isGitRepo(cwd: string): boolean {
	let dir = cwd;
	while (true) {
		if (fs.existsSync(path.join(dir, '.git'))) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

/** Jane's built-in instructions: who she is and how she works. `prompt.file` replaces this part. */
export const DEFAULT_BASE = `You are Jane, a coding agent running in the user's terminal. You help with software tasks: reading and changing code, running commands, finding and fixing problems.

# How to work
- Use your tools to look things up instead of guessing. Read a file before you edit it.
- Make the change the user asked for, and nothing extra. Match the style of the surrounding code.
- When a task needs several steps, do them one after another without stopping to ask, unless you truly need a decision from the user.
- After changing code, check your work when you can, e.g. by running the build or tests.
- If a tool call fails, read the error message, fix the call and try again.
- Keep replies short. The user reads them in a terminal. Use Markdown for code.
- Refer to code as path:line so the user can find it.`;

/** Where a custom prompt file is, for a `prompt.file` setting: ~ and absolute paths, else relative to the project. */
export function resolvePromptFile(setting: string, cwd: string): string | undefined {
	const value = setting.trim();
	if (!value) return undefined;
	if (value === '~' || value.startsWith('~/')) return path.join(os.homedir(), value.slice(1));
	return path.resolve(cwd, value);
}

export type PromptBase = {
	text: string;
	/** The custom file in use, or undefined for the built-in text. */
	file?: string;
	/** The file prompt.file points to, even if it couldn't be read (so creating it is noticed). */
	watched?: string;
	/** The file's modification time when it was read (undefined if it was missing), to notice changes. */
	mtimeMs?: number;
	/** Why the custom file couldn't be used. */
	warning?: string;
};

/** The first part of the system prompt: the custom file if one is set and readable, else the built-in text. */
export function loadPromptBase(setting: string, cwd: string): PromptBase {
	const file = resolvePromptFile(setting, cwd);
	if (!file) return { text: DEFAULT_BASE };
	try {
		const stat = fs.statSync(file);
		return { text: fs.readFileSync(file, 'utf8').trim(), file, watched: file, mtimeMs: stat.mtimeMs };
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? "doesn't exist" : "can't be read";
		return { text: DEFAULT_BASE, watched: file, warning: `The system prompt file ${tildify(file)} ${reason}, so Jane is using her built-in prompt.` };
	}
}

/** True if the custom prompt file was edited (or removed) since it was read. */
export function promptFileChanged(base: PromptBase): boolean {
	if (!base.watched) return false;
	try {
		return fs.statSync(base.watched).mtimeMs !== base.mtimeMs;
	} catch {
		// Gone now: a change only if it was there before.
		return base.mtimeMs !== undefined;
	}
}

export function environmentSection(cwd: string, now = new Date()): string {
	return `# Environment
- Working directory: ${cwd}
- Git repository: ${isGitRepo(cwd) ? 'yes' : 'no'}
- Platform: ${os.platform()} ${os.release()}
- Shell: bash
- Home directory: ${os.homedir()}
- Today's date: ${now.toISOString().slice(0, 10)}`;
}

/**
 * The full system prompt: the base (built-in or custom), then the parts tools
 * and skills depend on, which a custom prompt never replaces.
 */
export function systemPrompt(
	cwd: string,
	instructions: InstructionFile[],
	sections: string[] = [],
	base: string = DEFAULT_BASE,
	now = new Date(),
): string {
	const parts = [base, environmentSection(cwd, now)].filter((p) => p.trim());
	parts.push(...sections);
	for (const file of instructions) {
		parts.push(`# Instructions from ${tildify(file.path)}\n\n${file.content}`);
	}
	return parts.join('\n\n');
}
