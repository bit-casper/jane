import fs from 'node:fs';
import path from 'node:path';
import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Agent, type AgentEvents, MAX_BAD_CALLS, stripNotes, type PermissionDecision, type PermissionRequest } from '../agent.js';
import { type ChatMessage, ModelError, listModels } from '../client.js';
import { type Config, type PermissionMode, loadConfig } from '../config.js';
import { type InstructionFile, loadInstructions } from '../instructions.js';
import { type Change, Checkpoints } from '../checkpoints.js';
import { isSummary } from '../compact.js';
import { compileBlockList } from '../blocklist.js';
import { type Host, type HostManager, LOCAL_HOST, describeHost, hostsPromptSection, probe } from '../hosts.js';
import { type Hook, type HookEvent, type HookPayload, type HookRun, blockMessage, fingerprint, hookProblem, isTrusted, isTrustedPrint, runHooks, shortCommand, trust, trustPrint } from '../hooks.js';
import { McpManager, type McpServerConfig } from '../mcp.js';
import { HELPER_INSTRUCTIONS, type Helper, Helpers, makeAgentTool, reportText, seconds as helperSeconds } from '../subagents.js';
import { log } from '../log.js';
import { watchOmarchyTheme } from '../omarchy.js';
import { configDir, tildify } from '../paths.js';
import { DEFAULT_BASE, type PromptBase, builtinChangedSince, initPromptFile, loadPromptBase, markBuiltinSeen, promptFileChanged, readBaseCopy, resolvePromptFile, systemPrompt } from '../prompt.js';
import { makeDiff, resolvePath } from '../tools/types.js';
import { saveSetting } from '../settings.js';
import { type SessionSummary, Session, type ToolDisplayRecord, loadSession } from '../session.js';
import { type Skill, discoverSkills, skillContent, skillDirs, skillMessage, skillsPrompt, typedText } from '../skills.js';
import { findTool, parseArgs, tools as baseTools } from '../tools/index.js';
import { makeSkillTool } from '../tools/skill.js';
import { webTools } from '../tools/web.js';
import { Banner } from './Banner.js';
import * as ed from './editor.js';
import {
	AssistantMessage,
	DiffMessage,
	type HistoryItem,
	InfoMessage,
	Thinking,
	ToolMessage,
	UserMessage,
	toolTitle,
} from './History.js';
import { Input, type Suggestion } from './Input.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { ResumePicker } from './ResumePicker.js';
import { SettingsMenu } from './SettingsMenu.js';
import { TrustPrompt } from './TrustPrompt.js';
import { UndoPicker } from './UndoPicker.js';
import { fitToRows, rowsFor } from './fit.js';
import { renderMarkdown } from './markdown.js';
import { ThemeContext, useColors } from './theme.js';

export type Start = { kind: 'new' } | { kind: 'load'; session: SessionSummary } | { kind: 'pick'; sessions: SessionSummary[] };

/** Settings given on the command line, which win over the config files until changed in /settings. */
export type Overrides = { model?: string; mode?: PermissionMode };

export function applyOverrides(config: Config, overrides: Overrides): Config {
	if (overrides.model) config.model.name = overrides.model;
	if (overrides.mode) config.permissions.default_mode = overrides.mode;
	return config;
}

export type AppProps = {
	/** The machines Jane can use, with the one to start on already chosen. */
	hosts: HostManager;
	/** Messages about choosing the host at startup, e.g. "home isn't reachable". */
	hostNotes: string[];
	config: Config;
	overrides: Overrides;
	warnings: string[];
	version: string;
	cwd: string;
	start: Start;
	clearScreen(): void;
	onExit(info: { sessionId?: string; started: boolean }): void;
};

const COMMANDS: Suggestion[] = [
	{ name: 'clear', description: 'Start a fresh session' },
	{ name: 'model', description: 'Show or change the model' },
	{ name: 'permissions', description: 'Switch permission mode' },
	{ name: 'settings', description: 'Change Jane\'s settings' },
	{ name: 'skills', description: 'List the skills Jane can use' },
	{ name: 'prompt', description: 'Show the full system prompt, or make your own' },
	{ name: 'undo', description: 'Undo file changes Jane made' },
	{ name: 'compact', description: 'Summarise the conversation to free up context' },
	{ name: 'host', description: 'Show or switch the machine Jane uses' },
	{ name: 'agents', description: 'Helper agents: list, show a report, stop' },
	{ name: 'hooks', description: 'List your hooks' },
	{ name: 'mcp', description: 'MCP servers and their tools' },
	{ name: 'help', description: 'Commands and keys' },
	{ name: 'exit', description: 'Quit Jane' },
];

const HELP = `Commands
  /clear              Start a fresh session
  /model [name]       Show the available models, or switch to one
  /permissions [mode] Switch between always-ask and unrestricted
  /settings           Change settings (saved to your user or project config)
  /skills             List the skills Jane can use
  /prompt             Show the full system prompt the model gets
  /prompt init        Make ~/.config/jane/system.md to write your own
  /prompt diff        Compare your prompt with Jane's built-in one
  /<skill> [request]  Run a skill, e.g. /omarchy change the gaps
  /undo               Undo file changes Jane made
  /compact [focus]    Summarise the conversation to free up context
  /host [name]        Show the hosts, or switch to one
  /agents [id]        Helper agents and their reports (/agents stop <id>)
  /hooks              List your hooks (/hooks allow turns on this project's)
  /mcp [name]         MCP servers and their tools (/mcp allow, /mcp restart <name>)
  /help               Show this help
  /exit               Quit

Keys
  Enter               Send
  Shift+Enter, \\+Enter, Ctrl+J   New line
  ↑ / ↓               Previous prompts
  Esc                 Interrupt Jane
  Shift+Tab           Switch permission mode
  Ctrl+C              Clear the input, or press twice to quit`;

type PendingPermission = {
	key: string;
	request: PermissionRequest;
	/** Who asks: the main conversation, or a helper agent. */
	owner: 'main' | 'helper';
	helper?: Helper;
	resolve(decision: PermissionDecision): void;
};

type TrustRequest = { kind: 'hooks'; hooks: Hook[] } | { kind: 'mcp'; servers: Record<string, McpServerConfig> };

/** What identifies a project's MCP servers for trust: if any of this changes, Jane asks again. */
function mcpFingerprint(servers: Record<string, McpServerConfig>): string {
	return fingerprint(Object.entries(servers).map(([name, { command, url, env, headers }]) => ({ name, command, url, env, headers })));
}

function describeMcpStatus(manager: McpManager, name: string): string {
	const status = manager.status.get(name);
	if (!status) return 'unknown';
	if (status.state === 'connected') return `ready, ${status.tools} tools (~${formatTokens(status.tokens)} tokens)`;
	if (status.state === 'failed') return `not available: ${status.reason}`;
	return status.state;
}

let nextKey = 0;
const key = () => String(nextKey++);

