import { Box, Text } from 'ink';
import { tildify } from '../paths.js';
import { useColors } from './theme.js';

const LETTERS = [
	'   ▄▄▄▄▄  ▄▄▄  ▄▄  ▄▄ ▄▄▄▄▄',
	'     ██  ██▀██ ███▄██ ██▄▄',
	'  ▄  ██  ██▀██ ██▀███ ██▀▀',
	'  ▀███▀  ██ ██ ██  ██ ██▄▄▄',
];
const SHADOW = '   ░░░   ░░ ░░ ░░  ░░ ░░░░░';

export function Banner({ version, model, cwd }: { version: string; model: string; cwd: string }) {
	const colors = useColors();
	return (
		<Box flexDirection="column" marginBottom={1}>
			{LETTERS.map((line, i) => (
				<Text key={i} color={colors.accent}>
					{line}
				</Text>
			))}
			<Text color={colors.accent} dimColor>
				{SHADOW}
			</Text>
			<Text> </Text>
			<Text>
				{' '}
				<Text bold>Jane</Text> v{version} <Text dimColor>·</Text> {model}
			</Text>
			<Text dimColor> {tildify(cwd)}</Text>
		</Box>
	);
}
