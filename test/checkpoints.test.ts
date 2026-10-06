import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripNotes } from '../src/agent.js';
import { Checkpoints } from '../src/checkpoints.js';

let dir: string;
let store: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-cp-'));
	store = path.join(dir, 'session.checkpoints');
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const info = (label: string) => ({ tool: 'edit', label, prompt: 'fix it' });

describe('checkpoints', () => {
	it('undoes an edit and a newly created file, newest first', () => {
		const a = path.join(dir, 'a.txt');
		const b = path.join(dir, 'sub', 'b.txt');
		fs.writeFileSync(a, 'one\n');
		const cp = new Checkpoints(store);

		const first = cp.capture([a], info('a.txt'));
		fs.writeFileSync(a, 'two\n');
		cp.commit(first);
		const second = cp.capture([b], { ...info('sub/b.txt'), tool: 'write' });
		fs.mkdirSync(path.dirname(b));
		fs.writeFileSync(b, 'new\n');
		cp.commit(second);
		const third = cp.capture([a], info('a.txt'));
		fs.writeFileSync(a, 'three\n');
		cp.commit(third);

		const list = cp.list();
		expect(list.map((c) => c.id)).toEqual([3, 2, 1]);
		expect(list[1]).toMatchObject({ tool: 'write', label: 'sub/b.txt', prompt: 'fix it', files: [{ path: b, existed: false }] });

		// Undo the newest two: a goes back to "two", b is removed.
		cp.undo(list.slice(0, 2));
		expect(fs.readFileSync(a, 'utf8')).toBe('two\n');
		expect(fs.existsSync(b)).toBe(false);
		expect(cp.list().map((c) => c.id)).toEqual([1]);

		// Survives a restart (e.g. jane --resume).
		const again = new Checkpoints(store);
		expect(again.list().map((c) => c.id)).toEqual([1]);
		again.undo(again.list());
		expect(fs.readFileSync(a, 'utf8')).toBe('one\n');
		expect(again.list()).toEqual([]);
		expect(new Checkpoints(store).capture([a], info('a'))).toBe(4);
	});

	it('forgets copies when the tool fails', () => {
		const a = path.join(dir, 'a.txt');
		fs.writeFileSync(a, 'x');
		const cp = new Checkpoints(store);
		const id = cp.capture([a], info('a'));
		expect(fs.readdirSync(store)).toEqual(['1-0']);
		cp.discard(id);
		expect(fs.readdirSync(store)).toEqual([]);
		expect(cp.list()).toEqual([]);
	});

	it('notices files changed after Jane changed them', () => {
		const a = path.join(dir, 'a.txt');
		const b = path.join(dir, 'b.txt');
		fs.writeFileSync(a, '1');
		fs.writeFileSync(b, '1');
		const cp = new Checkpoints(store);
		for (const [file, text] of [[a, '2'], [b, '2'], [a, '3']] as const) {
			const id = cp.capture([file], info(file));
			fs.writeFileSync(file, text);
			cp.commit(id);
		}
		expect(cp.changedSince(cp.list())).toEqual([]);
		fs.writeFileSync(b, 'edited by hand');
		expect(cp.changedSince(cp.list())).toEqual([b]);
		// Only the newest change for a file is compared with the file now.
		expect(cp.changedSince(cp.list().slice(0, 1))).toEqual([]);
	});

	it('strips the notes Jane adds to a user message', () => {
		expect(stripNotes('[Note from Jane: undid x]\n[Note from Jane: y]\n\nhello\nthere')).toBe('hello\nthere');
		expect(stripNotes('[Note to self] hello')).toBe('[Note to self] hello');
	});
});
