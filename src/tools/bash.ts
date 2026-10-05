import { spawn } from 'node:child_process';
import { type Tool, ToolError, truncateMiddle } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 30_000;

type BashArgs = { command: string; timeout_seconds?: number };

export const bashTool: Tool<BashArgs> = {
	name: 'bash',
	description:
		'Run a shell command with bash and return its output (stdout and stderr together). ' +
		'It already runs in the working directory, so there is no need to cd there first. ' +
		`Times out after ${DEFAULT_TIMEOUT_MS / 1000} seconds unless timeout_seconds is set (max ${MAX_TIMEOUT_MS / 1000}). ` +
		'Commands cannot read input, so avoid interactive programs. Prefer the read, glob and grep tools for looking at files.',
	params: {
		command: { type: 'string', description: 'The command to run', required: true },
		timeout_seconds: { type: 'integer', description: 'How long to wait before stopping the command' },
	},
	needsPermission: true,
	label: (args) => args.command,
	async preview(args) {
		return { text: args.command };
	},
	run(args, { cwd, signal }) {
		const timeout = Math.min(Math.max(1, args.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, MAX_TIMEOUT_MS);
		return new Promise((resolve, reject) => {
			// detached: the command gets its own process group, so we can stop it and everything it started.
			const child = spawn('bash', ['-c', args.command], {
				cwd,
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, JANE: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
			});
			let output = '';
			const collect = (d: Buffer) => {
				if (output.length < MAX_OUTPUT * 4) output += d.toString('utf8');
			};
			child.stdout.on('data', collect);
			child.stderr.on('data', collect);

			let stopped: 'timeout' | 'interrupted' | undefined;
			const stop = (why: 'timeout' | 'interrupted') => {
				stopped = why;
				try {
					process.kill(-child.pid!, 'SIGTERM');
					setTimeout(() => {
						try {
							process.kill(-child.pid!, 'SIGKILL');
						} catch {}
					}, 2000).unref();
				} catch {}
			};
			const timer = setTimeout(() => stop('timeout'), timeout);
			const onAbort = () => stop('interrupted');
			signal.addEventListener('abort', onAbort, { once: true });

			child.on('error', (error) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				reject(new ToolError(`Could not run bash: ${error.message}`));
			});
			child.on('close', (code, sig) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				const text = truncateMiddle(output.trimEnd(), MAX_OUTPUT);
				let status: string;
				if (stopped === 'timeout') status = `Command timed out after ${timeout / 1000}s and was stopped.`;
				else if (stopped === 'interrupted') status = 'Command was interrupted by the user.';
				else if (code === 0) status = '';
				else status = code === null ? `Command was killed (${sig}).` : `Exit code ${code}.`;
				const body = text || '(no output)';
				resolve({
					output: status ? `${body}\n\n${status}` : body,
					isError: Boolean(status),
					display: { text: text || undefined, summary: status || undefined },
				});
			});
		});
	},
};
