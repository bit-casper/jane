// The settings Jane's /settings menu shows, and how to check and save them.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { type Config, defaultConfig } from './config.js';
import { projectConfigFile, userConfigFile } from './paths.js';
import { getPath, setTomlValue } from './toml-edit.js';

export type SettingType = 'string' | 'secret' | 'number' | 'enum' | 'boolean' | 'list' | 'color' | 'readonly';

export type Setting = {
	/** Dotted path in the config, e.g. "ui.colors.user". */
	key: string;
	section: string;
	label: string;
	description: string;
	type: SettingType;
	options?: readonly string[];
	/** Shown after a change when it doesn't take effect right away. */
	appliesWhen?: string;
	/** For lists: an empty list is allowed. */
	allowEmpty?: boolean;
	/** For read-only lists: what one item is called ("pattern", "host"). */
	unit?: string;
	/** `r` can't reset it (resetting would throw away something the user wrote by hand). */
	noReset?: boolean;
};

export const COLOR_NAMES = [
	'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
	'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
] as const;

export const SETTINGS: Setting[] = [
	{ key: 'model.base_url', section: 'Model', label: 'Server URL', type: 'string', description: 'Address of the OpenAI-compatible model server, ending in /v1.' },
	{ key: 'model.name', section: 'Model', label: 'Model', type: 'string', description: 'Model name to ask the server for. /model changes it for one session only.' },
	{ key: 'model.context_window', section: 'Model', label: 'Context window', type: 'number', description: 'How many tokens the model can hold. Match the server (llama-server -c).' },
	{ key: 'compact.auto', section: 'Model', label: 'Auto compact', type: 'boolean', description: 'Summarise the conversation automatically when the context gets full, so long sessions keep working.' },
	{ key: 'compact.at_percent', section: 'Model', label: 'Compact at %', type: 'number', description: 'How full the context gets (10–95%) before Jane compacts automatically.' },
	{
		key: 'hosts', section: 'Model', label: 'Other hosts', type: 'readonly', unit: 'host', noReset: true,
		description: 'Other machines to use when they\'re reachable, like a stronger PC at home. Add them as [[hosts]] in the config file; /host shows and switches them.',
	},
	{ key: 'model.api_key', section: 'Model', label: 'API key', type: 'secret', description: 'Only needed for servers that require one. Leave empty for llama-server.' },
	{
		key: 'permissions.default_mode', section: 'Permissions', label: 'Default mode', type: 'enum', options: ['always-ask', 'unrestricted'],
		description: 'Mode for new sessions. always-ask asks before writing files or running commands; unrestricted never asks.',
		appliesWhen: 'new sessions',
	},
	{
		key: 'instructions.filenames', section: 'Instructions', label: 'File names', type: 'list',
		description: 'Instruction files to look for, in order; the first one found is used. Comma-separated, e.g. JANE.md, AGENTS.md, CLAUDE.md',
	},
	{
		key: 'prompt.file', section: 'Instructions', label: 'System prompt', type: 'string', allowEmpty: true,
		description: 'A file that replaces Jane\'s built-in instructions (who she is, how she works). Empty uses the built-in ones. /prompt shows the full prompt; /prompt init makes a file to start from.',
	},
	{ key: 'ui.show_thinking', section: 'Display', label: 'Show thinking', type: 'enum', options: ['collapsed', 'full', 'hidden'], description: 'How to show the model\'s thinking: one line, all of it, or not at all.' },
	{ key: 'ui.theme', section: 'Display', label: 'Theme', type: 'enum', options: ['omarchy', 'none'], description: 'omarchy: use the colours of your current Omarchy theme (colours you set below still win). none: only the colours below.' },
	{ key: 'ui.colors.user', section: 'Colours', label: 'Your messages', type: 'color', description: 'A colour name (cyan, magentaBright…) or hex (#88c0d0).' },
	{ key: 'ui.colors.assistant', section: 'Colours', label: 'Jane\'s replies', type: 'color', description: 'A colour name (cyan, magentaBright…) or hex (#88c0d0).' },
	{ key: 'ui.colors.thinking', section: 'Colours', label: 'Thinking', type: 'color', description: 'A colour name (cyan, magentaBright…) or hex (#88c0d0).' },
	{ key: 'ui.colors.accent', section: 'Colours', label: 'Accent', type: 'color', description: 'Banner, borders and highlights. A colour name or hex.' },
	{ key: 'ui.colors.diff_add', section: 'Colours', label: 'Added lines', type: 'color', description: 'Added lines in diffs. A colour name or hex.' },
	{ key: 'ui.colors.diff_remove', section: 'Colours', label: 'Removed lines', type: 'color', description: 'Removed lines in diffs, and errors. A colour name or hex.' },
	{
		key: 'skills.sources', section: 'Skills', label: 'Sources', type: 'list', allowEmpty: true, appliesWhen: 'new sessions (/clear)',
		description: 'Which skill folders to load, comma-separated: jane (~/.config/jane/skills, .jane/skills), claude (~/.claude/skills, .claude/skills), omarchy.',
	},
	{ key: 'skills.extra_dirs', section: 'Skills', label: 'Extra folders', type: 'list', allowEmpty: true, appliesWhen: 'new sessions (/clear)', description: 'More folders with skills in them, comma-separated.' },
	{ key: 'checkpoints.enabled', section: 'Safety', label: 'Undo copies', type: 'boolean', description: 'Save a copy of each file before Jane writes or edits it, so /undo can put it back.' },
	{ key: 'block_list.enabled', section: 'Safety', label: 'Block list', type: 'boolean', description: 'Refuse dangerous bash commands (rm -rf ~, mkfs, dd onto a disk…) in every permission mode.' },
	{ key: 'block_list.patterns', section: 'Safety', label: 'Block patterns', type: 'readonly', unit: 'pattern', description: 'The regular expressions for blocked commands. Edit them in the config file; r resets them to the built-in list.' },
];

