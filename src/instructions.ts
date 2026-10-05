import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './paths.js';

export type InstructionFile = { path: string; content: string };

/** The first of `filenames` that exists in `dir`. */
function firstFound(dir: string, filenames: string[]): InstructionFile | undefined {
	for (const name of filenames) {
		const file = path.join(dir, name);
		try {
			const content = fs.readFileSync(file, 'utf8').trim();
			return { path: file, content };
		} catch {}
	}
	return undefined;
}

/** User-wide instructions first, then the project's, so the project can override. */
export function loadInstructions(cwd: string, filenames: string[], userDir = configDir): InstructionFile[] {
	const found: InstructionFile[] = [];
	const user = firstFound(userDir, filenames);
	if (user) found.push(user);
	const project = firstFound(cwd, filenames);
	if (project && project.path !== user?.path) found.push(project);
	return found.filter((f) => f.content.length > 0);
}
