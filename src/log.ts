import fs from 'node:fs';
import path from 'node:path';
import { logFile } from './paths.js';

/** Append an error to Jane's log file. Never throws. */
export function log(message: string, error?: unknown): void {
	try {
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		const detail = error instanceof Error ? (error.stack ?? error.message) : error === undefined ? '' : String(error);
		fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}${detail ? `\n${detail}` : ''}\n`);
	} catch {}
}
