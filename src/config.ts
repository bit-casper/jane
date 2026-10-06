import fs from 'node:fs';
import { parse } from 'smol-toml';
import { readOmarchyColors } from './omarchy.js';
import { DEFAULT_BLOCK_PATTERNS, compileBlockList } from './blocklist.js';
import { projectConfigFile, userConfigFile } from './paths.js';

export type PermissionMode = 'always-ask' | 'unrestricted';
export type ThinkingDisplay = 'full' | 'collapsed' | 'hidden';
export type ThemeSource = 'omarchy' | 'none';

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
	skills: {
		sources: ['jane', 'claude', 'omarchy'],
		extra_dirs: [],
	},
	checkpoints: {
		enabled: true,
	},
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
	for (const file of files) {
		let text: string;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		try {
			const fileWarnings: string[] = [];
			const data = parse(text) as Plain;
			merged = merge(merged, data, '', fileWarnings);
			const colors = isPlain(data['ui']) && isPlain(data['ui']['colors']) ? data['ui']['colors'] : {};
			for (const key of Object.keys(colors)) setColors.add(key);
			warnings.push(...fileWarnings.map((w) => `${file}: ${w}`));
		} catch (error) {
			warnings.push(`${file}: ${(error as Error).message.split('\n')[0]}`);
		}
	}
	const config = merged as unknown as Config;
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
