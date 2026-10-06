import { Box, Text, useInput, usePaste } from 'ink';
import { useState } from 'react';
import type { PermissionDecision, PermissionRequest } from '../agent.js';
import { DiffView, toolTitle } from './History.js';
import { useColors } from './theme.js';

const QUESTIONS: Record<string, string> = {
	web_fetch: 'Fetch this page?',
	write: 'Write this file?',
	edit: 'Make this edit?',
	bash: 'Run this command?',
};

export function PermissionPrompt({
	request,
	onDecide,
	maxPreviewLines,
}: {
	request: PermissionRequest;
	onDecide(decision: PermissionDecision): void;
	maxPreviewLines: number;
}) {
	const colors = useColors();
	const [selected, setSelected] = useState(0);
	const [feedback, setFeedback] = useState<string | null>(null);
	const name = request.tool.name;
	const options = [
		'Yes',
		`Yes, and don't ask again for ${request.scope ?? toolTitle(name)} this session`,
		'No, and tell Jane what to do instead',
	];

	const choose = (index: number) => {
		if (index === 0) onDecide({ kind: 'yes' });
		else if (index === 1) onDecide({ kind: 'always' });
		else setFeedback('');
	};

	usePaste((text) => setFeedback((f) => (f ?? '') + text.replace(/\s*\n\s*/g, ' ')), { isActive: feedback !== null });

	useInput((input, key) => {
		if (feedback !== null) {
			if (key.return) onDecide({ kind: 'no', feedback });
			else if (key.escape) setFeedback(null);
			else if (key.backspace || key.delete) setFeedback(feedback.slice(0, -1));
			else if (input && !key.ctrl && !key.meta) setFeedback(feedback + input);
			return;
		}
		if (key.escape) return onDecide({ kind: 'no' });
		if (key.upArrow) setSelected((s) => (s + options.length - 1) % options.length);
		else if (key.downArrow || key.tab) setSelected((s) => (s + 1) % options.length);
		else if (key.return) choose(selected);
		else if (['1', '2', '3'].includes(input)) choose(Number(input) - 1);
	});

	const { preview } = request;
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1} marginBottom={1}>
			<Text bold color={colors.accent}>
				{toolTitle(name)}
				<Text color={undefined} bold={false}>
					{name === 'bash' ? '' : ` ${request.label}`}
				</Text>
			</Text>
			<Box marginY={1} flexDirection="column">
				{preview.diff && preview.diff.length > 0 && <DiffView lines={preview.diff} maxLines={maxPreviewLines} />}
				{preview.diff && preview.diff.length === 0 && <Text dimColor>(no changes)</Text>}
				{preview.text && <Text>{preview.text}</Text>}
			</Box>
			<Text>{QUESTIONS[name] ?? `Run ${toolTitle(name)}?`}</Text>
			{options.map((option, i) => (
				<Text key={i} color={i === selected ? colors.accent : undefined}>
					{i === selected ? '❯ ' : '  '}
					{i + 1}. {option}
				</Text>
			))}
			{feedback !== null ? (
				<Box marginTop={1}>
					<Text>
						<Text color={colors.user}>What should Jane do instead? </Text>
						{feedback}
						<Text inverse> </Text>
					</Text>
				</Box>
			) : (
				<Text dimColor>Enter to choose · Esc to say no</Text>
			)}
		</Box>
	);
}
