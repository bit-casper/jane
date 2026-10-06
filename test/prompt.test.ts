import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEFAULT_BASE, loadPromptBase, promptFileChanged, resolvePromptFile, systemPrompt } from '../src/prompt.js';
import { SETTINGS, formatValue, parseInput } from '../src/settings.js';

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-prompt-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('custom system prompt', () => {
	it('uses the built-in text unless a file is set', () => {
		expect(loadPromptBase('', dir)).toEqual({ text: DEFAULT_BASE });
		expect(DEFAULT_BASE).toMatch(/^You are Jane/);
	});

	it('resolves ~, absolute and project-relative paths', () => {
		expect(resolvePromptFile('~/x.md', dir)).toBe(path.join(os.homedir(), 'x.md'));
		expect(resolvePromptFile('/etc/x.md', dir)).toBe('/etc/x.md');
		expect(resolvePromptFile('.jane/system.md', dir)).toBe(path.join(dir, '.jane/system.md'));
		expect(resolvePromptFile('  ', dir)).toBeUndefined();
	});

	it('replaces only the built-in part; environment, skills and instructions stay', () => {
		const file = path.join(dir, 'system.md');
		fs.writeFileSync(file, '  You are Pixel, a cat who writes Rust.  \n');
		const base = loadPromptBase(file, dir);
		expect(base.text).toBe('You are Pixel, a cat who writes Rust.');
		const prompt = systemPrompt(dir, [{ path: path.join(dir, 'JANE.md'), content: 'Always use tabs.' }], ['# Skills\n- a: b'], base.text, new Date('2026-10-06'));
		expect(prompt.startsWith('You are Pixel, a cat who writes Rust.\n\n# Environment\n')).toBe(true);
		expect(prompt).not.toContain('You are Jane');
		expect(prompt).toContain("- Today's date: 2026-10-06");
		expect(prompt).toContain('# Skills\n- a: b');
		expect(prompt).toMatch(/# Instructions from .*JANE\.md\n\nAlways use tabs\.$/);
	});

	it('allows an empty file (no built-in part at all)', () => {
		const file = path.join(dir, 'empty.md');
		fs.writeFileSync(file, '\n');
		const prompt = systemPrompt(dir, [], [], loadPromptBase(file, dir).text);
		expect(prompt.startsWith('# Environment')).toBe(true);
	});

	it('falls back to the built-in prompt with a warning when the file is missing', () => {
		const base = loadPromptBase(path.join(dir, 'nope.md'), dir);
		expect(base.text).toBe(DEFAULT_BASE);
		expect(base.file).toBeUndefined();
		expect(base.warning).toMatch(/nope\.md doesn't exist, so Jane is using her built-in prompt/);
	});

	it('notices when the file is edited, created or removed', () => {
		const file = path.join(dir, 'system.md');
		const missing = loadPromptBase(file, dir);
		expect(promptFileChanged(missing)).toBe(false);
		fs.writeFileSync(file, 'v1');
		expect(promptFileChanged(missing)).toBe(true); // created

		const v1 = loadPromptBase(file, dir);
		expect(promptFileChanged(v1)).toBe(false);
		fs.writeFileSync(file, 'v2');
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
		expect(promptFileChanged(v1)).toBe(true); // edited
		fs.rmSync(file);
		expect(promptFileChanged(v1)).toBe(true); // removed
		expect(promptFileChanged({ text: DEFAULT_BASE })).toBe(false); // built-in
	});

	it('is a setting: empty by default, shown as built-in, editable in /settings', () => {
		const { config } = loadConfig(dir, [], () => undefined);
		expect(config.prompt.file).toBe('');
		const setting = SETTINGS.find((s) => s.key === 'prompt.file')!;
		expect(formatValue(setting, '')).toBe('(built-in)');
		expect(parseInput(setting, '')).toEqual({ value: '' });
		expect(parseInput(setting, ' ~/.config/jane/system.md ')).toEqual({ value: '~/.config/jane/system.md' });
	});
});

describe('keeping a custom prompt up to date', () => {
	it('makes a prompt file and keeps a copy of the built-in text it came from', async () => {
		const { baseCopyFile, builtinChangedSince, initPromptFile, readBaseCopy } = await import('../src/prompt.js');
		const file = path.join(dir, 'conf', 'system.md');
		expect(initPromptFile(file)).toEqual({ created: true });
		expect(fs.readFileSync(file, 'utf8')).toBe(DEFAULT_BASE + '\n');
		expect(readBaseCopy(file)).toBe(DEFAULT_BASE);
		expect(fs.existsSync(baseCopyFile(file))).toBe(true);
		expect(builtinChangedSince(file)).toBe(false);

		fs.writeFileSync(file, 'my own prompt');
		expect(initPromptFile(file)).toEqual({ created: false });
		expect(fs.readFileSync(file, 'utf8')).toBe('my own prompt'); // never overwritten
	});

	it('notices when the built-in prompt changed since, until the user has seen it', async () => {
		const { baseCopyFile, builtinChangedSince, initPromptFile, markBuiltinSeen } = await import('../src/prompt.js');
		const file = path.join(dir, 'system.md');
		initPromptFile(file);
		// Simulate an older Jane: the copy holds a different built-in text.
		fs.writeFileSync(baseCopyFile(file), 'You are Jane, an older version.\n');
		expect(builtinChangedSince(file)).toBe(true);
		markBuiltinSeen(file);
		expect(builtinChangedSince(file)).toBe(false);
	});

	it("can't tell for prompt files made by hand", async () => {
		const { builtinChangedSince, readBaseCopy } = await import('../src/prompt.js');
		const file = path.join(dir, 'handmade.md');
		fs.writeFileSync(file, 'x');
		expect(readBaseCopy(file)).toBeUndefined();
		expect(builtinChangedSince(file)).toBe(false);
	});
});
