import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { SETTINGS, defaultValue, formatValue, origin, parseInput, saveSetting } from '../src/settings.js';
import { setTomlValue } from '../src/toml-edit.js';

describe('setTomlValue', () => {
	const text = `# My Jane config
[model]
name = "a"   # the usual one
base_url = "http://x/v1"

[ui.colors]
# I like cyan
user = "cyan"
`;

	it('changes one line and keeps comments and layout', () => {
		const out = setTomlValue(text, ['model', 'name'], 'b');
		expect(out).toBe(text.replace('name = "a"   # the usual one', 'name = "b"  # the usual one'));
	});

	it('adds a key to an existing section, after its last line', () => {
		const out = setTomlValue(text, ['model', 'context_window'], 32768);
		expect(out).toContain('base_url = "http://x/v1"\ncontext_window = 32768\n\n[ui.colors]');
		expect(out).toContain('# I like cyan');
	});

	it('adds a new section at the end', () => {
		const out = setTomlValue(text, ['instructions', 'filenames'], ['JANE.md', 'AGENTS.md']);
		expect(out.endsWith('user = "cyan"\n\n[instructions]\nfilenames = [ "JANE.md", "AGENTS.md" ]\n')).toBe(true);
		expect(setTomlValue('', ['ui', 'show_thinking'], 'full')).toBe('[ui]\nshow_thinking = "full"\n');
	});

	it('removes a section that becomes empty', () => {
		const two = '[ui.colors]\naccent = "red" # mine\n\n[ui]\nshow_thinking = "full"\n';
		expect(setTomlValue(two, ['ui', 'show_thinking'], undefined)).toBe('[ui.colors]\naccent = "red" # mine\n');
		expect(setTomlValue('[ui]\nshow_thinking = "full"\n\n[model]\nname = "x"\n', ['ui', 'show_thinking'], undefined)).toBe('[model]\nname = "x"\n');
	});

	it('removes a key', () => {
		const out = setTomlValue(text, ['ui', 'colors', 'user'], undefined);
		expect(out).not.toContain('user = ');
		expect(out).toContain('# I like cyan');
		expect(setTomlValue(text, ['nope', 'x'], undefined)).toBe(text);
	});

	it("doesn't mistake a # inside a string for a comment", () => {
		const out = setTomlValue('[ui.colors]\nuser = "#ff0000" # red\n', ['ui', 'colors', 'user'], '#00ff00');
		expect(out).toBe('[ui.colors]\nuser = "#00ff00"  # red\n');
	});

	it('falls back to rewriting the file when a line edit would be wrong', () => {
		// The value is set with a dotted key, so there is no [ui.colors] header to edit.
		const dotted = 'ui.colors.user = "red"\n';
		const out = setTomlValue(dotted, ['ui', 'colors', 'user'], 'blue');
		expect(parse(out)).toEqual({ ui: { colors: { user: 'blue' } } });
	});

	it('refuses to touch a broken file', () => {
		expect(() => setTomlValue('[model\nname = ', ['model', 'name'], 'x')).toThrow();
	});
});

