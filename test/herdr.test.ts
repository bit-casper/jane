import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Herdr } from '../src/herdr.js';

let dir: string;
let bin: string;
let logFile: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-herdr-'));
	logFile = path.join(dir, 'calls.log');
	bin = path.join(dir, 'herdr');
	// A stand-in herdr that writes down each call, one per line.
	fs.writeFileSync(bin, `#!/bin/sh\nsleep 0.05\necho "$*" >> ${logFile}\n`, { mode: 0o755 });
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []);
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('herdr', () => {
	it('reports state changes, the newest last, with increasing numbers', async () => {
		const h = new Herdr(bin, 'wF:p1', true);
		h.report('idle');
		h.report('working');
		h.report('blocked', { message: 'Allow bash:\nrm -rf build' });
		h.report('idle', { sessionId: 's1', resume: ['jane', '--resume', 's1'] });
		await settle();
		const lines = calls();
		// The first goes out at once; of the ones queued behind it only the newest is sent.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^pane report-agent wF:p1 --source jane --agent jane --state idle --seq \d+$/);
		expect(lines[1]).toMatch(/^pane report-agent wF:p1 --source jane --agent jane --state idle --agent-session-id s1 --seq \d+ -- jane --resume s1$/);
		const seqs = lines.map((l) => Number(/--seq (\d+)/.exec(l)![1]));
		expect(seqs[1]).toBeGreaterThan(seqs[0]!);
	});

	it('cleans up messages, skips repeats, and releases the pane on exit', async () => {
		const h = new Herdr(bin, 'p', true);
		h.report('blocked', { message: 'Allow bash:\nls' });
		await settle();
		h.report('blocked', { message: 'Allow bash:\nls' });
		h.release();
		await settle();
		expect(calls()).toEqual([
			expect.stringMatching(/--state blocked --message Allow bash: ls --seq/),
			expect.stringMatching(/^pane release-agent p --source jane --agent jane --seq \d+$/),
		]);
	});

	it('leaves the resume command out when herdr is too old for it', async () => {
		// herdr before 0.9.2 refuses "--" with an error.
		fs.writeFileSync(bin, `#!/bin/sh\ncase "$*" in *" -- "*) echo "unknown option: --" >&2; exit 2;; esac\necho "$*" >> ${logFile}\n`, { mode: 0o755 });
		const h = new Herdr(bin, 'p', true);
		h.report('idle', { sessionId: 's1', resume: ['jane', '--resume', 's1'] });
		await settle();
		h.report('working', { sessionId: 's1', resume: ['jane', '--resume', 's1'] });
		await settle();
		expect(calls()).toEqual([
			expect.stringMatching(/--state idle --agent-session-id s1 --seq \d+$/),
			expect.stringMatching(/--state working --agent-session-id s1 --seq \d+$/),
		]);
	});

	it('does nothing outside herdr', async () => {
		const h = new Herdr(bin, 'p', false);
		h.report('working');
		h.release();
		await settle();
		expect(calls()).toEqual([]);
	});
});