export type Scope = 'user' | 'project';

export function scopeFile(scope: Scope, cwd: string): string {
	return scope === 'user' ? userConfigFile : projectConfigFile(cwd);
}

export function getValue(config: Config, key: string): unknown {
	return getPath(config as unknown as Record<string, unknown>, key.split('.'));
}

export function defaultValue(key: string): unknown {
	return getValue(defaultConfig, key);
}

/** Read a config file's raw data; missing means empty. Throws if it can't be parsed. */
export function readLayer(file: string): Record<string, unknown> {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return {};
	}
	return parse(text) as Record<string, unknown>;
}

/** Which file a setting's current value comes from. */
export function origin(key: string, layers: { user: Record<string, unknown>; project: Record<string, unknown> }): Scope | 'default' {
	const keys = key.split('.');
	if (getPath(layers.project, keys) !== undefined) return 'project';
	if (getPath(layers.user, keys) !== undefined) return 'user';
	return 'default';
}

/** Turn what the user typed into a setting value, or explain what's wrong. */
export function parseInput(setting: Setting, text: string): { value: unknown } | { error: string } {
	const raw = text.trim();
	switch (setting.type) {
		case 'number': {
			if (!/^\d+$/.test(raw) || Number(raw) <= 0) return { error: 'Enter a whole number above 0.' };
			if (setting.key === 'compact.at_percent' && (Number(raw) < 10 || Number(raw) > 95)) return { error: 'Enter a number from 10 to 95.' };
			return { value: Number(raw) };
		}
		case 'list': {
			const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
			if (items.length === 0 && !setting.allowEmpty) return { error: 'Enter at least one name.' };
			return { value: items };
		}
		case 'color': {
			if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) || (COLOR_NAMES as readonly string[]).includes(raw)) return { value: raw };
			return { error: `Use #rrggbb, or a colour name: ${COLOR_NAMES.filter((c) => c !== 'grey').join(', ')}.` };
		}
		case 'enum': {
			if (setting.options?.includes(raw)) return { value: raw };
			return { error: `Choose one of: ${setting.options?.join(', ')}.` };
		}
		case 'string': {
			if (setting.key === 'model.base_url' && !/^https?:\/\/\S+$/.test(raw)) return { error: 'Enter a URL starting with http:// or https://.' };
			if (!raw && !setting.allowEmpty) return { error: 'This can\'t be empty.' };
			return { value: raw };
		}
		case 'secret':
			return { value: raw };
		case 'boolean':
			if (raw === 'on' || raw === 'true') return { value: true };
			if (raw === 'off' || raw === 'false') return { value: false };
			return { error: 'Choose on or off.' };
		case 'readonly':
			return { error: 'Edit this one in the config file.' };
	}
}

/** How a value is shown in the menu, and pre-filled when editing. */
export function formatValue(setting: Setting, value: unknown, forEditing = false): string {
	if (setting.type === 'boolean') return value ? 'on' : 'off';
	if (setting.type === 'string' && value === '' && !forEditing) return '(built-in)';
	if (setting.type === 'readonly' && Array.isArray(value)) {
		const unit = setting.unit ?? 'item';
		return value.length === 0 ? 'none' : `${value.length} ${unit}${value.length === 1 ? '' : 's'}`;
	}
	if (setting.type === 'list') return (value as string[]).join(', ') || (forEditing ? '' : '(none)');
	if (setting.type === 'secret' && !forEditing) return value ? '•'.repeat(8) : '(none)';
	return String(value);
}

/** Save one setting to the user or project file. `undefined` removes it, going back to the default. */
export function saveSetting(scope: Scope, cwd: string, key: string, value: unknown): string {
	const file = scopeFile(scope, cwd);
	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {}
	let updated: string;
	try {
		updated = setTomlValue(text, key.split('.'), value);
	} catch (error) {
		throw new Error(`can't update ${file}: it isn't valid TOML (${(error as Error).message.split('\n')[0]}). Fix it by hand first.`);
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, updated);
	return file;
}
