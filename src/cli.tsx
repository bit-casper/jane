import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { listSessions } from './session.js';
import { App, type Start } from './ui/App.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;

const USAGE = `Usage: jane [options]

Options:
  -c, --continue        Continue the most recent session in this directory
  -r, --resume [id]     Pick a session to resume, or resume the one with this id
  -m, --model <name>    Use this model for this run
      --mode <mode>     Start in "always-ask" or "unrestricted" mode
  -v, --version         Show the version
  -h, --help            Show this help`;

type Args = { continue: boolean; resume: boolean; resumeId?: string; model?: string; mode?: string };

function fail(message: string): never {
	process.stderr.write(`jane: ${message}\n`);
	process.exit(1);
}

function parseCli(argv: string[]): Args {
	const args: Args = { continue: false, resume: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const next = () => {
			const value = argv[++i];
			if (value === undefined || value.startsWith('-')) fail(`${arg} needs a value`);
			return value;
		};
		if (arg === '-h' || arg === '--help') {
			process.stdout.write(USAGE + '\n');
			process.exit(0);
		} else if (arg === '-v' || arg === '--version') {
			process.stdout.write(version + '\n');
			process.exit(0);
		} else if (arg === '-c' || arg === '--continue') args.continue = true;
		else if (arg === '-r' || arg === '--resume') {
			args.resume = true;
			if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) args.resumeId = argv[++i];
		} else if (arg === '-m' || arg === '--model') args.model = next();
		else if (arg === '--mode') args.mode = next();
		else fail(`unknown option ${arg}\n\n${USAGE}`);
	}
	return args;
}

const args = parseCli(process.argv.slice(2));
if (!process.stdin.isTTY || !process.stdout.isTTY) fail('Jane needs an interactive terminal.');

const cwd = process.cwd();
const { config, warnings } = loadConfig(cwd);
if (args.model) config.model.name = args.model;
if (args.mode) {
	if (args.mode !== 'always-ask' && args.mode !== 'unrestricted') fail('--mode must be "always-ask" or "unrestricted"');
	config.permissions.default_mode = args.mode;
}

let start: Start = { kind: 'new' };
if (args.continue || args.resume) {
	const sessions = listSessions(cwd);
	if (args.resumeId) {
		const found = sessions.find((s) => s.id === args.resumeId || s.id.startsWith(args.resumeId!));
		if (!found) fail(`no session "${args.resumeId}" in this directory. Run "jane --resume" to see them.`);
		start = { kind: 'load', session: found };
	} else if (sessions.length === 0) {
		warnings.push('there are no sessions to resume in this directory, so this is a new one');
	} else if (args.continue) {
		start = { kind: 'load', session: sessions[0]! };
	} else {
		start = { kind: 'pick', sessions };
	}
}

let exitInfo: { sessionId?: string; started: boolean } = { started: false };

const instance = render(
	<App
		config={config}
		warnings={warnings}
		version={version}
		cwd={cwd}
		start={start}
		clearScreen={() => {
			instance.clear();
			process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
		}}
		onExit={(info) => {
			exitInfo = info;
		}}
	/>,
	{ exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } },
);

process.on('uncaughtException', (error) => log('uncaught exception', error));
process.on('unhandledRejection', (error) => log('unhandled rejection', error));

await instance.waitUntilExit();
if (exitInfo.started && exitInfo.sessionId) {
	process.stdout.write(`\nResume this session with: jane --resume ${exitInfo.sessionId}\n`);
}
process.exit(0);