/** Turn saved messages back into what the screen shows. */
function itemsFromMessages(messages: ChatMessage[], displays: Map<string, ToolDisplayRecord>, cwd: string): HistoryItem[] {
	const items: HistoryItem[] = [];
	const results = new Map<string, string>();
	for (const m of messages) if (m.role === 'tool') results.set(m.tool_call_id, m.content);
	for (const m of messages) {
		if (m.role === 'user' && isSummary(m)) items.push({ key: key(), kind: 'info', text: 'Conversation compacted here. Jane continues from a summary.' });
		else if (m.role === 'user') items.push({ key: key(), kind: 'user', text: typedText(stripNotes(m.content)) });
		else if (m.role === 'assistant') {
			if (m.content?.trim()) items.push({ key: key(), kind: 'assistant', text: m.content });
			for (const call of m.tool_calls ?? []) {
				const saved = displays.get(call.id);
				if (saved) {
					items.push({ key: key(), kind: 'tool', name: call.function.name, label: saved.label, result: saved.result });
					continue;
				}
				// Older entries without a saved display: show the end of the result.
				const tool = findTool(call.function.name);
				const parsed = tool ? parseArgs(tool, call.function.arguments) : undefined;
				const label = tool && parsed && 'args' in parsed ? tool.label(parsed.args, { cwd }) : '';
				const output = results.get(call.id) ?? '';
				const isError = output.startsWith('Error:') || output.startsWith('The user did not allow');
				const lines = output.split('\n').filter((l) => l.trim());
				const firstLine = (isError ? lines.at(-1) : lines[0]) ?? '';
				items.push({
					key: key(),
					kind: 'tool',
					name: call.function.name,
					label,
					result: { output, isError, display: { summary: firstLine.length > 120 ? firstLine.slice(0, 119) + '…' : firstLine } },
				});
			}
		}
	}
	return items;
}

/** Terminal rows a block of text takes at `width` columns, counting wrapped lines. */
function rowsOf(text: string, width: number): number {
	return text.split('\n').reduce((n, line) => n + rowsFor(line, width), 0);
}

