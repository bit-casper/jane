import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { SessionSummary } from '../session.js';
import { useColors } from './theme.js';

export function ago(date: Date, now = Date.now()): string {
	const s = Math.round((now - date.getTime()) / 1000);
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.round(h / 24);
	return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function ResumePicker({
	sessions,
	onPick,
	height,
	width,
}: {
	sessions: SessionSummary[];
	onPick(session: SessionSummary | null): void;
	height: number;
	width: number;
}) {
	const colors = useColors();
	const [selected, setSelected] = useState(0);
	const visible = Math.max(3, height - 6);
	const top = Math.min(Math.max(0, selected - Math.floor(visible / 2)), Math.max(0, sessions.length - visible));

	useInput((_input, key) => {
		if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
		else if (key.downArrow) setSelected((s) => Math.min(sessions.length - 1, s + 1));
		else if (key.pageUp) setSelected((s) => Math.max(0, s - visible));
		else if (key.pageDown) setSelected((s) => Math.min(sessions.length - 1, s + visible));
		else if (key.return) onPick(sessions[selected] ?? null);
		else if (key.escape) onPick(null);
	});

	return (
		<Box flexDirection="column">
			<Text bold color={colors.accent}>
				Resume a session
			</Text>
			<Text dimColor>↑/↓ to choose · Enter to resume · Esc to start a new session</Text>
			<Text> </Text>
			{sessions.slice(top, top + visible).map((session, i) => {
				const index = top + i;
				const active = index === selected;
				const meta = `${ago(session.updated).padEnd(12)} ${String(session.messageCount).padStart(3)} msgs  `;
				const room = Math.max(10, width - meta.length - 4);
				const prompt = session.firstPrompt.length > room ? session.firstPrompt.slice(0, room - 1) + '…' : session.firstPrompt;
				return (
					<Text key={session.id} color={active ? colors.accent : undefined}>
						{active ? '❯ ' : '  '}
						<Text dimColor={!active}>{meta}</Text>
						{prompt}
					</Text>
				);
			})}
		</Box>
	);
}
