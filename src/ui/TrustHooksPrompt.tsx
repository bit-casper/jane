import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { Hook } from '../hooks.js';
import { useColors } from './theme.js';

/** Ask before running hooks that a project's own config defines. */
export function TrustHooksPrompt({ hooks, project, onDecide }: { hooks: Hook[]; project: string; onDecide(allow: boolean): void }) {
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
				This project wants to run its own hooks
			</Text>
			<Text dimColor>
				{project}/.jane/config.toml defines commands that Jane would run on your computer. Only allow them if you trust this project.
			</Text>
			<Box flexDirection="column" marginY={1}>
				{hooks.map((hook, i) => (
					<Text key={i}>
						<Text color={colors.accent}>{hook.event.padEnd(14)}</Text>
						{hook.tools.length ? <Text dimColor>[{hook.tools.join(', ')}] </Text> : null}
						{hook.command}
					</Text>
				))}
			</Box>
			{options.map((option, i) => (
				<Text key={i} color={i === selected ? colors.accent : undefined}>
					{i === selected ? '❯ ' : '  '}
					{i + 1}. {option}
				</Text>
			))}
			<Text dimColor>If these hooks change later, Jane asks again.</Text>
		</Box>
	);
}
