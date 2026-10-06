// Hooks: your own commands that Jane runs at certain moments, e.g. a formatter
// after an edit, a desktop notification when Jane is done, or a check that
// refuses some commands. Same protocol style as Claude Code's hooks: details
// as JSON on stdin, exit code 2 to block or to send a message to the model.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

export const HOOK_EVENTS = ['before_tool', 'after_tool', 'prompt_submit', 'turn_end', 'waiting', 'session_start', 'session_end'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type Hook = {
	event: HookEvent;
	command: string;
	/** For tool events: only these tools (empty = all). */
	tools: string[];
	/** Seconds before the command is stopped. */
	timeout: number;
	/** Which config file it came from. Project hooks need the user's OK first. */
	source: 'user' | 'project';
};

export type HookPayload = {
	tool?: string;
	args?: Record<string, unknown>;
	result?: { output: string; isError: boolean };
	prompt?: string;
	/** Absolute path of the file a file tool works on. */
	file?: string;
};

export type HookRun = {
	hook: Hook;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	ms: number;
};

const MAX_OUTPUT = 20_000;

/** The hooks that apply to an event (and tool). */
export function hooksFor(hooks: Hook[], event: HookEvent, tool?: string): Hook[] {
	return hooks.filter((h) => h.event === event && (!tool || h.tools.length === 0 || h.tools.includes(tool)));
}

/** Run one hook: bash -c, details as JSON on stdin and as JANE_* variables. */
export function runHook(hook: Hook, event: HookEvent, payload: HookPayload, ctx: { cwd: string; sessionId: string }): Promise<HookRun> {
	const started = Date.now();
	const input = JSON.stringify({
		event,
		session_id: ctx.sessionId,
		cwd: ctx.cwd,
		tool_name: payload.tool,
		tool_input: payload.args,
		tool_result: payload.result,
		prompt: payload.prompt,
		file: payload.file,
	});
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		JANE: '1',
		JANE_EVENT: event,
		JANE_SESSION_ID: ctx.sessionId,
		JANE_PROJECT_DIR: ctx.cwd,
	};
	if (payload.tool) env['JANE_TOOL'] = payload.tool;
	if (payload.file) env['JANE_FILE'] = payload.file;
	if (payload.tool === 'bash' && typeof payload.args?.['command'] === 'string') env['JANE_COMMAND'] = payload.args['command'];

	return new Promise((resolve) => {
		const child = spawn('bash', ['-c', hook.command], { cwd: ctx.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		child.stdout.on('data', (d) => {
			if (stdout.length < MAX_OUTPUT) stdout += d;
		});
		child.stderr.on('data', (d) => {
			if (stderr.length < MAX_OUTPUT) stderr += d;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {}
		}, hook.timeout * 1000);
		const finish = (exitCode: number | null) => {
			clearTimeout(timer);
			resolve({ hook, exitCode, stdout: stdout.trim(), stderr: stderr.trim(), timedOut, ms: Date.now() - started });
		};
		child.on('error', (error) => {
			stderr += error.message;
			finish(null);
		});
		child.on('close', (code) => finish(code));
		child.stdin.on('error', () => {}); // the hook may not read its input
		child.stdin.end(input);
	});
}

/** Run the hooks for an event one after another (order matters when one blocks). */
export async function runHooks(
	hooks: Hook[],
	event: HookEvent,
	payload: HookPayload,
	ctx: { cwd: string; sessionId: string },
	options: { stopOnBlock?: boolean } = {},
): Promise<HookRun[]> {
	const runs: HookRun[] = [];
	for (const hook of hooksFor(hooks, event, payload.tool)) {
		const run = await runHook(hook, event, payload, ctx);
		runs.push(run);
		if (options.stopOnBlock && run.exitCode === 2) break;
	}
	return runs;
}

/** The message from a hook that blocked or wants the model to know something (exit code 2). */
export function blockMessage(run: HookRun): string {
	return run.stderr || run.stdout || `the hook "${shortCommand(run.hook.command)}" said no`;
}

/** A problem worth showing the user: the hook failed, timed out or couldn't start (not 0, not 2). */
export function hookProblem(run: HookRun): string | undefined {
	if (run.timedOut) return `Hook "${shortCommand(run.hook.command)}" (${run.hook.event}) was stopped after ${run.hook.timeout}s.`;
	if (run.exitCode === 0 || run.exitCode === 2) return undefined;
	const detail = run.stderr ? `: ${run.stderr.split('\n').slice(-3).join(' ')}` : '';
	return `Hook "${shortCommand(run.hook.command)}" (${run.hook.event}) failed with exit code ${run.exitCode ?? 'none'}${detail}`;
}

export function shortCommand(command: string): string {
	const one = command.replace(/\s+/g, ' ').trim();
	return one.length > 60 ? one.slice(0, 59) + '…' : one;
}

// --- Trusting a project's hooks ---------------------------------------------

const trustFile = () => path.join(dataDir, 'trusted-hooks.json');

/** A fingerprint of a project's hooks: if they change, Jane asks again. */
export function hooksFingerprint(hooks: Hook[]): string {
	const plain = hooks.map(({ event, command, tools, timeout }) => ({ event, command, tools, timeout }));
	return crypto.createHash('sha256').update(JSON.stringify(plain)).digest('hex');
}

function readTrust(file: string): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
}

/** Has the user allowed exactly these hooks in this project? */
export function isTrusted(cwd: string, hooks: Hook[], file = trustFile()): boolean {
	return readTrust(file)[path.resolve(cwd)] === hooksFingerprint(hooks);
}

/** Remember that the user allowed these hooks in this project. */
export function trust(cwd: string, hooks: Hook[], file = trustFile()): void {
	const all = readTrust(file);
	all[path.resolve(cwd)] = hooksFingerprint(hooks);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
}
