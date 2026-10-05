import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { Change, Checkpoints } from '../checkpoints.js';
import { tildify } from '../paths.js';
import { displayPath } from '../tools/types.js';
import { toolTitle } from './History.js';
import { ago } from './ResumePicker.js';
import { useColors } from './theme.js';

type Props = {
	changes: Change[];
	checkpoints: Checkpoints;
	cwd: string;
	height: number;
	onDone(undone: Change[] | null, error?: string): void;
};

/** Pick a change to undo. Undoing it also undoes every newer change. */
export function UndoPicker({ changes, checkpoints, cwd, height, onDone }: Props) {
	const colors = useColors();
	const [selected, setSelected] = useState(0);
	const [confirm, setConfirm] = useState<string[] | null>(null);
	const chosen = changes.slice(0, selected + 1);
	const shown = (file: string) => {
		const rel = displayPath(cwd, file);
		return rel === file ? tildify(file) : rel;
	};

	const perform = () => {
		try {
			checkpoints.undo(chosen);
			onDone(chosen);
		} catch (error) {
			onDone(null, `Undo failed: ${(error as Error).message}`);
		}
	};

	useInput((input, key) => {
		if (confirm) {
			if (input === 'y' || input === 'Y') perform();
			else if (input === 'n' || input === 'N' || key.escape) setConfirm(null);
			return;
		}
		if (key.escape || (key.ctrl && input === 'c')) return onDone(null);
		if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
		else if (key.downArrow) setSelected((s) => Math.min(changes.length - 1, s + 1));
		else if (key.return) {
			const changed = checkpoints.changedSince(chosen);
			if (changed.length) setConfirm(changed);
			else perform();
		}
	});

	const room = Math.max(3, height - 12);
	const top = Math.min(Math.max(0, selected - Math.floor(room / 2)), Math.max(0, changes.length - room));
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
			<Text bold color={colors.accent}>
				Undo
			</Text>
			<Text dimColor>Undoing a change also undoes every change after it. Changes made by bash commands can't be undone.</Text>
			<Box flexDirection="column" marginY={1}>
				{changes.slice(top, top + room).map((change, i) => {
					const index = top + i;
					const included = index <= selected;
					const files = change.files.map((f) => shown(f.path)).join(', ');
					return (
						<Text key={change.id} wrap="truncate-end" color={included ? colors.accent : undefined}>
							{index === selected ? '❯ ' : included ? '│ ' : '  '}
							<Text dimColor={!included}>{ago(new Date(change.time)).padEnd(11)} </Text>
							<Text bold={included}>{toolTitle(change.tool)}</Text>({files})
							<Text dimColor>{change.prompt ? `  "${change.prompt.replace(/\s+/g, ' ').slice(0, 60)}"` : ''}</Text>
						</Text>
					);
				})}
			</Box>
			{confirm ? (
				<Box flexDirection="column">
					<Text color="yellow">
						{confirm.length === 1 ? 'This file was' : 'These files were'} changed after Jane changed {confirm.length === 1 ? 'it' : 'them'}, and
						undoing will lose those changes:
					</Text>
					{confirm.map((f) => (
						<Text key={f} color="yellow">
							{'  '}
							{shown(f)}
						</Text>
					))}
					<Text>Undo anyway? (y/n)</Text>
				</Box>
			) : (
				<Text dimColor>
					↑/↓ choose · Enter to undo {chosen.length === 1 ? 'this change' : `these ${chosen.length} changes`} · Esc to cancel
				</Text>
			)}
		</Box>
	);
}
