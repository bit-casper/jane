// Read the active Omarchy theme, so Jane can use the same colours as the rest of the desktop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { Config } from './config.js';

type Colors = Config['ui']['colors'];

/** Omarchy keeps the active theme here (see omarchy-theme-set). */
export const omarchyCurrentDir = path.join(os.homedir(), '.local', 'state', 'omarchy', 'current');
export const omarchyColorsFile = path.join(omarchyCurrentDir, 'theme', 'colors.toml');

const HEX = /^#[0-9a-f]{6}$/i;

/** Blend two #rrggbb colours: `amount` of `b` into `a`, like Omarchy's `mix` template helper. */
export function mix(a: string, b: string, amount: number): string {
	const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
	let out = '#';
	for (let i = 0; i < 3; i++) {
		const value = Math.round(channel(a, i) * (1 - amount) + channel(b, i) * amount);
		out += value.toString(16).padStart(2, '0');
	}
	return out;
}

/**
 * Jane's colours from an Omarchy colors.toml, or undefined if there's no
 * usable theme. Follows the choices Omarchy makes for Claude Code's theme.
 */
export function readOmarchyColors(file = omarchyColorsFile): Partial<Colors> | undefined {
	let raw: Record<string, unknown>;
	try {
		raw = parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			const value = raw[key];
			if (typeof value === 'string' && HEX.test(value)) return value;
		}
		return undefined;
	};
	const foreground = pick('foreground', 'color7');
	const background = pick('background', 'color0');
	const colors: Partial<Colors> = {
		user: pick('cyan', 'color6', 'bright_cyan'),
		assistant: foreground,
		thinking: foreground && background ? mix(foreground, background, 0.4) : pick('muted', 'color8'),
		accent: pick('accent', 'blue', 'color4'),
		diff_add: pick('green', 'color2'),
		diff_remove: pick('red', 'color1'),
	};
	for (const key of Object.keys(colors) as (keyof Colors)[]) if (!colors[key]) delete colors[key];
	return Object.keys(colors).length ? colors : undefined;
}

/**
 * Watch for Omarchy theme changes. Omarchy swaps the whole theme folder, so
 * this watches the folder above it. Returns a function that stops watching.
 */
export function watchOmarchyTheme(onChange: () => void, dir = omarchyCurrentDir): () => void {
	let watcher: fs.FSWatcher;
	try {
		watcher = fs.watch(dir, { persistent: false });
	} catch {
		return () => {};
	}
	let timer: NodeJS.Timeout | undefined;
	watcher.on('change', () => {
		clearTimeout(timer);
		// A theme switch touches several files; wait until it settles.
		timer = setTimeout(onChange, 400);
	});
	watcher.on('error', () => {});
	return () => {
		clearTimeout(timer);
		watcher.close();
	};
}
