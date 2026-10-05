import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamAccumulator, sseData } from '../src/client.js';
import { defaultConfig, loadConfig } from '../src/config.js';
import { loadInstructions } from '../src/instructions.js';
import { Session, listSessions, loadSession } from '../src/session.js';
import { bashTool } from '../src/tools/bash.js';
import { editTool, readTool, writeTool } from '../src/tools/files.js';
import { findTool, parseArgs } from '../src/tools/index.js';
import { globTool, grepTool } from '../src/tools/search.js';
import * as ed from '../src/ui/editor.js';

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-test-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('config', () => {
	it('uses defaults when there are no files', () => {
		const { config, warnings } = loadConfig(dir, [path.join(dir, 'nope.toml')]);
		expect(config).toEqual(defaultConfig);
		expect(warnings).toEqual([]);
	});

	it('lets the project override the user config, and warns about mistakes', () => {
		const user = path.join(dir, 'user.toml');
		const project = path.join(dir, 'project.toml');
		fs.writeFileSync(user, '[model]\nname = "a"\nbase_url = "http://x/v1/"\n[ui.colors]\nuser = "#ff0000"\n');
		fs.writeFileSync(project, '[model]\nname = "b"\ncontext_window = "big"\n[instructions]\nfilenames = ["AGENTS.md", "JANE.md"]\ntypo = 1\n');
		const { config, warnings } = loadConfig(dir, [user, project]);
		expect(config.model.name).toBe('b');
		expect(config.model.base_url).toBe('http://x/v1');
		expect(config.model.context_window).toBe(65536);
		expect(config.ui.colors.user).toBe('#ff0000');
		expect(config.instructions.filenames).toEqual(['AGENTS.md', 'JANE.md']);
		expect(warnings.join('\n')).toMatch(/model.context_window" should be a number/);
		expect(warnings.join('\n')).toMatch(/unknown setting "instructions.typo"/);
	});

	it('rejects an invalid permission mode', () => {
		const file = path.join(dir, 'c.toml');
		fs.writeFileSync(file, '[permissions]\ndefault_mode = "yolo"\n');
		const { config, warnings } = loadConfig(dir, [file]);
		expect(config.permissions.default_mode).toBe('always-ask');
		expect(warnings).toHaveLength(1);
	});
});

describe('stream parsing', () => {
	it('splits server-sent events across chunk boundaries', async () => {
		const chunks = ['data: {"a":1}\n\nda', 'ta: {"b":2}\r\n\ndata: [DONE]\n'];
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
				c.close();
			},
		});
		const out: string[] = [];
		for await (const d of sseData(body)) out.push(d);
		expect(out).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
	});

	it('joins streamed text, reasoning and tool call pieces', () => {
		const seen: string[] = [];
		const acc = new StreamAccumulator({ onContent: (d) => seen.push(d) });
		acc.add({ choices: [{ delta: { reasoning_content: 'hmm' } }] });
		acc.add({ choices: [{ delta: { content: 'Hel' } }] });
		acc.add({ choices: [{ delta: { content: 'lo' } }] });
		acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"pa' } }] } }] });
		acc.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] });
		acc.add({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'glob', arguments: '{}' } }] } }] });
		acc.add({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
		const r = acc.result();
		expect(r.content).toBe('Hello');
		expect(r.reasoning).toBe('hmm');
		expect(seen).toEqual(['Hel', 'lo']);
		expect(r.toolCalls).toHaveLength(2);
		expect(r.toolCalls[0]).toMatchObject({ id: 'c1', function: { name: 'read', arguments: '{"path":"x"}' } });
		expect(r.toolCalls[1]!.id).toMatch(/^call_/);
		expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
	});
});

describe('tool arguments', () => {
	it('converts numbers and booleans sent as strings', () => {
		const r = parseArgs(findTool('read')!, '{"path":"a","offset":"5","extra":1}');
		expect(r).toEqual({ args: { path: 'a', offset: 5 } });
		const g = parseArgs(findTool('grep')!, '{"pattern":"x","ignore_case":"true"}');
		expect(g).toEqual({ args: { pattern: 'x', ignore_case: true } });
	});

	it('explains bad JSON and missing arguments', () => {
		expect(parseArgs(findTool('read')!, '{path:')).toMatchObject({ error: expect.stringMatching(/not valid JSON/) });
		expect(parseArgs(findTool('edit')!, '{"path":"a"}')).toMatchObject({ error: expect.stringMatching(/"old_string" is required/) });
		expect(parseArgs(findTool('read')!, '{"path":"a","limit":"lots"}')).toMatchObject({ error: expect.stringMatching(/"limit" must be a integer/) });
	});
});