describe('settings', () => {
	it('has a menu entry for every config value', () => {
		const keys: string[] = [];
		const walk = (obj: Record<string, unknown>, prefix: string) => {
			for (const [k, v] of Object.entries(obj)) {
				if (typeof v === 'object' && v !== null && !Array.isArray(v)) walk(v as Record<string, unknown>, `${prefix}${k}.`);
				else keys.push(prefix + k);
			}
		};
		walk(defaultConfig as unknown as Record<string, unknown>, '');
		expect(SETTINGS.map((s) => s.key).sort()).toEqual(keys.sort());
		for (const s of SETTINGS) expect(defaultValue(s.key)).toBeDefined();
	});

	it('checks what the user types', () => {
		const get = (key: string) => SETTINGS.find((s) => s.key === key)!;
		expect(parseInput(get('model.context_window'), ' 32768 ')).toEqual({ value: 32768 });
		expect(parseInput(get('model.context_window'), '0')).toHaveProperty('error');
		expect(parseInput(get('model.base_url'), 'localhost:8080')).toHaveProperty('error');
		expect(parseInput(get('instructions.filenames'), 'JANE.md, AGENTS.md,')).toEqual({ value: ['JANE.md', 'AGENTS.md'] });
		expect(parseInput(get('instructions.filenames'), ' , ')).toHaveProperty('error');
		expect(parseInput(get('ui.colors.user'), '#88C0D0')).toEqual({ value: '#88C0D0' });
		expect(parseInput(get('ui.colors.user'), 'magentaBright')).toEqual({ value: 'magentaBright' });
		expect(parseInput(get('ui.colors.user'), 'teal')).toHaveProperty('error');
		expect(parseInput(get('model.api_key'), '')).toEqual({ value: '' });
		expect(formatValue(get('model.api_key'), 'secret')).toBe('••••••••');
		expect(formatValue(get('instructions.filenames'), ['a', 'b'])).toBe('a, b');
	});

	it('knows which file a value comes from', () => {
		const layers = { user: { model: { name: 'a' } }, project: { ui: { colors: { user: 'red' } } } };
		expect(origin('model.name', layers)).toBe('user');
		expect(origin('ui.colors.user', layers)).toBe('project');
		expect(origin('ui.show_thinking', layers)).toBe('default');
	});

	describe('saving', () => {
		let dir: string;
		let home: string | undefined;
		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-settings-'));
		});
		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
			process.env['HOME'] = home;
		});

		it('creates the project config folder and file when needed', () => {
			const file = saveSetting('project', dir, 'ui.show_thinking', 'hidden');
			expect(file).toBe(path.join(dir, '.jane', 'config.toml'));
			expect(fs.readFileSync(file, 'utf8')).toBe('[ui]\nshow_thinking = "hidden"\n');
			saveSetting('project', dir, 'ui.show_thinking', undefined);
			expect(fs.readFileSync(file, 'utf8')).toBe('');
		});

		it('explains a broken config file instead of overwriting it', () => {
			fs.mkdirSync(path.join(dir, '.jane'));
			fs.writeFileSync(path.join(dir, '.jane', 'config.toml'), '[ui\n');
			expect(() => saveSetting('project', dir, 'ui.show_thinking', 'full')).toThrow(/isn't valid TOML/);
			expect(fs.readFileSync(path.join(dir, '.jane', 'config.toml'), 'utf8')).toBe('[ui\n');
		});
	});
});

describe('settings for skills', () => {
	it('allows an empty list where it makes sense', () => {
		const sources = SETTINGS.find((s) => s.key === 'skills.sources')!;
		expect(parseInput(sources, '')).toEqual({ value: [] });
		expect(formatValue(sources, [])).toBe('(none)');
		expect(parseInput(SETTINGS.find((s) => s.key === 'instructions.filenames')!, '')).toHaveProperty('error');
	});
});

describe('on/off settings', () => {
	it('reads and shows on/off', () => {
		const undo = SETTINGS.find((s) => s.key === 'checkpoints.enabled')!;
		expect(parseInput(undo, 'off')).toEqual({ value: false });
		expect(parseInput(undo, 'maybe')).toHaveProperty('error');
		expect(formatValue(undo, true)).toBe('on');
	});

	it('keeps each section together', () => {
		const sections = SETTINGS.map((s) => s.section).filter((s, i, all) => s !== all[i - 1]);
		expect(new Set(sections).size).toBe(sections.length);
	});
});

describe('block list settings', () => {
	it('shows the patterns as a count and keeps them out of the line editor', () => {
		const patterns = SETTINGS.find((s) => s.key === 'block_list.patterns')!;
		expect(formatValue(patterns, ['a', 'b'])).toBe('2 patterns');
		expect(parseInput(patterns, 'x')).toHaveProperty('error');
	});
});
