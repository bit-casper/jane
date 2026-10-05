import { Box, Text, useInput, usePaste } from 'ink';
import { useRef } from 'react';
import * as ed from './editor.js';
import { useColors } from './theme.js';

export type Suggestion = { name: string; description: string };

type Props = {
	value: ed.EditorState;
	onChange(value: ed.EditorState): void;
	onSubmit(text: string): void;
	history: string[];
	suggestions: Suggestion[];
	active: boolean;
	placeholder?: string;
};

export function Input({ value, onChange, onSubmit, history, suggestions, active, placeholder }: Props) {
	const colors = useColors();
	// Position while browsing history; history.length means "not browsing".
	const historyIndex = useRef(history.length);
	const draft = useRef('');

	const setText = (text: string) => onChange({ text, cursor: text.length });

	usePaste(
		(text) => {
			onChange(ed.insert(value, text));
		},
		{ isActive: active },
	);

	useInput(
		(input, key) => {
			// Handled by the app: Ctrl+C, Escape, Shift+Tab.
			if ((key.ctrl && input === 'c') || key.escape || (key.tab && key.shift)) return;

			if (key.return) {
				if (key.shift || key.meta) return onChange(ed.insert(value, '\n'));
				if (value.text[value.cursor - 1] === '\\') {
					return onChange(ed.insert(ed.backspace(value), '\n'));
				}
				const text = value.text;
				if (!text.trim()) return;
				historyIndex.current = history.length + 1;
				draft.current = '';
				onSubmit(text);
				return;
			}
			if (key.tab) {
				const first = suggestions[0];
				if (first) setText(`/${first.name} `);
				return;
			}
			if (key.upArrow) {
				if (!ed.isOnFirstLine(value)) return onChange(ed.vertical(value, -1));
				if (historyIndex.current > history.length) historyIndex.current = history.length;
				if (historyIndex.current === 0) return;
				if (historyIndex.current === history.length) draft.current = value.text;
				historyIndex.current--;
				return setText(history[historyIndex.current] ?? '');
			}
			if (key.downArrow) {
				if (!ed.isOnLastLine(value)) return onChange(ed.vertical(value, 1));
				if (historyIndex.current >= history.length) return;
				historyIndex.current++;
				return setText(historyIndex.current === history.length ? draft.current : (history[historyIndex.current] ?? ''));
			}
			if (key.leftArrow) return onChange(ed.left(value));
			if (key.rightArrow) return onChange(ed.right(value));
			if (key.home || (key.ctrl && input === 'a')) return onChange(ed.home(value));
			if (key.end || (key.ctrl && input === 'e')) return onChange(ed.end(value));
			if (key.backspace) return onChange(key.meta ? ed.deleteWordBack(value) : ed.backspace(value));
			if (key.delete || (key.ctrl && input === 'd')) return onChange(ed.deleteForward(value));
			if (key.ctrl && input === 'u') return onChange(ed.killToLineStart(value));
			if (key.ctrl && input === 'k') return onChange(ed.killToLineEnd(value));
			if (key.ctrl && input === 'w') return onChange(ed.deleteWordBack(value));
			if (key.ctrl && input === 'j') return onChange(ed.insert(value, '\n'));
			if (key.ctrl || key.meta || !input) return;
			// Typed text and Enter can arrive in one chunk (fast typists, dictation, tmux).
			if (input.length > 1 && input.endsWith('\r') && !input.slice(0, -1).includes('\r')) {
				const next = ed.insert(value, input.slice(0, -1));
				if (!next.text.trim()) return onChange(next);
				onChange(ed.empty);
				historyIndex.current = history.length + 1;
				draft.current = '';
				onSubmit(next.text);
				return;
			}
			onChange(ed.insert(value, input));
		},
		{ isActive: active },
	);

	const lines = value.text.split('\n');
	let offset = 0;
	return (
		<Box flexDirection="column">
			<Box borderStyle="round" borderColor={active ? colors.accent : 'gray'} borderDimColor={!active} paddingX={1} flexDirection="column">
				{value.text === '' ? (
					<Text>
						<Text color={colors.user}>› </Text>
						{active ? <Text inverse> </Text> : null}
						<Text dimColor>{placeholder}</Text>
					</Text>
				) : (
					lines.map((line, i) => {
						const start = offset;
						offset += line.length + 1;
						const prefix = <Text color={colors.user}>{i === 0 ? '› ' : '  '}</Text>;
						const hasCursor = active && value.cursor >= start && value.cursor <= start + line.length;
						if (!hasCursor) {
							return (
								<Text key={i} color={colors.user}>
									{prefix}
									{line}
								</Text>
							);
						}
						const col = value.cursor - start;
						return (
							<Text key={i} color={colors.user}>
								{prefix}
								{line.slice(0, col)}
								<Text inverse>{line[col] ?? ' '}</Text>
								{line.slice(col + 1)}
							</Text>
						);
					})
				)}
			</Box>
			{active && suggestions.length > 0 && (
				<Box flexDirection="column" paddingX={2}>
					{suggestions.map((s, i) => (
						<Text key={s.name}>
							<Text color={i === 0 ? colors.accent : undefined} bold={i === 0}>
								/{s.name.padEnd(14)}
							</Text>
							<Text dimColor>{s.description}</Text>
						</Text>
					))}
				</Box>
			)}
		</Box>
	);
}
