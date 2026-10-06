import fs from 'node:fs';
import { parse } from 'smol-toml';
import { HOOK_EVENTS, type Hook, type HookEvent } from './hooks.js';
import type { McpServerConfig } from './mcp.js';
import { readOmarchyColors } from './omarchy.js';
import { DEFAULT_BLOCK_PATTERNS, compileBlockList } from './blocklist.js';
import { projectConfigFile, userConfigFile } from './paths.js';

export type PermissionMode = 'always-ask' | 'unrestricted';
export type ThinkingDisplay = 'full' | 'collapsed' | 'hidden';
export type ThemeSource = 'omarchy' | 'none';

export type HostConfig = {
	name: string;
	base_url: string;
	model: string;
	context_window: number;
	api_key: string;
};

export type Config = {
	model: {
		base_url: string;
		name: string;
		context_window: number;
		api_key: string;
	};
	permissions: {
		default_mode: PermissionMode;
	};
	instructions: {
		filenames: string[];
	};
	prompt: {
		/** A file that replaces Jane's built-in instructions. Empty = built-in. */
		file: string;
	};
	skills: {
		/** Which kinds of skill folders to load: "jane", "claude", "omarchy". */
		sources: string[];
		/** More folders with skills in them. */
		extra_dirs: string[];
	};
	checkpoints: {
		/** Save a copy of each file before Jane changes it, for /undo. */
		enabled: boolean;
	};
	compact: {
		/** Compact the conversation automatically when the context fills up. */
		auto: boolean;
		/** How full the context gets (percent) before compacting automatically. */
		at_percent: number;
	};
	/** Other machines to use instead of [model] when they're reachable, in order of preference. */
	hosts: HostConfig[];
	/** Commands Jane runs at certain moments. From the user config and, once allowed, the project's. */
	hooks: Hook[];
	/** MCP servers by name. From the user config and, once allowed, the project's. */
	mcp: Record<string, McpServerConfig>;
	block_list: {
		/** Refuse bash commands matching these patterns, in every permission mode. */
		enabled: boolean;
		/** Regular expressions. */
		patterns: string[];
	};
	ui: {
		show_thinking: ThinkingDisplay;
		/** Where colours come from when the config doesn't set them. */
		theme: ThemeSource;
		colors: {
			user: string;
			assistant: string;
			thinking: string;
			accent: string;
			diff_add: string;
			diff_remove: string;
		};
	};
};

export const defaultConfig: Config = {
	model: {
		base_url: 'http://127.0.0.1:8080/v1',
		name: 'qwen3.6-abliterated',
		context_window: 65536,
		api_key: '',
	},
	permissions: {
		default_mode: 'always-ask',
	},
	instructions: {
		filenames: ['JANE.md'],
	},
	prompt: {
		file: '',
	},
	skills: {
		sources: ['jane', 'claude', 'omarchy'],
		extra_dirs: [],
	},
	checkpoints: {
		enabled: true,
	},
	compact: {
		auto: true,
		at_percent: 80,
	},
	hosts: [],
	hooks: [],
	mcp: {},
	block_list: {
		enabled: true,
		patterns: DEFAULT_BLOCK_PATTERNS,
	},
	ui: {
		show_thinking: 'collapsed',
		theme: 'omarchy',
		colors: {
			user: 'cyan',
			assistant: 'white',
			thinking: 'gray',
			accent: 'magenta',
			diff_add: 'green',
			diff_remove: 'red',
		},
	},
};

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `override` onto `base`. Only keys that exist in `base` are taken,
 * and only when the type matches, so a typo or wrong type in a config file is
 * reported instead of silently breaking Jane.
 */
function merge(base: Plain, override: Plain, where: string, warnings: string[]): Plain {
	const out: Plain = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const name = where ? `${where}.${key}` : key;
		if (!(key in base)) {
			warnings.push(`unknown setting "${name}"`);
			continue;
		}
		const current = base[key];
		if (isPlain(current)) {
			if (isPlain(value)) out[key] = merge(current, value, name, warnings);
			else warnings.push(`"${name}" should be a table`);
		} else if (name === 'hosts') {
			out[key] = parseHosts(value, warnings);
		} else if (Array.isArray(current)) {
			if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value;
			else warnings.push(`"${name}" should be a list of strings`);
		} else if (typeof value === typeof current) {
			out[key] = value;
		} else {
			warnings.push(`"${name}" should be a ${typeof current}`);
		}
	}
	return out;
}

