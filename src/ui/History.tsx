import { Box, Text } from 'ink';
import type { ThinkingDisplay } from '../config.js';
import type { DiffLine, ToolDisplay, ToolResult } from '../tools/types.js';
import { renderMarkdown } from './markdown.js';
import { useColors } from './theme.js';

export type HistoryItem = { key: string } & (
	| { kind: 'banner' }
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string }
	| { kind: 'thinking'; text: string; seconds?: number }
	| { kind: 'tool'; name: string; label: string; result: ToolResult }
	| { kind: 'info'; text: string; tone?: 'info' | 'warning' | 'error' }
	| { kind: 'diff'; title: string; lines: DiffLine[]; note?: string }
);

export function toolTitle(name: string): string {
	// MCP tools are <server>__<tool>: show them as "server: tool".
	const mcp = /^(.+?)__(.+)$/.exec(name);
	if (mcp) return `${mcp[1]}: ${mcp[2]}`;
	const words = name.replace(/_/g, ' ');
	return words ? words[0]!.toUpperCase() + words.slice(1) : words;
}

function shorten(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

export function UserMessage({ text }: { text: string }) {
	const colors = useColors();
	const lines = text.split('\n');
	return (
		<Box flexDirection="column" marginBottom={1}>
			{lines.map((line, i) => (
				<Text key={i} color={colors.user}>
					{i === 0 ? '› ' : '  '}
					{line}
				</Text>
			))}
		</Box>
	);
}

export function AssistantMessage({ text, width }: { text: string; width: number }) {
	const colors = useColors();
	return (
		<Box marginBottom={1}>
			<Text color={colors.accent}>● </Text>
			<Box flexShrink={1}>
				<Text>{renderMarkdown(text, colors.assistant, colors.accent, width - 2)}</Text>
			</Box>
		</Box>
	);
}

export function Thinking({
	text,
	mode,
	seconds,
	live,
	maxLines,
}: {
	text: string;
	mode: ThinkingDisplay;
	seconds?: number;
	live?: boolean;
	maxLines?: number;
}) {
	const colors = useColors();
	if (mode === 'hidden' || !text.trim()) return null;
	const title = live ? 'Thinking…' : seconds !== undefined ? `Thought for ${seconds}s` : 'Thought';
	if (mode === 'collapsed') {
		const lines = text.trim().split('\n');
		const last = live ? lines.at(-1)! : lines[0]!;
		return (
			<Box marginBottom={live ? 0 : 1}>
				<Text color={colors.thinking} wrap="truncate-end">
					✻ {title} <Text dimColor>{shorten(last, 200)}</Text>
				</Text>
			</Box>
		);
	}
	let body = text.trim();
	if (maxLines) body = body.split('\n').slice(-maxLines).join('\n');
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color={colors.thinking}>✻ {title}</Text>
			<Box paddingLeft={2}>
				<Text color={colors.thinking} dimColor italic>
					{body}
				</Text>
			</Box>
		</Box>
	);
}

export function DiffView({ lines, maxLines }: { lines: DiffLine[]; maxLines: number }) {
	const colors = useColors();
	const shown = lines.slice(0, maxLines);
	const width = String(Math.max(0, ...lines.map((l) => l.new ?? l.old ?? 0))).length;
	return (
		<Box flexDirection="column">
			{shown.map((line, i) => {
				if (line.kind === 'gap') return <Text key={i} dimColor>{' '.repeat(width)}  …</Text>;
				const no = String(line.kind === 'remove' ? line.old : line.new).padStart(width);
				const mark = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
				const color = line.kind === 'add' ? colors.diff_add : line.kind === 'remove' ? colors.diff_remove : undefined;
				return (
					<Text key={i} wrap="truncate-end">
						<Text dimColor>{no} </Text>
						<Text color={color} dimColor={line.kind === 'context'}>
							{mark} {line.text}
						</Text>
					</Text>
				);
			})}
			{lines.length > maxLines && <Text dimColor>… {lines.length - maxLines} more lines</Text>}
		</Box>
	);
}

function OutputPreview({ text, maxLines }: { text: string; maxLines: number }) {
	const lines = text.split('\n');
	return (
		<Box flexDirection="column">
			{lines.slice(0, maxLines).map((line, i) => (
				<Text key={i} dimColor wrap="truncate-end">
					{line || ' '}
				</Text>
			))}
			{lines.length > maxLines && <Text dimColor>… {lines.length - maxLines} more lines</Text>}
		</Box>
	);
}

/** The ⎿ part under a tool call: a summary line, a diff and/or some output. */
export function ToolDetails({ display, isError, maxLines }: { display?: ToolDisplay; isError?: boolean; maxLines: number }) {
	const colors = useColors();
	if (!display) return null;
	const { summary, diff, text } = display;
	if (!summary && !diff?.length && !text) return null;
	return (
		<Box>
			<Text dimColor>  ⎿  </Text>
			<Box flexDirection="column" flexShrink={1}>
				{summary && <Text color={isError ? colors.diff_remove : undefined} dimColor={!isError}>{summary}</Text>}
				{diff && diff.length > 0 && <DiffView lines={diff} maxLines={maxLines} />}
				{text && <OutputPreview text={text} maxLines={maxLines} />}
			</Box>
		</Box>
	);
}

export function ToolMessage({ name, label, result }: { name: string; label: string; result: ToolResult }) {
	const colors = useColors();
	// Errors without a display show the message the model got.
	const display = result.display ?? (result.isError ? { summary: shorten(result.output, 300) } : undefined);
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text wrap="truncate-end">
				<Text color={result.isError ? colors.diff_remove : colors.diff_add}>● </Text>
				<Text bold>{toolTitle(name)}</Text>
				{label ? <Text>({shorten(label, 160)})</Text> : null}
			</Text>
			<ToolDetails display={display} isError={result.isError} maxLines={name === 'bash' ? 8 : 40} />
		</Box>
	);
}

export function InfoMessage({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warning' | 'error' }) {
	const colors = useColors();
	const color = tone === 'error' ? colors.diff_remove : tone === 'warning' ? 'yellow' : undefined;
	return (
		<Box marginBottom={1}>
			<Text color={color} dimColor={tone === 'info'}>
				{text}
			</Text>
		</Box>
	);
}

/** A titled diff, e.g. from /prompt diff. */
export function DiffMessage({ title, lines, note }: { title: string; lines: DiffLine[]; note?: string }) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text bold>{title}</Text>
			{lines.length ? <DiffView lines={lines} maxLines={400} /> : <Text dimColor>(no differences)</Text>}
			{note ? <Text dimColor>{note}</Text> : null}
		</Box>
	);
}
