import { Box, Text, useInput, usePaste } from 'ink';
import { useMemo, useState } from 'react';
import type { Config } from '../config.js';
import { tildify } from '../paths.js';
import {
	SETTINGS,
	type Scope,
	defaultValue,
	type Setting,
	formatValue,
	getValue,
	origin,
	parseInput,
	readLayer,
	saveSetting,
	scopeFile,
} from '../settings.js';
import * as ed from './editor.js';
import { useColors } from './theme.js';

type Props = {
	cwd: string;
	config: Config;
	height: number;
	/** Called after a setting is saved, so the app can reload the config. */
	onSaved(setting: Setting): void;
	onClose(): void;
};

type Status = { text: string; tone: 'info' | 'error' };

function loadLayers(cwd: string): { user: Record<string, unknown>; project: Record<string, unknown>; error?: string } {
	const out = { user: {}, project: {} } as { user: Record<string, unknown>; project: Record<string, unknown>; error?: string };
	for (const scope of ['user', 'project'] as const) {
		try {
			out[scope] = readLayer(scopeFile(scope, cwd));
		} catch (error) {
			out.error = `${tildify(scopeFile(scope, cwd))} isn't valid TOML: ${(error as Error).message.split('\n')[0]}`;
		}
	}
	return out;
}

export function SettingsMenu({ cwd, config, height, onSaved, onClose }: Props) {
	const colors = useColors();
	const [selected, setSelected] = useState(0);
	const [scope, setScope] = useState<Scope>('user');
	const [editing, setEditing] = useState<ed.EditorState | null>(null);
	const [status, setStatus] = useState<Status | null>(null);
	const [version, setVersion] = useState(0);
	const layers = useMemo(() => loadLayers(cwd), [cwd, version]);
	const setting = SETTINGS[selected]!;
	const choice = setting.type === 'enum' || setting.type === 'boolean';

	const save = (value: unknown) => {
		try {
			const file = saveSetting(scope, cwd, setting.key, value);
			setVersion((v) => v + 1);
			onSaved(setting);
			const what = value === undefined ? `Reset ${setting.label}` : `Saved ${setting.label}`;
			const when = setting.appliesWhen ? ` (applies to ${setting.appliesWhen})` : '';
			setStatus({ text: `${what} in ${tildify(file)}${when}`, tone: 'info' });
		} catch (error) {
			setStatus({ text: (error as Error).message, tone: 'error' });
		}
	};

	const cycle = (direction: 1 | -1) => {
		if (setting.type === 'boolean') return save(!getValue(config, setting.key));
		const options = setting.options!;
		const current = options.indexOf(String(getValue(config, setting.key)));
		save(options[(current + direction + options.length) % options.length]);
	};

	const submit = (text: string) => {
		const parsed = parseInput(setting, text);
		if ('error' in parsed) {
			setEditing({ text, cursor: text.length });
			return setStatus({ text: parsed.error, tone: 'error' });
		}
		setEditing(null);
		save(parsed.value);
	};

	usePaste((text) => setEditing((e) => (e ? ed.insert(e, text.replace(/\s*\n\s*/g, ' ')) : e)), { isActive: editing !== null });

	useInput((input, key) => {
		if (editing) {
			if (key.escape) {
				setEditing(null);
				setStatus(null);
			} else if (key.return) {
				submit(editing.text);
			} else if (input.includes('\r') && !key.ctrl && !key.meta) {
				// Text and Enter arrived in one chunk (dictation, fast typing).
				submit(ed.insert(editing, input.split('\r')[0]!).text);
			} else if (key.leftArrow) setEditing(ed.left(editing));
			else if (key.rightArrow) setEditing(ed.right(editing));
			else if (key.home || (key.ctrl && input === 'a')) setEditing(ed.home(editing));
			else if (key.end || (key.ctrl && input === 'e')) setEditing(ed.end(editing));
			else if (key.backspace) setEditing(ed.backspace(editing));
			else if (key.delete) setEditing(ed.deleteForward(editing));
			else if (key.ctrl && input === 'u') setEditing(ed.killToLineStart(editing));
			else if (input && !key.ctrl && !key.meta) setEditing(ed.insert(editing, input.replace(/[\r\n]/g, '')));
			return;
		}
		if (key.escape || (key.ctrl && input === 'c')) return onClose();
		if (key.upArrow) setSelected((s) => (s + SETTINGS.length - 1) % SETTINGS.length);
		else if (key.downArrow) setSelected((s) => (s + 1) % SETTINGS.length);
		else if (key.tab) setScope((s) => (s === 'user' ? 'project' : 'user'));
		else if (choice && (key.return || input === ' ' || key.rightArrow)) cycle(1);
		else if (choice && key.leftArrow) cycle(-1);
		else if (key.return && setting.type === 'readonly') {
			setStatus({ text: `Edit ${setting.label} in ${tildify(scopeFile(scope, cwd))}`, tone: 'info' });
		} else if (key.return) {
			const text = formatValue(setting, getValue(config, setting.key), true);
			setEditing({ text, cursor: text.length });
			setStatus(null);
		} else if ((key.backspace || key.delete || input === 'r') && setting.noReset) {
			setStatus({ text: `${setting.label} can only be changed in ${tildify(scopeFile(scope, cwd))}`, tone: 'info' });
		} else if (key.backspace || key.delete || input === 'r') {
			if (origin(setting.key, { user: scope === 'user' ? layers.user : {}, project: scope === 'project' ? layers.project : {} }) === 'default') {
				setStatus({ text: `${setting.label} isn't set in the ${scope} file`, tone: 'info' });
			} else save(undefined);
		}
	});

	// Lay out section headings and settings, then show the part around the selection.
	const lines: ({ kind: 'section'; title: string } | { kind: 'setting'; index: number })[] = [];
	SETTINGS.forEach((s, index) => {
		if (index === 0 || SETTINGS[index - 1]!.section !== s.section) lines.push({ kind: 'section', title: s.section });
		lines.push({ kind: 'setting', index });
	});
	const room = Math.max(5, height - 14);
	const at = lines.findIndex((l) => l.kind === 'setting' && l.index === selected);
	const top = Math.min(Math.max(0, at - Math.floor(room / 2)), Math.max(0, lines.length - room));
	const from = origin(setting.key, layers);
	const overridden = scope === 'user' && from === 'project';

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
			<Text bold color={colors.accent}>
				Settings
			</Text>
			<Text>
				Saving to:{' '}
				{(['user', 'project'] as const).map((s) => (
					<Text key={s}>
						<Text inverse={scope === s} color={scope === s ? colors.accent : undefined} dimColor={scope !== s}>
							{' '}
							{s === 'user' ? 'User' : 'Project'}{' '}
						</Text>{' '}
					</Text>
				))}
				<Text dimColor>{tildify(scopeFile(scope, cwd))}</Text>
			</Text>
			{layers.error && <Text color={colors.diff_remove}>{layers.error}</Text>}
			<Box flexDirection="column" marginY={1}>
				{lines.slice(top, top + room).map((line, i) => {
					if (line.kind === 'section') {
						return (
							<Text key={`s${i}`} bold dimColor>
								{line.title}
							</Text>
						);
					}
					const s = SETTINGS[line.index]!;
					const active = line.index === selected;
					const value = getValue(config, s.key);
					const source = origin(s.key, layers);
					return (
						<Text key={s.key} wrap="truncate-end">
							<Text color={active ? colors.accent : undefined}>
								{active ? '❯ ' : '  '}
								{s.label.padEnd(16)}
							</Text>
							{active && editing ? (
								<Text>
									{editing.text.slice(0, editing.cursor)}
									<Text inverse>{editing.text[editing.cursor] ?? ' '}</Text>
									{editing.text.slice(editing.cursor + 1)}
								</Text>
							) : (
								<Text>
									{s.type === 'color' && <Text color={String(value)}>■ </Text>}
									{(s.type === 'enum' || s.type === 'boolean') && active ? `‹ ${formatValue(s, value)} ›` : formatValue(s, value)}
									<Text dimColor>
										{source !== 'default' ? `  (${source})` : s.type === 'color' && value !== defaultValue(s.key) ? '  (theme)' : ''}
									</Text>
								</Text>
							)}
						</Text>
					);
				})}
			</Box>
			<Text dimColor wrap="wrap">
				{setting.description}
			</Text>
			{overridden && <Text color="yellow">The project file overrides this. Switch to Project (Tab) to change what's used here.</Text>}
			{status && <Text color={status.tone === 'error' ? colors.diff_remove : colors.diff_add}>{status.text}</Text>}
			<Text dimColor>
				{editing
					? 'Enter to save · Esc to cancel'
					: `↑/↓ move · ${choice ? '←/→ change' : setting.type === 'readonly' ? 'edit in the config file' : 'Enter edit'} · Tab user/project${setting.noReset ? '' : ' · r reset'} · Esc close`}
			</Text>
		</Box>
	);
}
