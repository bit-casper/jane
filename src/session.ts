import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from './client.js';
import type { PermissionMode } from './config.js';
import { projectSlug, sessionsDir } from './paths.js';
import type { ToolResult } from './tools/types.js';

export type SessionEntry =
	| { type: 'meta'; id: string; cwd: string; created: string; model: string }
	| { type: 'message'; message: ChatMessage; time: string }
	| { type: 'tool-display'; toolCallId: string; label: string; result: ToolResult }
	| { type: 'mode'; mode: PermissionMode }
	| { type: 'model'; model: string };

export type SessionSummary = {
	id: string;
	file: string;
	updated: Date;
	firstPrompt: string;
	messageCount: number;
};

export type ToolDisplayRecord = { label: string; result: ToolResult };

export type LoadedSession = {
	messages: ChatMessage[];
	/** What the screen showed for each tool call, by tool call id. */
	toolDisplays: Map<string, ToolDisplayRecord>;
	mode?: PermissionMode;
	model?: string;
};

function projectDir(cwd: string, root: string): string {
	return path.join(root, projectSlug(cwd));
}

function newId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * A session is a JSONL file. Every entry is appended as it happens, so a crash
 * loses nothing. The file is only created when the first entry is written.
 */
export class Session {
	readonly id: string;
	readonly file: string;
	private started = false;

	constructor(
		readonly cwd: string,
		private model: string,
		options: { id?: string; root?: string } = {},
	) {
		this.id = options.id ?? newId();
		this.file = path.join(projectDir(cwd, options.root ?? sessionsDir), `${this.id}.jsonl`);
		this.started = Boolean(options.id) && fs.existsSync(this.file);
		if (this.started) this.repairEnd();
	}

	/** If Jane crashed mid-write, end the broken line so new entries start clean. */
	private repairEnd(): void {
		const size = fs.statSync(this.file).size;
		if (size === 0) return;
		const fd = fs.openSync(this.file, 'r');
		const last = Buffer.alloc(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		fs.closeSync(fd);
		if (last[0] !== 0x0a) fs.appendFileSync(this.file, '\n');
	}

	private write(entry: SessionEntry): void {
		if (!this.started) {
			this.started = true;
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			this.write({ type: 'meta', id: this.id, cwd: this.cwd, created: new Date().toISOString(), model: this.model });
		}
		fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
	}

	addMessage(message: ChatMessage): void {
		this.write({ type: 'message', message, time: new Date().toISOString() });
	}

	/** Save what the screen showed for a tool call, so a resumed session looks the same. */
	addToolDisplay(toolCallId: string, label: string, result: ToolResult): void {
		const diff = result.display?.diff;
		const display = result.display && { ...result.display, diff: diff && diff.length > 200 ? diff.slice(0, 200) : diff };
		this.write({ type: 'tool-display', toolCallId, label, result: { output: '', isError: result.isError, display } });
	}

	setMode(mode: PermissionMode): void {
		if (this.started) this.write({ type: 'mode', mode });
	}

	setModel(model: string): void {
		this.model = model;
		if (this.started) this.write({ type: 'model', model });
	}
}

function readEntries(file: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A half-written last line after a crash; skip it.
		}
	}
	return entries;
}

export function loadSession(file: string): LoadedSession {
	const result: LoadedSession = { messages: [], toolDisplays: new Map() };
	for (const entry of readEntries(file)) {
		if (entry.type === 'message') result.messages.push(entry.message);
		else if (entry.type === 'tool-display') result.toolDisplays.set(entry.toolCallId, { label: entry.label, result: entry.result });
		else if (entry.type === 'mode') result.mode = entry.mode;
		else if (entry.type === 'model') result.model = entry.model;
	}
	return result;
}

/** Sessions for this directory, newest first. */
export function listSessions(cwd: string, root = sessionsDir): SessionSummary[] {
	const dir = projectDir(cwd, root);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
	} catch {
		return [];
	}
	const sessions: SessionSummary[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		const entries = readEntries(file);
		const messages = entries.flatMap((e) => (e.type === 'message' ? [e.message] : []));
		const first = messages.find((m) => m.role === 'user');
		if (!first) continue;
		sessions.push({
			id: name.slice(0, -'.jsonl'.length),
			file,
			updated: fs.statSync(file).mtime,
			firstPrompt: (first.content as string).replace(/\s+/g, ' ').trim(),
			messageCount: messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)).length,
		});
	}
	return sessions.sort((a, b) => b.updated.getTime() - a.updated.getTime());
}