describe('file tools', () => {
	it('reads with line numbers, offset and limit', async () => {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
		const all = await readTool.run({ path: 'a.txt' }, ctx());
		expect(all.output).toBe('1\tone\n2\ttwo\n3\tthree');
		const part = await readTool.run({ path: 'a.txt', offset: 2, limit: 1 }, ctx());
		expect(part.output).toMatch(/^2\ttwo\n\n\[Showing lines 2-2 of 3/);
	});

	it('refuses missing, binary and directory paths', async () => {
		await expect(readTool.run({ path: 'nope' }, ctx())).rejects.toThrow(/File not found/);
		fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([1, 0, 2]));
		await expect(readTool.run({ path: 'b.bin' }, ctx())).rejects.toThrow(/binary/);
		await expect(readTool.run({ path: '.' }, ctx())).rejects.toThrow(/directory/);
	});

	it('writes new files with parent folders and shows a diff', async () => {
		const r = await writeTool.run({ path: 'x/y/z.txt', content: 'a\nb\n' }, ctx());
		expect(fs.readFileSync(path.join(dir, 'x/y/z.txt'), 'utf8')).toBe('a\nb\n');
		expect(r.display?.summary).toBe('Created with 2 lines');
		expect(r.display?.diff?.filter((l) => l.kind === 'add')).toHaveLength(2);
	});

	it('edits only when the text matches exactly once', async () => {
		const file = path.join(dir, 'e.txt');
		fs.writeFileSync(file, 'foo\nbar\nfoo\n');
		await expect(editTool.run({ path: 'e.txt', old_string: 'foo', new_string: 'x' }, ctx())).rejects.toThrow(/appears 2 times/);
		await expect(editTool.run({ path: 'e.txt', old_string: 'baz', new_string: 'x' }, ctx())).rejects.toThrow(/not found/);
		await editTool.run({ path: 'e.txt', old_string: 'bar', new_string: '$& $1' }, ctx());
		expect(fs.readFileSync(file, 'utf8')).toBe('foo\n$& $1\nfoo\n');
		const r = await editTool.run({ path: 'e.txt', old_string: 'foo', new_string: 'q', replace_all: true }, ctx());
		expect(fs.readFileSync(file, 'utf8')).toBe('q\n$& $1\nq\n');
		expect(r.display?.summary).toBe('2 lines added, 2 removed');
	});

	it('previews an edit without changing the file', async () => {
		const file = path.join(dir, 'p.txt');
		fs.writeFileSync(file, 'a\nb\n');
		const preview = await editTool.preview!({ path: 'p.txt', old_string: 'b', new_string: 'c' }, ctx());
		expect(preview.diff?.map((l) => l.kind)).toEqual(['context', 'remove', 'add']);
		expect(fs.readFileSync(file, 'utf8')).toBe('a\nb\n');
	});
});

describe('search tools', () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(dir, 'src'));
		fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const needle = 1;\n');
		fs.writeFileSync(path.join(dir, 'src/b.js'), 'nothing here\n');
		fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
		fs.mkdirSync(path.join(dir, 'ignored'));
		fs.writeFileSync(path.join(dir, 'ignored/c.ts'), 'needle\n');
		fs.mkdirSync(path.join(dir, '.git'));
	});

	it('globs and respects .gitignore', async () => {
		const r = await globTool.run({ pattern: '**/*.ts' }, ctx());
		expect(r.output).toBe(path.join('src', 'a.ts'));
	});

	it('greps contents with line numbers, or file names only', async () => {
		const r = await grepTool.run({ pattern: 'needle' }, ctx());
		expect(r.output).toBe('src/a.ts:1:const needle = 1;');
		const files = await grepTool.run({ pattern: 'NEEDLE', ignore_case: true, files_only: true }, ctx());
		expect(files.output).toBe('src/a.ts');
		const none = await grepTool.run({ pattern: 'zzz' }, ctx());
		expect(none.output).toBe('No matches.');
	});
});

