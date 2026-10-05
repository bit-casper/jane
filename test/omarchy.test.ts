import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../src/config.js';
import { mix, readOmarchyColors, watchOmarchyTheme } from '../src/omarchy.js';

// Part of Omarchy's "Last Horizon" theme.
const LAST_HORIZON = `mode = "dark"
accent = "#b59790"
muted = "#584e51"
background = "#0c0b0c"
foreground = "#FAFCFB"
red = "#c38b7b"
green = "#87a9b0"
cyan = "#a5a0b6"
blue = "#b59790"
hyprland_active_border = "rgba(8a8588ee) rgba(e2dddcee)"
`;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-omarchy-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Omarchy theme', () => {
	it('blends colours like Omarchy does', () => {
		// Omarchy's Claude theme uses "mix foreground background 40%" = #9b9c9b for Last Horizon.
		expect(mix('#FAFCFB', '#0c0b0c', 0.4)).toBe('#9b9c9b');
		expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
	});

	it("maps a theme's colours to Jane's", () => {
		const file = path.join(dir, 'colors.toml');
		fs.writeFileSync(file, LAST_HORIZON);
		expect(readOmarchyColors(file)).toEqual({
			user: '#a5a0b6',
			assistant: '#FAFCFB',
			thinking: '#9b9c9b',
			accent: '#b59790',
			diff_add: '#87a9b0',
			diff_remove: '#c38b7b',
		});
	});

	it('falls back to the terminal palette and skips missing colours', () => {
		const file = path.join(dir, 'colors.toml');
		fs.writeFileSync(file, 'color4 = "#112233"\ncolor2 = "#00ff00"\nred = "not a colour"\n');
		expect(readOmarchyColors(file)).toEqual({ accent: '#112233', diff_add: '#00ff00' });
		expect(readOmarchyColors(path.join(dir, 'missing.toml'))).toBeUndefined();
		fs.writeFileSync(file, 'this is [not toml');
		expect(readOmarchyColors(file)).toBeUndefined();
	});

	it('lets colours set in a config file win over the theme', () => {
		const user = path.join(dir, 'user.toml');
		fs.writeFileSync(user, '[ui.colors]\nuser = "red"\n');
		const theme = () => ({ user: '#111111', accent: '#222222' });
		const { config, themed } = loadConfig(dir, [user], theme);
		expect(config.ui.colors.user).toBe('red');
		expect(config.ui.colors.accent).toBe('#222222');
		expect(config.ui.colors.assistant).toBe(defaultConfig.ui.colors.assistant);
		expect(themed).toEqual(['accent']);
	});

	it('ignores the theme when ui.theme is "none"', () => {
		const user = path.join(dir, 'user.toml');
		fs.writeFileSync(user, '[ui]\ntheme = "none"\n');
		const { config, themed } = loadConfig(dir, [user], () => ({ accent: '#222222' }));
		expect(config.ui.colors.accent).toBe('magenta');
		expect(themed).toEqual([]);
	});

	it('notices when the theme folder changes', async () => {
		let changes = 0;
		const stop = watchOmarchyTheme(() => changes++, dir);
		fs.writeFileSync(path.join(dir, 'theme.name'), 'tokyo-night');
		fs.mkdirSync(path.join(dir, 'theme'));
		await new Promise((r) => setTimeout(r, 700));
		stop();
		// Several file events, one callback.
		expect(changes).toBe(1);
		expect(watchOmarchyTheme(() => {}, path.join(dir, 'missing'))).toBeTypeOf('function');
	});
});
