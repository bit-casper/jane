// Checkpoints: a copy of each file before Jane changes it, so /undo can put it back.
//
// Stored next to the session file, in <session>.checkpoints/:
//   index.jsonl   one line per change, plus "undone" markers
//   <n>-<i>       the file contents from before change n (one per file)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type CheckpointFile = {
	path: string;
	/** Whether the file existed before the change. */
	existed: boolean;
	/** Hash of the file right after the change, to notice later edits. Null if it was deleted. */
	afterHash: string | null;
};

export type Change = {
	id: number;
	time: string;
	tool: string;
	label: string;
	/** The start of the prompt this change was made for. */
	prompt: string;
	files: CheckpointFile[];
};

type IndexEntry = ({ type: 'change' } & Change) | { type: 'undone'; id: number };

function hashFile(file: string): string | null {
	try {
		return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
	} catch {
		return null;
	}
}

export class Checkpoints {
	private nextId: number;
	private pending = new Map<number, { change: Omit<Change, 'files'>; files: { path: string; existed: boolean }[] }>();

	constructor(readonly dir: string) {
		this.nextId = Math.max(0, ...this.entries().map((e) => e.id)) + 1;
	}

	private get index(): string {
		return path.join(this.dir, 'index.jsonl');
	}

	private blob(id: number, i: number): string {
		return path.join(this.dir, `${id}-${i}`);
	}

	private entries(): IndexEntry[] {
		let text: string;
		try {
			text = fs.readFileSync(this.index, 'utf8');
		} catch {
			return [];
		}
		const out: IndexEntry[] = [];
		for (const line of text.split('\n')) {
			try {
				if (line.trim()) out.push(JSON.parse(line));
			} catch {}
		}
		return out;
	}

	private append(entry: IndexEntry): void {
		fs.mkdirSync(this.dir, { recursive: true });
		fs.appendFileSync(this.index, JSON.stringify(entry) + '\n');
	}

	/** Save the current contents of `files` before a tool changes them. Returns an id for commit/discard. */
	capture(files: string[], info: { tool: string; label: string; prompt: string }): number {
		const id = this.nextId++;
		fs.mkdirSync(this.dir, { recursive: true });
		const saved = [...new Set(files)].map((file, i) => {
			let existed = true;
			try {
				fs.copyFileSync(file, this.blob(id, i));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				existed = false;
			}
			return { path: file, existed };
		});
		this.pending.set(id, { change: { id, time: new Date().toISOString(), ...info }, files: saved });
		return id;
	}

	/** The tool succeeded: record the change so it can be undone. */
	commit(id: number): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		const files = pending.files.map((f) => ({ ...f, afterHash: hashFile(f.path) }));
		this.append({ type: 'change', ...pending.change, files });
	}

	/** The tool failed: forget the copies. */
	discard(id: number): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.files.forEach((_, i) => fs.rmSync(this.blob(id, i), { force: true }));
	}

	/** Changes that can still be undone, newest first. */
	list(): Change[] {
		const entries = this.entries();
		const undone = new Set(entries.flatMap((e) => (e.type === 'undone' ? [e.id] : [])));
		return entries
			.flatMap((e) => (e.type === 'change' && !undone.has(e.id) ? [e] : []))
			.map(({ type: _, ...change }) => change)
			.reverse();
	}

	/** Files in these changes that were modified after Jane changed them. */
	changedSince(changes: Change[]): string[] {
		const out = new Set<string>();
		// Only the newest change per file matters: that's what the file should look like now.
		const seen = new Set<string>();
		for (const change of [...changes].sort((a, b) => b.id - a.id)) {
			for (const file of change.files) {
				if (seen.has(file.path)) continue;
				seen.add(file.path);
				if (hashFile(file.path) !== file.afterHash) out.add(file.path);
			}
		}
		return [...out];
	}

	/** Put files back as they were before these changes, newest change first. */
	undo(changes: Change[]): void {
		for (const change of [...changes].sort((a, b) => b.id - a.id)) {
			change.files.forEach((file, i) => {
				if (file.existed) {
					fs.mkdirSync(path.dirname(file.path), { recursive: true });
					fs.copyFileSync(this.blob(change.id, i), file.path);
				} else {
					fs.rmSync(file.path, { force: true });
				}
			});
			this.append({ type: 'undone', id: change.id });
		}
	}
}