describe('bash tool', () => {
	it('runs in the working directory and reports exit codes', async () => {
		const ok = await bashTool.run({ command: 'pwd; echo err >&2' }, ctx());
		expect(ok.output).toBe(`${fs.realpathSync(dir)}\nerr`);
		expect(ok.isError).toBe(false);
		const bad = await bashTool.run({ command: 'exit 3' }, ctx());
		expect(bad.output).toBe('(no output)\n\nExit code 3.');
		expect(bad.isError).toBe(true);
	});

	it('stops on timeout and on interrupt, including child processes', async () => {
		const t = await bashTool.run({ command: 'sleep 30 & wait', timeout_seconds: 1 }, ctx());
		expect(t.output).toMatch(/timed out after 1s/);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const i = await bashTool.run({ command: 'echo started; sleep 30' }, { cwd: dir, signal: controller.signal });
		expect(i.output).toMatch(/^started\n\nCommand was interrupted/);
	});
});

describe('instructions', () => {
	it('takes the first matching file name, user file first', () => {
		const user = path.join(dir, 'user');
		const project = path.join(dir, 'project');
		fs.mkdirSync(user);
		fs.mkdirSync(project);
		fs.writeFileSync(path.join(user, 'JANE.md'), 'user rules');
		fs.writeFileSync(path.join(project, 'AGENTS.md'), 'agents rules');
		fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'claude rules');
		const found = loadInstructions(project, ['JANE.md', 'CLAUDE.md', 'AGENTS.md'], user);
		expect(found.map((f) => f.content)).toEqual(['user rules', 'claude rules']);
		expect(loadInstructions(project, ['JANE.md'], path.join(dir, 'none'))).toEqual([]);
	});
});

describe('sessions', () => {
	it('saves as it goes, lists newest first and loads back', () => {
		const a = new Session('/proj', 'm', { root: dir });
		expect(fs.existsSync(a.file)).toBe(false);
		a.addMessage({ role: 'user', content: 'first   prompt\nhere' });
		a.addMessage({ role: 'assistant', content: 'hi' });
		a.setMode('unrestricted');
		fs.appendFileSync(a.file, '{"type":"mess'); // a crash mid-write

		const loaded = loadSession(a.file);
		expect(loaded.messages).toHaveLength(2);
		expect(loaded.mode).toBe('unrestricted');

		const b = new Session('/proj', 'm', { root: dir });
		b.addMessage({ role: 'user', content: 'second' });
		fs.utimesSync(b.file, new Date(), new Date(Date.now() + 1000));
		new Session('/proj', 'm', { root: dir }); // never written, so not listed

		const list = listSessions('/proj', dir);
		expect(list.map((s) => s.firstPrompt)).toEqual(['second', 'first prompt here']);
		expect(list[1]!.messageCount).toBe(2);
		expect(listSessions('/other', dir)).toEqual([]);

		const resumed = new Session('/proj', 'm', { root: dir, id: a.id });
		resumed.addMessage({ role: 'user', content: 'again' });
		expect(loadSession(a.file).messages).toHaveLength(3);
		expect(fs.readFileSync(a.file, 'utf8').match(/"type":"meta"/g)).toHaveLength(1);
	});
});

describe('editor', () => {
	it('inserts, deletes and moves between lines', () => {
		let s = ed.insert(ed.empty, 'hello\r\nworld');
		expect(s).toEqual({ text: 'hello\nworld', cursor: 11 });
		s = ed.vertical({ ...s, cursor: 8 }, -1);
		expect(s.cursor).toBe(2);
		s = ed.vertical(s, 1);
		expect(s.cursor).toBe(8);
		expect(ed.isOnFirstLine(s)).toBe(false);
		s = ed.deleteWordBack(ed.end(s));
		expect(s.text).toBe('hello\n');
		s = ed.killToLineStart(ed.home(ed.insert(s, 'abc')));
		expect(s.text).toBe('hello\nabc');
		expect(ed.backspace({ text: 'ab', cursor: 0 })).toEqual({ text: 'ab', cursor: 0 });
	});
});