function formatTokens(n: number): string {
	return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

function StatusLine({ mode, model, host, tokens, contextWindow, hint }: { mode: PermissionMode; model: string; host?: string; tokens: number; contextWindow: number; hint?: string }) {
	const colors = useColors();
	const full = tokens / contextWindow;
	return (
		<Box justifyContent="space-between" paddingX={1}>
			<Text>
				{hint ? (
					<Text dimColor>{hint}</Text>
				) : mode === 'unrestricted' ? (
					<Text color="yellow">⏵⏵ unrestricted <Text dimColor>(shift+tab to switch)</Text></Text>
				) : (
					<Text color={colors.accent}>⏸ always ask <Text dimColor>(shift+tab to switch)</Text></Text>
				)}
			</Text>
			<Text dimColor>
				{host ? `${host} · ` : ''}{model} · <Text color={full > 0.9 ? colors.diff_remove : full > 0.75 ? 'yellow' : undefined}>{formatTokens(tokens)} / {formatTokens(contextWindow)}</Text>
			</Text>
		</Box>
	);
}

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

type Live = { reasoning: string; content: string; thinkStart?: number };

export function App(props: AppProps) {
	const [config, setConfig] = useState(props.config);
	return (
		<ThemeContext.Provider value={config.ui.colors}>
			<Main {...props} config={config} setConfig={setConfig} />
		</ThemeContext.Provider>
	);
}

function Main({ hosts, hostNotes, config, setConfig, overrides, warnings, version, cwd, start, clearScreen, onExit }: AppProps & { setConfig(c: Config): void }) {
	const colors = config.ui.colors;
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();

	const [phase, setPhase] = useState<'pick' | 'chat'>(start.kind === 'pick' ? 'pick' : 'chat');
	const [staticKey, setStaticKey] = useState(0);
	const [items, setItems] = useState<HistoryItem[]>([]);
	const [mode, setModeState] = useState<PermissionMode>(config.permissions.default_mode);
	const [model, setModel] = useState(hosts.current.model);
	const [hostName, setHostName] = useState(hosts.current.name);
	const [contextWindow, setContextWindow] = useState(hosts.current.contextWindow);
	const hostNotesShown = useRef(false);
	const multiHost = hosts.hosts.length > 1;
	const [tokens, setTokens] = useState(0);
	const [input, setInput] = useState<ed.EditorState>(ed.empty);
	const [promptHistory, setPromptHistory] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [live, setLive] = useState<Live>({ reasoning: '', content: '' });
	const [running, setRunning] = useState<{ id: string; name: string; label: string }[]>([]);
	/** Permission questions waiting for the user, one at a time: from the main conversation or a helper. */
	const [permissions, setPermissions] = useState<PendingPermission[]>([]);
	const permission = permissions[0] ?? null;
	const askUser = (item: Omit<PendingPermission, 'key' | 'resolve'>) =>
		new Promise<PermissionDecision>((resolve) => setPermissions((q) => [...q, { ...item, key: key(), resolve }]));
	const helpersRef = useRef<Helpers | null>(null);
	const [, setHelpersVersion] = useState(0);
	const [hint, setHint] = useState<string>();
	const [tick, setTick] = useState(0);
	const [startedAt, setStartedAt] = useState(0);
	const [panel, setPanel] = useState<'settings' | null>(null);
	const overridesRef = useRef<Overrides>({ ...overrides });
	const [undoList, setUndoList] = useState<Change[] | null>(null);
	/** What a project's config wants to run, waiting for the user's OK (one question at a time). */
	const [trustQueue, setTrustQueue] = useState<TrustRequest[]>([]);
	const askTrust = trustQueue[0];
	const askFor = (request: TrustRequest) => setTrustQueue((q) => (q.some((r) => r.kind === request.kind) ? q : [...q, request]));
	const mcpRef = useRef<McpManager | null>(null);
	/** The web tool settings in effect (a ref, so /settings changes apply without waiting for a render). */
	const webRef = useRef(config.web);
	const mcpAnnounced = useRef(new Map<string, string>());
	/** The hooks that run: the user's, plus the project's once allowed. */
	const hooksRef = useRef<Hook[]>([]);
	const [compacting, setCompacting] = useState(false);

	const agentRef = useRef<Agent | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const liveRef = useRef<Live>({ reasoning: '', content: '' });
	const exitArmedRef = useRef(0);
	const instructionsRef = useRef<InstructionFile[]>([]);
	const promptBaseRef = useRef<PromptBase>({ text: DEFAULT_BASE });
	/** The prompt.file setting in effect, for reloading the file when it changes. */
	const promptSettingRef = useRef('');
	const busyRef = useRef(false);
	/** The history needs printing again (new theme colours, or the banner's host changed), once Jane isn't busy. */
	const redrawPendingRef = useRef(false);
	busyRef.current = busy;
	const skillsRef = useRef<Skill[]>([]);

	const push = useCallback((...more: HistoryItem[]) => setItems((prev) => [...prev, ...more]), []);
	const info = useCallback((text: string, tone: 'info' | 'warning' | 'error' = 'info') => push({ key: key(), kind: 'info', text, tone }), [push]);

	/** Set up the agent for a new or resumed session, and show its start on screen. */
	const begin = useCallback(
		(resume?: SessionSummary) => {
			const instructions = loadInstructions(cwd, config.instructions.filenames);
			instructionsRef.current = instructions;
			promptSettingRef.current = config.prompt.file;
			promptBaseRef.current = loadPromptBase(config.prompt.file, cwd);
			const found = discoverSkills(skillDirs(cwd, config.skills.sources, config.skills.extra_dirs));
			skillsRef.current = found.skills;
			const listed = skillsPrompt(found.skills);
			let messages: ChatMessage[] = [];
			let allMessages: ChatMessage[] = [];
			let displays = new Map<string, ToolDisplayRecord>();
			let restoredMode: PermissionMode | undefined;
			if (resume) {
				const loaded = loadSession(resume.file);
				messages = loaded.messages;
				allMessages = loaded.allMessages;
				displays = loaded.toolDisplays;
				restoredMode = loaded.mode;
			}
			const host = hosts.current;
			const session = new Session(cwd, host.model, { id: resume?.id });
			const startMode = restoredMode ?? config.permissions.default_mode;
			const agent = new Agent(
				{ baseUrl: host.baseUrl, apiKey: host.apiKey, model: host.model },
				startMode,
				systemPrompt(cwd, instructions, [hostsPromptSection(hosts), ...(listed ? [listed] : [])], promptBaseRef.current.text),
				cwd,
				session,
				messages,
			);
			agentRef.current = agent;
			refreshTools();
			if (config.checkpoints.enabled) agent.checkpoints = new Checkpoints(session.file.replace(/\.jsonl$/, '.checkpoints'));
			if (config.block_list.enabled) agent.blockRules = compileBlockList(config.block_list.patterns).rules;
			agent.contextWindow = host.contextWindow;
			agent.autoCompactPercent = config.compact.auto ? config.compact.at_percent : 0;
			agent.failover = failover;
			agent.hooks = {
				async before(call) {
					const runs = await hookRuns('before_tool', toolPayload(call), { stopOnBlock: true });
					const blocked = runs.find((r) => r.exitCode === 2);
					return blocked ? blockMessage(blocked) : undefined;
				},
				async after(call) {
					const runs = await hookRuns('after_tool', { ...toolPayload(call), result: { output: call.result.output, isError: Boolean(call.result.isError) } });
					const messages = runs.filter((r) => r.exitCode === 2).map((r) => blockMessage(r));
					for (const r of runs.filter((r) => r.exitCode === 2)) info(`Hook "${shortCommand(r.hook.command)}" told Jane: ${blockMessage(r).split('\n')[0]}`);
					return messages.length ? messages.join('\n\n') : undefined;
				},
			};
			agent.beforeTurn = () => {
				// Pick up edits to the custom prompt file before each message.
				if (!promptFileChanged(promptBaseRef.current)) return;
				reloadPromptBase(promptSettingRef.current);
			};
			agentRef.current = agent;
			setModeState(startMode);
			setModel(agent.settings.model);
			setTokens(agent.contextTokens());
			setPromptHistory(allMessages.flatMap((m) => (m.role === 'user' && !isSummary(m) ? [typedText(stripNotes(m.content))] : [])));

			const head: HistoryItem[] = [{ key: key(), kind: 'banner' }];
			for (const w of warnings) head.push({ key: key(), kind: 'info', text: `Config: ${w}`, tone: 'warning' });
			if (!hostNotesShown.current) {
				hostNotesShown.current = true;
				for (const note of hostNotes) head.push({ key: key(), kind: 'info', text: note, tone: 'warning' });
			}
			if (instructions.length) {
				head.push({ key: key(), kind: 'info', text: `Loaded ${instructions.map((f) => (path.dirname(f.path) === cwd ? path.basename(f.path) : tildify(f.path))).join(', ')}` });
			}
			const base = promptBaseRef.current;
			if (base.warning) head.push({ key: key(), kind: 'info', text: base.warning, tone: 'warning' });
			else if (base.file) {
				head.push({ key: key(), kind: 'info', text: `System prompt from ${tildify(base.file)}` });
				if (builtinChangedSince(base.file)) {
					head.push({
						key: key(),
						kind: 'info',
						tone: 'warning',
						text: `Jane's built-in prompt has changed since you made ${tildify(base.file)}. /prompt diff shows what changed, so you can copy over what you want.`,
					});
				}
			}
			for (const w of found.warnings) head.push({ key: key(), kind: 'info', text: `Skills: ${w}`, tone: 'warning' });
			if (found.skills.length) {
				head.push({ key: key(), kind: 'info', text: `Skills: ${found.skills.map((s) => s.name).join(', ')}` });
			}
			if (resume) {
				head.push(...itemsFromMessages(allMessages, displays, cwd));
				head.push({ key: key(), kind: 'info', text: `Resumed session from ${resume.updated.toLocaleString()}` });
			}
			setItems(head);

			const userHooks = config.hooks.filter((h) => h.source === 'user');
			const projectHooks = config.hooks.filter((h) => h.source === 'project');
			const allowed = projectHooks.length > 0 && isTrusted(cwd, projectHooks);
			hooksRef.current = allowed ? config.hooks : userHooks;
			if (projectHooks.length > 0 && !allowed) askFor({ kind: 'hooks', hooks: projectHooks });
			void fireHooks('session_start', {});
		},
		[config, cwd, warnings],
	);

	// MCP servers live as long as Jane does (they survive /clear): start them once.
	useEffect(() => {
		const user = Object.fromEntries(Object.entries(config.mcp).filter(([, s]) => s.source === 'user'));
		const project = Object.fromEntries(Object.entries(config.mcp).filter(([, s]) => s.source === 'project'));
		const allowed = Object.keys(project).length > 0 && isTrustedPrint(cwd, 'mcp', mcpFingerprint(project));
		void startMcp(allowed ? { ...user, ...project } : user);
		if (Object.keys(project).length && !allowed) askFor({ kind: 'mcp', servers: project });
		return () => void mcpRef.current?.closeAll();
	}, []);

	useEffect(() => {
		if (start.kind === 'load') begin(start.session);
		else if (start.kind === 'new') begin();
		// For 'pick', begin() runs after the user chooses.
	}, []);

	/** Redraw the history now, or when the current turn ends: redrawing while Jane is replying would tear the screen. */
	function redrawSoon() {
		if (busyRef.current) redrawPendingRef.current = true;
		else redrawHistory();
	}

	/** Print the whole history again, e.g. in new theme colours. */
	const redrawHistory = useCallback(() => {
		redrawPendingRef.current = false;
		clearScreen();
		setStaticKey((k) => k + 1);
	}, [clearScreen]);

	// When the window changes size (a tiling window manager does this whenever a window opens or closes next
	// to Jane), what was drawn at the old width gets re-wrapped by the terminal and can't be erased properly,
	// leaving old input boxes behind. So once the resizing settles, clear the screen and draw everything again.
	const sizeRef = useRef({ columns, rows });
	useEffect(() => {
		if (sizeRef.current.columns === columns && sizeRef.current.rows === rows) return;
		sizeRef.current = { columns, rows };
		const timer = setTimeout(() => redrawHistory(), 150);
		return () => clearTimeout(timer);
	}, [columns, rows]);

	// Follow Omarchy theme changes: new colours apply right away, and the history is redrawn in them.
	useEffect(() => {
		if (config.ui.theme !== 'omarchy') return;
		return watchOmarchyTheme(() => {
			const colors = loadConfig(cwd).config.ui.colors;
			setConfig({ ...config, ui: { ...config.ui, colors } });
			redrawSoon();
		});
	}, [config, cwd]);

	// While helpers run (also between turns), refresh their status lines every second.
	const helpersRunning = helpersRef.current?.running().length ?? 0;
	useEffect(() => {
		if (!helpersRunning) return;
		const timer = setInterval(() => setHelpersVersion((v) => v + 1), 1000);
		return () => clearInterval(timer);
	}, [helpersRunning]);

	// While Jane works: move streamed text from the ref to the screen, and animate the spinner.
	useEffect(() => {
		if (!busy) return;
		const timer = setInterval(() => {
			setLive({ ...liveRef.current });
			setTick((t) => t + 1);
		}, 80);
		return () => clearInterval(timer);
	}, [busy]);

	const setMode = (next: PermissionMode) => {
		setModeState(next);
		if (agentRef.current) {
			agentRef.current.mode = next;
			agentRef.current.session.setMode(next);
		}
	};

	const quit = async () => {
		const agent = agentRef.current;
		onExit({ sessionId: agent?.session.id, started: Boolean(agent?.messages.length) });
		helpersRef.current?.stopAll();
		await fireHooks('session_end', {});
		await mcpRef.current?.closeAll();
		exit();
	};

	const flushLive = (interrupted: boolean) => {
		const { reasoning, content, thinkStart } = liveRef.current;
		const out: HistoryItem[] = [];
		if (reasoning.trim()) {
			out.push({ key: key(), kind: 'thinking', text: reasoning, seconds: thinkStart ? Math.round((Date.now() - thinkStart) / 1000) : undefined });
		}
		if (content.trim()) out.push({ key: key(), kind: 'assistant', text: content });
		liveRef.current = { reasoning: '', content: '' };
		setLive(liveRef.current);
		if (out.length) push(...out);
		if (interrupted) info('Interrupted. Tell Jane what to do instead.', 'warning');
	};

	/** Run something that keeps Jane busy (a prompt, or /compact), with the spinner, Esc and errors handled. */
	const work = async <T,>(task: (events: AgentEvents, signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
		const controller = new AbortController();
		abortRef.current = controller;
		setBusy(true);
		setStartedAt(Date.now());
		liveRef.current = { reasoning: '', content: '' };
		const events: AgentEvents = {
			onReasoning(delta) {
				liveRef.current.thinkStart ??= Date.now();
				liveRef.current.reasoning += delta;
			},
			onContent(delta) {
				liveRef.current.content += delta;
			},
			onReply() {
				flushLive(false);
			},
			onDiscard() {
				liveRef.current = { reasoning: '', content: '' };
				setLive(liveRef.current);
			},
			onToolStart(call) {
				setRunning((r) => [...r, call]);
			},
			onToolEnd(call) {
				setRunning((r) => r.filter((c) => c.id !== call.id));
				push({ key: key(), kind: 'tool', name: call.name, label: call.label, result: call.result });
			},
			onUsage: setTokens,
			onCompacting() {
				setCompacting(true);
			},
			onCompacted({ before, after, auto }) {
				setCompacting(false);
				info(`Conversation compacted${auto ? ' automatically' : ''}: ${formatTokens(before)} → ${formatTokens(after)} tokens. Jane continues from a summary.`);
			},
			onNotice: info,
			askPermission(request) {
				void fireHooks('waiting', { tool: request.tool.name });
				return askUser({ request, owner: 'main' });
			},
		};
		try {
			return await task(events, controller.signal);
		} catch (error) {
			flushLive(controller.signal.aborted);
			if (controller.signal.aborted) return undefined;
			const message = error instanceof ModelError ? error.message : `Unexpected error: ${(error as Error).message}`;
			if (!(error instanceof ModelError)) log('run failed', error);
			info(message, 'error');
			return undefined;
		} finally {
			abortRef.current = null;
			setRunning([]);
			// Questions from this turn that are still open are moot now; helpers' questions stay.
			setPermissions((q) => {
				for (const p of q) if (p.owner === 'main') p.resolve({ kind: 'no' });
				return q.filter((p) => p.owner !== 'main');
			});
			setCompacting(false);
			setBusy(false);
			if (redrawPendingRef.current) redrawHistory();
		}
	};

	const runPrompt = async (prompt: string) => {
		const agent = agentRef.current!;
		const outcome = await work(async (events, signal) => {
			const runs = await hookRuns('prompt_submit', { prompt }, { stopOnBlock: true });
			const blocked = runs.find((r) => r.exitCode === 2);
			if (blocked) {
				info(`A hook stopped this message from being sent: ${blockMessage(blocked)}`, 'warning');
				return 'blocked' as const;
			}
			for (const r of runs) {
				if (r.exitCode === 0 && r.stdout) {
					agent.hookContext.push(r.stdout);
					info(`Hook "${shortCommand(r.hook.command)}" added context to your message.`);
				}
			}
			return agent.run(prompt, events, signal);
		});
		if (outcome !== 'blocked') void fireHooks('turn_end', {});
		if (outcome === 'interrupted') flushLive(true);
		else if (outcome === 'too-many-bad-calls') {
			info(`Jane stopped: the model made ${MAX_BAD_CALLS} bad tool calls in a row. Try rephrasing, or check the model server.`, 'error');
		} else if (outcome === 'step-limit') info('Jane stopped after too many steps in one turn.', 'warning');
	};

	const runCommand = async (line: string) => {
		const [name = '', ...rest] = line.slice(1).trim().split(/\s+/);
		const arg = rest.join(' ');
		const agent = agentRef.current!;
		switch (name) {
			case 'clear':
				clearScreen();
				agentRef.current = null;
				setStaticKey((k) => k + 1);
				begin();
				return;
			case 'exit':
			case 'quit':
				quit();
				return;
			case 'help':
				info(HELP);
				return;
			case 'agents': {
				const all = helpersRef.current?.list ?? [];
				const [sub = '', target = ''] = arg.split(/\s+/);
				if (sub === 'stop') {
					if (helpersRef.current?.stop(Number(target))) info(`Stopping helper #${target}…`);
					else info(`There's no running helper #${target}.`, 'error');
					return;
				}
				if (!all.length) {
					info('No helpers yet. Jane starts them with her agent tool, e.g. when you ask her to research or review something in the background.');
					return;
				}
				if (sub) {
					const helper = all.find((h) => h.id === Number(sub));
					if (!helper) return info(`There's no helper #${sub}.`, 'error');
					const body = helper.state === 'running' ? `Still working: ${helper.activity || 'thinking'}` : reportText(helper);
					info(`Helper #${helper.id} "${helper.name}"\nTask: ${helper.task}\n\n${body}\n\nIts full conversation: ${tildify(helper.agent.session.file)}`);
					return;
				}
				const lines = all.map(
					(h) =>
						`  #${String(h.id).padEnd(3)} ${h.name.slice(0, 30).padEnd(31)} ${h.state.padEnd(8)} on ${h.host.name.padEnd(8)} ${String(h.toolCalls).padStart(3)} tool calls  ${helperSeconds(h)}s${h.background ? '  (background)' : ''}`,
				);
				info(`Helpers:\n${lines.join('\n')}\n\n/agents <id> shows a report, /agents stop <id> stops a running helper.`);
				return;
			}
			case 'mcp': {
				const manager = mcpRef.current;
				const [sub = '', target = ''] = arg.split(/\s+/);
				const project = Object.fromEntries(Object.entries(config.mcp).filter(([, s]) => s.source === 'project'));
				if (sub === 'allow') {
					if (!Object.keys(project).length) info('This project has no MCP servers of its own.');
					else if (manager && Object.keys(project).every((n) => manager.servers[n])) info("This project's MCP servers are already on.");
					else askFor({ kind: 'mcp', servers: project });
					return;
				}
				if (sub === 'restart') {
					if (!manager?.servers[target]) return info(`There is no MCP server called "${target}".`, 'error');
					mcpAnnounced.current.delete(target);
					info(`Restarting MCP server "${target}"…`);
					await manager.connectAll([target]);
					return;
				}
				if (!Object.keys(config.mcp).length) {
					info('No MCP servers yet. Add them as [mcp.<name>] in ~/.config/jane/config.toml; see the README.');
					return;
				}
				if (sub && manager?.servers[sub]) {
					const tools = manager.serverTools(sub);
					if (!tools.length) return info(`MCP server "${sub}" has no tools loaded (${describeMcpStatus(manager, sub)}).`);
					const lines = tools.map((t) => `  ${toolTitle(t.name).padEnd(36)} ${t.needsPermission ? '' : '(read-only) '}${t.description.split('\n')[0]!.slice(0, 80)}`);
					info(`Tools from "${sub}":\n${lines.join('\n')}`);
					return;
				}
				const lines = Object.entries(config.mcp).map(([name, s]) => {
					const where = s.command ? s.command.join(' ') : s.url!;
					const status = manager?.servers[name] ? describeMcpStatus(manager, name) : 'off: not allowed yet, /mcp allow';
					return `  ${name.padEnd(14)} ${s.source.padEnd(8)} ${status}\n      ${where}`;
				});
				info(`MCP servers:\n${lines.join('\n')}\n\n/mcp <name> lists a server's tools.`);
				return;
			}
			case 'hooks': {
				const projectHooks = config.hooks.filter((h) => h.source === 'project');
				if (arg === 'allow') {
					if (!projectHooks.length) info('This project has no hooks of its own.');
					else if (hooksRef.current.some((h) => h.source === 'project')) info("This project's hooks are already on.");
					else askFor({ kind: 'hooks', hooks: projectHooks });
					return;
				}
				if (!config.hooks.length) {
					info('No hooks yet. Add them as [[hooks]] in ~/.config/jane/config.toml; see the README for examples.');
					return;
				}
				const on = new Set(hooksRef.current);
				const lines = config.hooks.map((h) => {
					const state = on.has(h) ? '' : '  (off: not allowed yet, /hooks allow)';
					const tools = h.tools.length ? ` [${h.tools.join(', ')}]` : '';
					return `  ${h.event.padEnd(14)} ${h.source.padEnd(8)} ${h.command}${tools}${state}`;
				});
				info(`Hooks (event, from, command):\n${lines.join('\n')}`);
				return;
			}
			case 'compact': {
				if (agent.messages.length === 0) {
					info('Nothing to compact yet.');
					return;
				}
				await work((events, signal) => agent.compact(events, signal, { focus: arg }));
				return;
			}
			case 'host': {
				if (!arg) {
					await hosts.checkAll();
					rebuildSystem();
					const lines = hosts.hosts.map((h) => {
						const status = hosts.status.get(h.name);
						const state = h === hosts.current ? 'in use' : status?.ok ? 'reachable' : `not reachable: ${status && !status.ok ? status.reason : 'unknown'}`;
						return `  ${h === hosts.current ? '●' : ' '} ${h.name.padEnd(10)} ${describeHost(h).padEnd(36)} ${state}\n      ${h.baseUrl}`;
					});
					const more = multiHost ? 'Switch with /host <name>.' : 'Add other machines as [[hosts]] in ~/.config/jane/config.toml.';
					info(`Hosts, in order of preference:\n${lines.join('\n')}\n\n${more}`);
					return;
				}
				const target = hosts.find(arg);
				if (!target) {
					info(`There is no host called "${arg}". Hosts: ${hosts.hosts.map((h) => h.name).join(', ')}.`, 'error');
					return;
				}
				if (target === hosts.current) {
					info(`Already using ${target.name}.`);
					return;
				}
				const status = await probe(target);
				hosts.status.set(target.name, status);
				if (!status.ok) {
					info(`Can't switch to ${target.name}: ${status.reason} (${target.baseUrl}).`, 'error');
					return;
				}
				useHost(target);
				info(`Switched to ${target.name} (${describeHost(target)}).`);
				return;
			}
			case 'settings':
				setPanel('settings');
				return;
			case 'undo': {
				if (!agent.checkpoints) {
					info('Checkpoints are turned off (checkpoints.enabled = false), so there is nothing to undo.');
					return;
				}
				const changes = agent.checkpoints.list();
				if (changes.length === 0) {
					info("Nothing to undo in this session. (Changes made by bash commands can't be undone.)");
					return;
				}
				setUndoList(changes);
				return;
			}
			case 'permissions': {
				const next = arg ? arg : mode === 'always-ask' ? 'unrestricted' : 'always-ask';
				if (next !== 'always-ask' && next !== 'unrestricted') {
					info('Permission mode must be "always-ask" or "unrestricted".', 'error');
					return;
				}
				setMode(next);
				info(`Permission mode: ${next}`);
				return;
			}
			case 'model': {
				if (arg) {
					agent.settings.model = arg;
					agent.session.setModel(arg);
					hosts.current.model = arg;
					rebuildSystem();
					redrawSoon();
					setModel(arg);
					info(`Model: ${arg}`);
					return;
				}
				try {
					const models = await listModels({ baseUrl: hosts.current.baseUrl, apiKey: hosts.current.apiKey });
					const list = models.map((m) => (m === agent.settings.model ? `  ● ${m} (current)` : `    ${m}`)).join('\n');
					info(`Models on ${hosts.current.name} (${hosts.current.baseUrl}):\n${list}\n\nSwitch with /model <name>`);
				} catch (error) {
					info(`Current model: ${agent.settings.model}\n${(error as Error).message}`, 'error');
				}
				return;
			}
			case 'prompt': {
				if (arg === 'init') {
					const current = resolvePromptFile(config.prompt.file, cwd);
					if (current && fs.existsSync(current)) {
						info(`You already have a system prompt file: ${tildify(current)}. Edit it, and changes apply from your next message.`);
						return;
					}
					const file = path.join(configDir, 'system.md');
					let existed: boolean;
					try {
						existed = !initPromptFile(file).created;
						saveSetting('user', cwd, 'prompt.file', tildify(file));
					} catch (error) {
						info(`Couldn't set up ${tildify(file)}: ${(error as Error).message}`, 'error');
						return;
					}
					settingSaved('prompt.file');
					info(
						`${existed ? 'Found' : 'Created'} ${tildify(file)}${existed ? '' : ' with the built-in prompt in it'}, and set prompt.file to it. ` +
							'Edit it in any editor; changes apply from your next message. Jane still adds the environment, skills and JANE.md after it.' +
							(existed ? '' : ` (${path.basename(file)}.base next to it is the built-in text it started from; Jane uses it to tell you when her built-in prompt changes.)`),
					);
					return;
				}
				if (arg === 'diff') {
					const base = promptBaseRef.current;
					if (!base.file) {
						info("You're using the built-in prompt, so there's nothing to compare. /prompt init makes your own.");
						return;
					}
					const shown = tildify(base.file);
					const copy = readBaseCopy(base.file);
					const items: HistoryItem[] = [];
					if (copy !== undefined && builtinChangedSince(base.file)) {
						items.push({
							key: key(),
							kind: 'diff',
							title: `What changed in Jane's built-in prompt since you made ${shown}:`,
							lines: makeDiff(copy + '\n', DEFAULT_BASE + '\n'),
							note: "Copy over what you want; Jane won't mention these changes again.",
						});
						markBuiltinSeen(base.file);
					} else if (copy !== undefined) {
						items.push({ key: key(), kind: 'info', text: `Jane's built-in prompt hasn't changed since you made ${shown}.` });
					}
					items.push({
						key: key(),
						kind: 'diff',
						title: `Your prompt (${shown}) compared with Jane's built-in prompt (- built-in, + yours):`,
						lines: makeDiff(DEFAULT_BASE + '\n', base.text + '\n'),
					});
					push(...items);
					return;
				}
				if (arg) {
					info('Use /prompt to show the system prompt, /prompt init to make your own, or /prompt diff to compare it with the built-in one.', 'error');
					return;
				}
				const base = promptBaseRef.current;
				const parts = [
					base.file ? `your prompt from ${tildify(base.file)}` : 'the built-in prompt',
					'environment',
					...(skillsRef.current.some((s) => !s.userOnly) ? ['skills list'] : []),
					...instructionsRef.current.map((f) => tildify(f.path)),
				];
				info(`System prompt (about ${formatTokens(Math.ceil(agent.system.length / 4))} tokens): ${parts.join(' + ')}\n\n${agent.system}`);
				return;
			}
			case 'skills': {
				const skills = skillsRef.current;
				if (skills.length === 0) {
					info(`No skills found. Jane looks in: ${skillDirs(cwd, config.skills.sources, config.skills.extra_dirs).map((d) => tildify(d.dir)).join(', ')}`);
					return;
				}
				const where = (dir: string) => (dir.startsWith(cwd + path.sep) ? path.relative(cwd, dir) : tildify(dir));
				const lines = skills.map((s) => `  /${s.name.padEnd(18)} ${s.source}${s.userOnly ? ', only when you run it' : ''} · ${where(s.dir)}`);
				info(`Skills\n${lines.join('\n')}\n\nJane picks a skill when a task matches it, or run one with /<name> [request].`);
				return;
			}
			default: {
				const skill = skillsRef.current.find((s) => s.name === name);
				if (skill) {
					let content: string;
					try {
						content = skillContent(skill);
					} catch (error) {
						info(`Could not read ${skill.file}: ${(error as Error).message}`, 'error');
						return;
					}
					void runPrompt(skillMessage(skill, content, arg));
					return;
				}
				info(`Unknown command /${name}. Type /help to see the commands.`, 'error');
			}
		}
	};

	const submit = (text: string) => {
		setInput(ed.empty);
		const trimmed = text.trim();
		setPromptHistory((h) => (h.at(-1) === text ? h : [...h, text]));
		const command = /^\/([\w.:-]+)(\s|$)/.exec(trimmed)?.[1];
		// Only known commands and skills; anything else (like a path) is a normal prompt.
		if (command && (COMMANDS.some((c) => c.name === command) || ['quit'].includes(command) || skillsRef.current.some((s) => s.name === command))) {
			push({ key: key(), kind: 'user', text: trimmed });
			void runCommand(trimmed);
			return;
		}
		push({ key: key(), kind: 'user', text });
		void runPrompt(text);
	};

	/** Run the hooks for an event and tell the user about any that failed. */
	async function hookRuns(event: HookEvent, payload: HookPayload, options: { stopOnBlock?: boolean } = {}): Promise<HookRun[]> {
		const hooks = hooksRef.current;
		if (!hooks.some((h) => h.event === event)) return [];
		const runs = await runHooks(hooks, event, payload, { cwd, sessionId: agentRef.current?.session.id ?? '' }, options);
		for (const run of runs) {
			const problem = hookProblem(run);
			if (problem) info(problem, 'warning');
		}
		return runs;
	}

	/** Run hooks that only need to happen, without waiting for them (notifications and the like). */
	function fireHooks(event: HookEvent, payload: HookPayload): Promise<unknown> {
		return hookRuns(event, payload).catch((error) => log(`${event} hooks failed`, error));
	}

	function toolPayload(call: { name: string; args: Record<string, unknown> }): HookPayload {
		const file = typeof call.args['path'] === 'string' && ['read', 'write', 'edit'].includes(call.name) ? resolvePath(cwd, call.args['path']) : undefined;
		return { tool: call.name, args: call.args, file };
	}

	/** The user answered a question about what this project wants to run. */
	function decideTrust(allow: boolean) {
		const request = trustQueue[0];
		setTrustQueue((q) => q.slice(1));
		if (!request) return;
		if (request.kind === 'hooks') {
			const projectHooks = request.hooks;
			if (!allow) return info("This project's hooks are off for now. /hooks allow turns them on.");
			trust(cwd, projectHooks);
			hooksRef.current = [...hooksRef.current.filter((h) => h.source === 'user'), ...projectHooks];
			info(`Allowed ${projectHooks.length === 1 ? "this project's hook" : `this project's ${projectHooks.length} hooks`}. Jane asks again if they change.`);
			return;
		}
		const names = Object.keys(request.servers);
		if (!allow) return info("This project's MCP servers are off for now. /mcp allow turns them on.");
		trustPrint(cwd, 'mcp', mcpFingerprint(request.servers));
		info(`Allowed this project's MCP server${names.length === 1 ? '' : 's'} (${names.join(', ')}). Jane asks again if they change.`);
		void startMcp(request.servers);
	}

	/** Start (more) MCP servers in the background; their tools appear when they're ready. */
	async function startMcp(servers: Record<string, McpServerConfig>) {
		if (!Object.keys(servers).length) return;
		if (!mcpRef.current) mcpRef.current = new McpManager({}, cwd, mcpChanged);
		Object.assign(mcpRef.current.servers, servers);
		for (const [name, config] of Object.entries(servers)) mcpRef.current.status.set(name, config.enabled ? { state: 'connecting' } : { state: 'disabled' });
		await mcpRef.current.connectAll(Object.keys(servers));
	}

	/** An MCP server connected, failed or changed its tools: update Jane's tools and say what happened. */
	function mcpChanged() {
		refreshTools();
		const manager = mcpRef.current;
		if (!manager) return;
		for (const [name, status] of manager.status) {
			const text =
				status.state === 'connected'
					? `MCP server "${name}" is ready: ${status.tools} tool${status.tools === 1 ? '' : 's'} (about ${formatTokens(status.tokens)} tokens of context).`
					: status.state === 'failed'
						? `MCP server "${name}" isn't available: ${status.reason}. /mcp restart ${name} tries again.`
						: '';
			if (text && mcpAnnounced.current.get(name) !== text) {
				mcpAnnounced.current.set(name, text);
				info(text, status.state === 'failed' ? 'warning' : 'info');
			}
		}
	}

	/** The helper agents (made once, the first time they're needed). */
	function helpers(): Helpers {
		if (!helpersRef.current) {
			helpersRef.current = new Helpers(hosts, () => agentRef.current, helperSystem, {
				changed: () => setHelpersVersion((v) => v + 1),
				finished: (helper) => {
					if (!helper.background) return;
					agentRef.current?.helperReports.push(reportText(helper));
					const preview = helper.report ? `\n${helper.report.split('\n').slice(0, 4).join('\n')}` : helper.error ? `\n${helper.error}` : '';
					info(
						`Helper "${helper.name}" (#${helper.id}) ${helper.state === 'done' ? 'finished' : helper.state === 'stopped' ? 'was stopped' : 'failed'} on ${helper.host.name} after ${helperSeconds(helper)}s. ` +
							`Jane gets its report with your next message (/agents ${helper.id} shows it).${preview}`,
						helper.state === 'failed' ? 'warning' : 'info',
					);
				},
				askPermission: (helper, request) => {
					void fireHooks('waiting', { tool: request.tool.name });
					return askUser({ request, owner: 'helper', helper });
				},
				notice: info,
			});
		}
		return helpersRef.current;
	}

	/** A helper's system prompt: like the main one, but with its own host and the helper instructions. */
	function helperSystem(host: Host): string {
		const listed = skillsPrompt(skillsRef.current);
		return systemPrompt(cwd, instructionsRef.current, [hostsPromptSection(hosts, host), ...(listed ? [listed] : []), HELPER_INSTRUCTIONS], promptBaseRef.current.text);
	}

	/** Jane's tools: the built-in ones, the skill tool if there are skills, and connected MCP servers' tools. */
	function refreshTools() {
		const agent = agentRef.current;
		if (!agent) return;
		agent.tools = [
			...baseTools,
			makeAgentTool(helpers()),
			...webTools(webRef.current),
			...(skillsRef.current.some((s) => !s.userOnly) ? [makeSkillTool(() => skillsRef.current)] : []),
			...(mcpRef.current?.tools() ?? []),
		];
	}

	/** Put the system prompt back together from its parts: base, environment, skills, instruction files. */
	function rebuildSystem() {
		const agent = agentRef.current;
		if (!agent) return;
		const listed = skillsPrompt(skillsRef.current);
		agent.system = systemPrompt(cwd, instructionsRef.current, [hostsPromptSection(hosts), ...(listed ? [listed] : [])], promptBaseRef.current.text);
	}

	/** Read the custom prompt file again (or go back to the built-in prompt) and say what's in use. */
	function reloadPromptBase(setting: string) {
		promptSettingRef.current = setting;
		const base = loadPromptBase(setting, cwd);
		promptBaseRef.current = base;
		rebuildSystem();
		if (base.warning) info(base.warning, 'warning');
		else info(base.file ? `Using the system prompt from ${tildify(base.file)}` : 'Using the built-in system prompt.');
	}

	/** Point the agent at a host: its address, key, model and context size. */
	function useHost(host: Host) {
		const previous = hosts.current;
		hosts.current = host;
		const agent = agentRef.current;
		// Mid-conversation, the history may say otherwise ("I'm running on home"), so say it plainly.
		if (agent && previous !== host && agent.messages.length) {
			agent.notes.push(`This conversation moved from host "${previous.name}" to host "${host.name}": you are now ${host.model} with a ${Math.round(host.contextWindow / 1024)}k context.`);
		}
		if (agent) {
			agent.settings = { baseUrl: host.baseUrl, apiKey: host.apiKey, model: host.model };
			agent.contextWindow = host.contextWindow;
			if (agent.session) agent.session.setModel(host.model);
		}
		setModel(host.model);
		setHostName(host.name);
		setContextWindow(host.contextWindow);
		// Tell the model about the switch too.
		rebuildSystem();
		// The banner at the top is part of the printed history; print it again with the new host.
		if (previous !== host) redrawSoon();
	}

	/** The host stopped answering: switch to the next one that does (called by the agent). */
	async function failover(): Promise<boolean> {
		const failed = hosts.current;
		const next = await hosts.failover();
		if (!next) {
			info(`${failed.name} stopped answering, and no other host is reachable.`, 'error');
			return false;
		}
		useHost(next);
		info(`${failed.name} stopped answering, so Jane switched to ${next.name} (${describeHost(next)}).`, 'warning');
		return true;
	}

	// Every minute, see whether a host higher on the list is back, and say so once. Jane doesn't switch by itself.
	useEffect(() => {
		if (!multiHost) return;
		const timer = setInterval(async () => {
			if (busyRef.current || hosts.current === hosts.hosts[0]) return;
			const back = await hosts.preferredAvailable();
			if (back) info(`${back.name} is reachable again (${describeHost(back)}). Switch with /host ${back.name}.`);
		}, 60_000);
		return () => clearInterval(timer);
	}, []);

	/** Reload the config after /settings saved something, and apply what can change right away. */
	const settingSaved = (key: string) => {
		if (key === 'model.name') delete overridesRef.current.model;
		if (key === 'permissions.default_mode') delete overridesRef.current.mode;
		const next = applyOverrides(loadConfig(cwd).config, overridesRef.current);
		const agent = agentRef.current;
		// [model] is the local host: update it, and the agent too if local is in use.
		const local = hosts.find(LOCAL_HOST)!;
		local.baseUrl = next.model.base_url;
		local.apiKey = next.model.api_key || undefined;
		local.contextWindow = next.model.context_window;
		if (key === 'model.name') local.model = next.model.name;
		if (agent && hosts.current === local) useHost(local);
		if (agent) {
			agent.autoCompactPercent = next.compact.auto ? next.compact.at_percent : 0;
			if (key.startsWith('web.')) {
				webRef.current = next.web;
				refreshTools();
			}
			if (key === 'checkpoints.enabled') {
				agent.checkpoints = next.checkpoints.enabled ? new Checkpoints(agent.session.file.replace(/\.jsonl$/, '.checkpoints')) : undefined;
			}
			if (key.startsWith('block_list.')) {
				agent.blockRules = next.block_list.enabled ? compileBlockList(next.block_list.patterns).rules : [];
			}
			if (key === 'prompt.file') reloadPromptBase(next.prompt.file);
			if (key === 'instructions.filenames') {
				const instructions = loadInstructions(cwd, next.instructions.filenames);
				instructionsRef.current = instructions;
				rebuildSystem();
				info(
					instructions.length
						? `Now using ${instructions.map((f) => (path.dirname(f.path) === cwd ? path.basename(f.path) : tildify(f.path))).join(', ')}`
						: `No instruction file found (looked for ${next.instructions.filenames.join(', ')})`,
				);
			}
		}
		setConfig(next);
	};

	const undoFinished = (undone: Change[] | null, error?: string) => {
		setUndoList(null);
		if (error) return info(error, 'error');
		if (!undone) return;
		const cwdPath = (f: string) => (f.startsWith(cwd + path.sep) ? path.relative(cwd, f) : tildify(f));
		const what = undone.map((c) => `${toolTitle(c.tool)} ${c.files.map((f) => cwdPath(f.path)).join(', ')}`);
		info(`Undid ${undone.length === 1 ? 'a change' : `${undone.length} changes`}: ${what.join('; ')}`);
		const files = [...new Set(undone.flatMap((c) => c.files.map((f) => f.path)))];
		agentRef.current?.notes.push(
			`The user undid ${undone.length === 1 ? 'one of your file changes' : `${undone.length} of your file changes`} (${what.join('; ')}). ` +
				`These files are back to how they were before: ${files.join(', ')}. The user did this on purpose: do not redo these changes unless they ask you to. Read the files again before you change them.`,
		);
	};

	useInput((char, k) => {
		if (phase !== 'chat' || panel || undoList || askTrust) return;
		if (k.ctrl && char === 'c') {
			if (busy) {
				abortRef.current?.abort();
				permission?.resolve({ kind: 'no' });
				return;
			}
			if (input.text) {
				setInput(ed.empty);
				return;
			}
			if (Date.now() - exitArmedRef.current < 1500) return quit();
			exitArmedRef.current = Date.now();
			setHint('Press Ctrl+C again to exit');
			setTimeout(() => setHint(undefined), 1500);
			return;
		}
		if (k.escape && busy && !permission) {
			abortRef.current?.abort();
			return;
		}
		if (k.tab && k.shift && !permission) setMode(mode === 'always-ask' ? 'unrestricted' : 'always-ask');
	});

	const suggestions = useMemo(() => {
		const m = /^\/([\w.:-]*)$/.exec(input.text);
		if (!m) return [];
		const skills = skillsRef.current.map((s) => ({ name: s.name, description: s.description.length > 70 ? s.description.slice(0, 69) + '…' : s.description }));
		return [...COMMANDS, ...skills].filter((c) => c.name.startsWith(m[1]!)).slice(0, 8);
	}, [input.text]);

	if (phase === 'pick' && start.kind === 'pick') {
		return (
			<ResumePicker
				sessions={start.sessions}
				height={rows}
				width={columns}
				onPick={(session) => {
					clearScreen();
					setPhase('chat');
					begin(session ?? undefined);
				}}
			/>
		);
	}

	// Keep the live (redrawn) part of the screen shorter than the terminal, or it flickers.
	// Keep the live (redrawn) part shorter than the terminal, counting wrapped lines as the rows they take;
	// if it were taller, redrawing would leave copies of it in the scrollback.
	// Reserved: spinner (1), input box (3), status line (1), margins (3).
	const liveRoom = Math.max(4, rows - 8);
	const showThinking = busy && Boolean(live.reasoning.trim()) && config.ui.show_thinking !== 'hidden';
	const thinkingFull = showThinking && config.ui.show_thinking === 'full';
	const thinkingText = thinkingFull ? fitToRows(live.reasoning.trim(), columns - 3, Math.min(8, Math.floor(liveRoom / 2))) : live.reasoning;
	const thinkingRows = !showThinking ? 0 : thinkingFull ? 2 + rowsOf(thinkingText, columns - 3) : 1;
	const liveText = live.content.trim()
		? fitToRows(renderMarkdown(live.content, colors.assistant, colors.accent, columns - 3), columns - 3, Math.max(2, liveRoom - thinkingRows - 1))
		: '';
	const seconds = Math.round((Date.now() - startedAt) / 1000);
	const activity = compacting
		? 'Compacting conversation…'
		: running.length
			? `${toolTitle(running[0]!.name)}${running[0]!.label ? ` ${running[0]!.label}` : ''}`
			: live.reasoning && !live.content
				? 'Thinking…'
				: 'Working…';

	return (
		<Box flexDirection="column">
			<Static key={staticKey} items={items}>
				{(item) => {
					switch (item.kind) {
						case 'banner':
							return <Banner key={item.key} version={version} model={multiHost ? `${model} on ${hostName}` : model} cwd={cwd} />;
						case 'user':
							return <UserMessage key={item.key} text={item.text} />;
						case 'assistant':
							return <AssistantMessage key={item.key} text={item.text} width={columns} />;
						case 'thinking':
							return <Thinking key={item.key} text={item.text} mode={config.ui.show_thinking} seconds={item.seconds} />;
						case 'tool':
							return <ToolMessage key={item.key} name={item.name} label={item.label} result={item.result} />;
						case 'info':
							return <InfoMessage key={item.key} text={item.text} tone={item.tone} />;
						case 'diff':
							return <DiffMessage key={item.key} title={item.title} lines={item.lines} note={item.note} />;
					}
				}}
			</Static>

			{/* One column spare: symbols some terminals draw wider than expected can't push a line onto a second row,
			    which would make each redraw leave a row behind in the scrollback. */}
			<Box flexDirection="column" width={Math.max(20, columns - 1)}>

			{busy && live.reasoning && (
				<Thinking text={thinkingText} mode={config.ui.show_thinking} live />
			)}
			{busy && liveText && (
				<Box marginBottom={1}>
					<Text color={colors.accent}>● </Text>
					<Box flexShrink={1}>
						<Text>{liveText}</Text>
					</Box>
				</Box>
			)}
			{permission && (
				<PermissionPrompt
					key={permission.key}
					who={permission.helper ? `Helper "${permission.helper.name}" (#${permission.helper.id}, on ${permission.helper.host.name})` : undefined}
					request={permission.request}
					maxPreviewLines={Math.max(5, rows - 16)}
					onDecide={(decision) => {
						setPermissions((q) => q.slice(1));
						permission.resolve(decision);
					}}
				/>
			)}
			{busy && !permission && (
				<Box paddingX={1}>
					<Text color={colors.accent}>{SPINNER[tick % SPINNER.length]} </Text>
					<Text wrap="truncate-end">
						{activity} <Text dimColor>({seconds}s · esc to interrupt)</Text>
					</Text>
				</Box>
			)}
			{panel === 'settings' && (
				<SettingsMenu cwd={cwd} config={config} height={rows} onSaved={(s) => settingSaved(s.key)} onClose={() => setPanel(null)} />
			)}
			{askTrust && (
				<TrustPrompt
					key={askTrust.kind}
					title={askTrust.kind === 'hooks' ? 'This project wants to run its own hooks' : 'This project wants to start its own MCP servers'}
					project={tildify(cwd)}
					lines={
						askTrust.kind === 'hooks'
							? askTrust.hooks.map((h) => ({ label: h.event, command: (h.tools.length ? `[${h.tools.join(', ')}] ` : '') + h.command }))
							: Object.entries(askTrust.servers).map(([name, s]) => ({ label: name, command: s.command ? s.command.join(' ') : s.url! }))
					}
					onDecide={decideTrust}
				/>
			)}
			{undoList && agentRef.current?.checkpoints && (
				<UndoPicker changes={undoList} checkpoints={agentRef.current.checkpoints} cwd={cwd} height={rows} onDone={undoFinished} />
			)}
			{(helpersRef.current?.running() ?? []).map((h) => (
				<Box key={h.id} paddingX={1}>
					<Text dimColor wrap="truncate-end">
						↳ helper #{h.id} "{h.name}" on {h.host.name}
						{h.background ? ' (background)' : ''} · {h.activity || 'thinking'} · {helperSeconds(h)}s
					</Text>
				</Box>
			))}
			{!permission && !panel && !undoList && !askTrust && <Input
				value={input}
				onChange={setInput}
				onSubmit={submit}
				history={promptHistory}
				suggestions={suggestions}
				active={!busy && !permission}
				placeholder={busy ? '' : 'Ask Jane anything · /help for commands'}
			/>}
			<StatusLine mode={mode} model={model} host={multiHost ? hostName : undefined} tokens={tokens} contextWindow={contextWindow} hint={hint} />
			</Box>
		</Box>
	);
}
