// herdr (a terminal workspace manager for coding agents): tell it whether Jane
// is working, waiting for the user, or waiting for a decision, so its sidebar
// shows it and it can notify the user. Does nothing outside herdr.
// See https://herdr.dev/docs/add-herdr-support/

import { execFile, execFileSync } from 'node:child_process';

export type HerdrState = 'idle' | 'working' | 'blocked';

const SOURCE = 'jane';
const AGENT = 'jane';

export class Herdr {
	private seq = 0;
	private sending = false;
	/** The newest report that's waiting while another is being sent. Older ones are dropped. */
	private queued?: string[];
	private last = '';
	/** herdr before 0.9.2 refuses a resume command (and with it the whole report); then leave it out. */
	private resumeRefused = false;

	constructor(
		private readonly bin = process.env['HERDR_BIN_PATH'],
		private readonly pane = process.env['HERDR_PANE_ID'],
		private readonly enabled = process.env['HERDR_ENV'] === '1' && Boolean(bin && pane),
	) {}

	/** herdr only accepts reports with a higher number than the last, also across restarts: use the clock. */
	private nextSeq(): string {
		this.seq = Math.max(this.seq + 1, Date.now());
		return String(this.seq);
	}

	/**
	 * Report Jane's state. `resume` is the command that reopens this session,
	 * which herdr runs in the same pane after it restarts.
	 */
	report(state: HerdrState, options: { message?: string; sessionId?: string; resume?: string[] } = {}): void {
		if (!this.enabled) return;
		const key = JSON.stringify([state, options]);
		if (key === this.last) return;
		this.last = key;
		const args = ['pane', 'report-agent', this.pane!, '--source', SOURCE, '--agent', AGENT, '--state', state];
		// herdr refuses messages with control characters (and resume arguments with apostrophes).
		if (options.message) args.push('--message', options.message.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200));
		if (options.sessionId) args.push('--agent-session-id', options.sessionId);
		if (options.resume?.length && options.resume.every((a) => !/['\x00-\x1f\x7f]/.test(a))) args.push('--', ...options.resume);
		this.send(args);
	}

	private withoutResume(args: string[]): string[] {
		const at = args.indexOf('--');
		return at >= 0 ? args.slice(0, at) : args;
	}

	private send(args: string[]): void {
		if (this.resumeRefused) args = this.withoutResume(args);
		if (this.sending) {
			this.queued = args;
			return;
		}
		this.sending = true;
		// The number is added at send time, so a queued report still outranks the one before it.
		const seqAt = args.indexOf('--');
		const withSeq = seqAt >= 0 ? [...args.slice(0, seqAt), '--seq', this.nextSeq(), ...args.slice(seqAt)] : [...args, '--seq', this.nextSeq()];
		// Never let herdr slow Jane down: short timeout, failures ignored.
		execFile(this.bin!, withSeq, { timeout: 2000 }, (error) => {
			this.sending = false;
			let next = this.queued;
			this.queued = undefined;
			// Refused with a resume command: an older herdr. Send the state on its own.
			if (error && seqAt >= 0 && !this.resumeRefused && !(error as { killed?: boolean }).killed) {
				this.resumeRefused = true;
				next ??= args;
			}
			if (next) this.send(next);
		});
	}

	/** Jane is quitting: clear her from the pane straight away. */
	release(): void {
		if (!this.enabled) return;
		try {
			execFileSync(this.bin!, ['pane', 'release-agent', this.pane!, '--source', SOURCE, '--agent', AGENT, '--seq', this.nextSeq()], {
				timeout: 1000,
				stdio: 'ignore',
			});
		} catch {
			// herdr notices on its own once the pane is back at the shell prompt.
		}
	}
}

export const herdr = new Herdr();
