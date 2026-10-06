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

export function systemPrompt(cwd: string, instructions: InstructionFile[], sections: string[] = [], now = new Date()): string {
	const parts = [
		`You are Jane, a coding agent running in the user's terminal. You help with software tasks: reading and changing code, running commands, finding and fixing problems.`,
		`# How to work
- Use your tools to look things up instead of guessing. Read a file before you edit it.
- Make the change the user asked for, and nothing extra. Match the style of the surrounding code.
- When a task needs several steps, do them one after another without stopping to ask, unless you truly need a decision from the user.
- After changing code, check your work when you can, e.g. by running the build or tests.
- If a tool call fails, read the error message, fix the call and try again.
- Keep replies short. The user reads them in a terminal. Use Markdown for code.
- Refer to code as path:line so the user can find it.`,
		`# Environment
- Working directory: ${cwd}
- Git repository: ${isGitRepo(cwd) ? 'yes' : 'no'}
- Platform: ${os.platform()} ${os.release()}
- Shell: bash
- Home directory: ${os.homedir()}
- Today's date: ${now.toISOString().slice(0, 10)}`,
	];
	parts.push(...sections);
	for (const file of instructions) {
		parts.push(`# Instructions from ${tildify(file.path)}\n\n${file.content}`);
	}
	return parts.join('\n\n');
}
