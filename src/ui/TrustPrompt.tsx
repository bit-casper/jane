import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useColors } from './theme.js';

/** Ask before running what a project's own config defines (hooks, MCP servers). */
export function TrustPrompt({
	title,
	project,
	lines,
	onDecide,
}: {
	/** e.g. "This project wants to run its own hooks" */
	title: string;
	project: string;
	/** One line per thing it wants to run: a label and the command. */
	lines: { label: string; command: string }[];
	onDecide(allow: boolean): void;
}) {
	const colors = useColors();
	const [selected, setSelected] = useState(1);
	const options = ['Allow them in this project', 'Not now (ask again next time)'];

	useInput((input, key) => {
		if (key.upArrow || key.downArrow || key.tab) setSelected((s) => 1 - s);
		else if (key.return) onDecide(selected === 0);
		else if (input === '1' || input === '2') onDecide(input === '1');
		else if (key.escape) onDecide(false);
	});

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
			<Text bold color="yellow">
				{title}
			</Text>
			<Text dimColor>
				{project}/.jane/config.toml defines programs that Jane would run on your computer. Only allow them if you trust this project.
			</Text>
			<Box flexDirection="column" marginY={1}>
				{lines.map((line, i) => (
					<Text key={i}>
						<Text color={colors.accent}>{line.label.padEnd(14)}</Text>
						{line.command}
					</Text>
				))}
			</Box>
			{options.map((option, i) => (
				<Text key={i} color={i === selected ? colors.accent : undefined}>
					{i === selected ? '❯ ' : '  '}
					{i + 1}. {option}
				</Text>
			))}
			<Text dimColor>If they change later, Jane asks again.</Text>
		</Box>
	);
}