/** Check [mcp.<name>] sections and add them to `into`; broken ones are skipped with a warning. */
function parseMcp(value: unknown, source: McpServerConfig['source'], into: Record<string, McpServerConfig>, warnings: string[]): void {
	if (!isPlain(value)) {
		warnings.push('"mcp" should hold [mcp.<name>] sections');
		return;
	}
	const strings = (v: unknown) => isPlain(v) && Object.values(v).every((x) => typeof x === 'string');
	for (const [name, entry] of Object.entries(value)) {
		const where = `mcp.${name}`;
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
			warnings.push(`${where} was skipped: server names can only use letters, digits, - and _`);
			continue;
		}
		if (!isPlain(entry)) {
			warnings.push(`${where} should be a table`);
			continue;
		}
		if (into[name]) {
			// A project can't replace one of your servers with its own command under the same name.
			warnings.push(`${where} is already defined in your user config, so the project's one was skipped`);
			continue;
		}
		const { command, url, env = {}, headers = {}, tools = [], enabled = true, timeout = 120 } = entry;
		const problems: string[] = [];
		const hasCommand = Array.isArray(command) && command.length > 0 && command.every((c) => typeof c === 'string');
		const hasUrl = typeof url === 'string' && /^https?:\/\/\S+$/.test(url);
		if (hasCommand === hasUrl) problems.push('either command (a list, e.g. ["npx", "some-server"]) or url (http://…), not both');
		if (!strings(env)) problems.push('env (a table of strings)');
		if (!strings(headers)) problems.push('headers (a table of strings)');
		if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string')) problems.push('tools (a list of tool names)');
		if (typeof enabled !== 'boolean') problems.push('enabled (true or false)');
		if (typeof timeout !== 'number' || timeout <= 0) problems.push('timeout (seconds)');
		for (const key of Object.keys(entry)) {
			if (!['command', 'url', 'env', 'headers', 'tools', 'enabled', 'timeout'].includes(key)) warnings.push(`${where}: unknown setting "${key}"`);
		}
		if (problems.length) {
			warnings.push(`${where} was skipped: it needs ${problems.join('; ')}`);
			continue;
		}
		into[name] = {
			...(hasCommand ? { command: command as string[] } : { url: url as string }),
			env: env as Record<string, string>,
			headers: headers as Record<string, string>,
			tools: tools as string[],
			enabled: enabled as boolean,
			timeout: timeout as number,
			source,
		};
	}
}

/** Check [[hooks]] entries; broken ones are skipped with a warning. */
function parseHooks(value: unknown, source: Hook['source'], warnings: string[]): Hook[] {
	if (!Array.isArray(value)) {
		warnings.push('"hooks" should be a list of [[hooks]] tables');
		return [];
	}
	const hooks: Hook[] = [];
	value.forEach((entry, i) => {
		const where = `hooks #${i + 1}`;
		if (!isPlain(entry)) return warnings.push(`${where} should be a table`);
		const { event, command, tools = [], timeout = 60 } = entry as Record<string, unknown>;
		const problems: string[] = [];
		if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) problems.push(`event (one of ${HOOK_EVENTS.join(', ')})`);
		if (typeof command !== 'string' || !command.trim()) problems.push('command');
		if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string')) problems.push('tools (a list of tool names)');
		if (typeof timeout !== 'number' || timeout <= 0) problems.push('timeout (seconds)');
		for (const key of Object.keys(entry)) {
			if (!['event', 'command', 'tools', 'timeout'].includes(key)) warnings.push(`${where}: unknown setting "${key}"`);
		}
		if (problems.length) return warnings.push(`${where} was skipped: it needs ${problems.join(', ')}`);
		hooks.push({ event: event as HookEvent, command: command as string, tools: tools as string[], timeout: timeout as number, source });
	});
	return hooks;
}

/** Check [[hosts]] entries; broken ones are skipped with a warning. */
function parseHosts(value: unknown, warnings: string[]): HostConfig[] {
	if (!Array.isArray(value)) {
		warnings.push('"hosts" should be a list of [[hosts]] tables');
		return [];
	}
	const hosts: HostConfig[] = [];
	value.forEach((entry, i) => {
		const where = `hosts #${i + 1}`;
		if (!isPlain(entry)) return warnings.push(`${where} should be a table`);
		const { name, base_url, model, context_window = 65536, api_key = '' } = entry as Record<string, unknown>;
		const problems: string[] = [];
		if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) problems.push('name (letters, digits, - _ .)');
		else if (name === 'local') problems.push('a name other than "local" (that\'s [model])');
		else if (hosts.some((h) => h.name === name)) problems.push('a unique name');
		if (typeof base_url !== 'string' || !/^https?:\/\/\S+$/.test(base_url)) problems.push('base_url (http://…/v1)');
		if (typeof model !== 'string' || !model) problems.push('model');
		if (typeof context_window !== 'number' || !Number.isInteger(context_window) || context_window <= 0) problems.push('context_window (a whole number)');
		if (typeof api_key !== 'string') problems.push('api_key (a string)');
		for (const key of Object.keys(entry)) {
			if (!['name', 'base_url', 'model', 'context_window', 'api_key'].includes(key)) warnings.push(`${where}: unknown setting "${key}"`);
		}
		if (problems.length) return warnings.push(`${where} was skipped: it needs ${problems.join(', ')}`);
		hosts.push({
			name: name as string,
			base_url: (base_url as string).replace(/\/+$/, ''),
			model: model as string,
			context_window: context_window as number,
			api_key: api_key as string,
		});
	});
	return hosts;
}

function validate(config: Config, warnings: string[]): void {
	if (!['always-ask', 'unrestricted'].includes(config.permissions.default_mode)) {
		warnings.push(`permissions.default_mode must be "always-ask" or "unrestricted"`);
		config.permissions.default_mode = defaultConfig.permissions.default_mode;
	}
	if (!['full', 'collapsed', 'hidden'].includes(config.ui.show_thinking)) {
		warnings.push(`ui.show_thinking must be "full", "collapsed" or "hidden"`);
		config.ui.show_thinking = defaultConfig.ui.show_thinking;
	}
	if (!['omarchy', 'none'].includes(config.ui.theme)) {
		warnings.push(`ui.theme must be "omarchy" or "none"`);
		config.ui.theme = defaultConfig.ui.theme;
	}
	const unknownSources = config.skills.sources.filter((s) => !['jane', 'claude', 'omarchy'].includes(s));
	if (unknownSources.length) {
		warnings.push(`skills.sources can only contain "jane", "claude" and "omarchy" (not ${unknownSources.map((s) => `"${s}"`).join(', ')})`);
		config.skills.sources = config.skills.sources.filter((s) => !unknownSources.includes(s));
	}
	if (config.block_list.enabled) warnings.push(...compileBlockList(config.block_list.patterns).warnings);
	if (!(config.compact.at_percent >= 10 && config.compact.at_percent <= 95)) {
		warnings.push('compact.at_percent must be between 10 and 95');
		config.compact.at_percent = defaultConfig.compact.at_percent;
	}
	if (config.instructions.filenames.length === 0) {
		config.instructions.filenames = defaultConfig.instructions.filenames;
	}
	config.model.base_url = config.model.base_url.replace(/\/+$/, '');
}

export type LoadedConfig = {
	config: Config;
	warnings: string[];
	/** Colours that came from the Omarchy theme rather than a config file or the defaults. */
	themed: (keyof Config['ui']['colors'])[];
};

/**
 * Load defaults, then the user config, then the project config on top. With
 * `ui.theme = "omarchy"`, colours not set in a config file come from the
 * active Omarchy theme.
 */
export function loadConfig(
	cwd: string,
	files = [userConfigFile, projectConfigFile(cwd)],
	themeColors: () => Partial<Config['ui']['colors']> | undefined = readOmarchyColors,
): LoadedConfig {
	const warnings: string[] = [];
	const setColors = new Set<string>();
	let merged: Plain = structuredClone(defaultConfig) as unknown as Plain;
	const hooks: Hook[] = [];
	const mcp: Record<string, McpServerConfig> = {};
	for (const [index, file] of files.entries()) {
		let text: string;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		try {
			const fileWarnings: string[] = [];
			const data = parse(text) as Plain;
			// Hooks add up (user's first, then the project's) instead of the project replacing them.
			if ('hooks' in data) {
				hooks.push(...parseHooks(data['hooks'], index === 0 ? 'user' : 'project', fileWarnings));
				delete data['hooks'];
			}
			if ('mcp' in data) {
				parseMcp(data['mcp'], index === 0 ? 'user' : 'project', mcp, fileWarnings);
				delete data['mcp'];
			}
			merged = merge(merged, data, '', fileWarnings);
			const colors = isPlain(data['ui']) && isPlain(data['ui']['colors']) ? data['ui']['colors'] : {};
			for (const key of Object.keys(colors)) setColors.add(key);
			warnings.push(...fileWarnings.map((w) => `${file}: ${w}`));
		} catch (error) {
			warnings.push(`${file}: ${(error as Error).message.split('\n')[0]}`);
		}
	}
	const config = merged as unknown as Config;
	config.hooks = hooks;
	config.mcp = mcp;
	validate(config, warnings);
	const themed: LoadedConfig['themed'] = [];
	if (config.ui.theme === 'omarchy') {
		const theme = themeColors() ?? {};
		for (const [key, value] of Object.entries(theme) as [keyof Config['ui']['colors'], string][]) {
			if (setColors.has(key)) continue;
			config.ui.colors[key] = value;
			themed.push(key);
		}
	}
	return { config, warnings, themed };
}
