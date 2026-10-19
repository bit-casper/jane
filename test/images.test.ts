import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChatMessage, toWire } from '../src/client.js';
import { CLEARED_OUTPUT, clearToolOutputs, oldToolOutputs, transcript } from '../src/compact.js';
import { clipboardImages, imageDataUrl, imagePathsIn, isImagePath, saveImage } from '../src/images.js';
import { readTool } from '../src/tools/files.js';

// The smallest valid PNG: 1×1 transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-images-'));
	fs.writeFileSync(path.join(dir, 'cat.png'), PNG);
	fs.mkdirSync(path.join(dir, 'my pics'));
	fs.writeFileSync(path.join(dir, 'my pics', 'dog photo.jpg'), PNG);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

describe('images', () => {
	it('knows image files by their extension', () => {
		expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp'].every(isImagePath)).toBe(true);
		expect(isImagePath('notes.txt')).toBe(false);
		expect(isImagePath('icon.svg')).toBe(false);
	});

	it('finds image files named in a prompt: typed, dragged in, quoted or as file:// URLs', () => {
		const dog = path.join(dir, 'my pics', 'dog photo.jpg');
		const cat = path.join(dir, 'cat.png');
		expect(imagePathsIn('what is in cat.png?', dir)).toEqual([cat]);
		expect(imagePathsIn(`compare ${dir}/my\\ pics/dog\\ photo.jpg and (cat.png).`, dir)).toEqual([dog, cat]);
		expect(imagePathsIn(`'${dog}'`, dir)).toEqual([dog]);
		expect(imagePathsIn(`file://${encodeURI(dog)}`, dir)).toEqual([dog]);
		expect(imagePathsIn('missing.png and cat.txt', dir)).toEqual([]);
		expect(imagePathsIn('cat.png cat.png', dir)).toEqual([cat]);
	});

	it('saves pasted images once, named by their content', () => {
		const a = saveImage(PNG, '.png', path.join(dir, 'store'));
		const b = saveImage(PNG, '.png', path.join(dir, 'store'));
		expect(a).toBe(b);
		expect(fs.readdirSync(path.join(dir, 'store'))).toHaveLength(1);
		expect(imageDataUrl(a)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
		expect(imageDataUrl(path.join(dir, 'gone.png'))).toBeUndefined();
	});

	it('sends images as image parts; images from tool results go in a user message after the results', () => {
		const cat = path.join(dir, 'cat.png');
		const url = `data:image/png;base64,${PNG.toString('base64')}`;
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'look', images: [cat, path.join(dir, 'gone.png')] },
			{ role: 'assistant', content: null, tool_calls: [
				{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } },
				{ id: '2', type: 'function', function: { name: 'read', arguments: '{}' } },
			] },
			{ role: 'tool', tool_call_id: '1', content: 'Image cat.png', images: [cat] },
			{ role: 'tool', tool_call_id: '2', content: 'text file' },
			{ role: 'assistant', content: 'A cat.' },
		];
		expect(toWire(messages)).toEqual([
			{ role: 'user', content: [
				{ type: 'text', text: 'look' },
				{ type: 'image_url', image_url: { url } },
				{ type: 'text', text: `[Image no longer available: ${path.join(dir, 'gone.png')}]` },
			] },
			messages[1],
			{ role: 'tool', tool_call_id: '1', content: 'Image cat.png' },
			{ role: 'tool', tool_call_id: '2', content: 'text file' },
			{ role: 'user', content: [{ type: 'text', text: `[Images from the tool results above: ${cat}]` }, { type: 'image_url', image_url: { url } }] },
			messages[4],
		]);
	});

	it('lets read show an image, unless the model is known to be unable to see', async () => {
		const result = await readTool.run({ path: 'cat.png' }, { cwd: dir, signal });
		expect(result.images).toEqual([path.join(dir, 'cat.png')]);
		expect(result.output).toMatch(/^Image cat\.png \(1 KB\)\. It's attached/);
		expect((await readTool.run({ path: 'cat.png' }, { cwd: dir, signal, vision: true })).images).toHaveLength(1);
		await expect(readTool.run({ path: 'cat.png' }, { cwd: dir, signal, vision: false })).rejects.toThrow(/can't see images/);
		await expect(readTool.run({ path: 'nope.png' }, { cwd: dir, signal })).rejects.toThrow(/Image not found: nope\.png/);
	});

	it('shows images in summaries and clears old ones to save space', () => {
		const cat = path.join(dir, 'cat.png');
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'what is this?', images: [cat] },
			{ role: 'assistant', content: 'A cat.' },
			{ role: 'user', content: 'thanks' },
			{ role: 'assistant', content: 'You are welcome.' },
		];
		expect(transcript(messages, 100)).toContain(`User: what is this?\n[image: ${cat}]`);
		expect(oldToolOutputs(messages, 10)).toEqual([0]);
		clearToolOutputs(messages, [0]);
		expect(messages[0]).toEqual({ role: 'user', content: `what is this?\n\n[Image removed to save space: ${cat}. Look again with read if you need to.]` });

		const tool: ChatMessage[] = [{ role: 'tool', tool_call_id: '1', content: 'Image', images: [cat] }];
		clearToolOutputs(tool, [0]);
		expect(tool[0]).toEqual({ role: 'tool', tool_call_id: '1', content: CLEARED_OUTPUT });
	});

	it('takes a copied picture or copied image files from the clipboard', async () => {
		// A stand-in wl-paste: FAKE_TYPES is what the clipboard offers, FAKE_DIR holds the content per type.
		const bin = path.join(dir, 'bin');
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, 'wl-paste'),
			'#!/bin/sh\nif [ "$1" = "--list-types" ]; then printf "%b" "$FAKE_TYPES"; exit 0; fi\ncat "$FAKE_DIR/$(echo "$3" | tr / _)"\n',
			{ mode: 0o755 },
		);
		const env = { PATH: process.env['PATH'], WAYLAND_DISPLAY: process.env['WAYLAND_DISPLAY'] };
		Object.assign(process.env, { PATH: `${bin}:${process.env['PATH']}`, WAYLAND_DISPLAY: 'fake', FAKE_DIR: dir });
		try {
			fs.writeFileSync(path.join(dir, 'image_png'), PNG);
			process.env['FAKE_TYPES'] = 'text/html\nimage/png\n';
			const [saved] = await clipboardImages(path.join(dir, 'store'));
			expect(fs.readFileSync(saved!)).toEqual(PNG);

			fs.writeFileSync(path.join(dir, 'text_uri-list'), `file://${encodeURI(path.join(dir, 'my pics', 'dog photo.jpg'))}\r\nfile://${path.join(dir, 'notes.txt')}\r\n`);
			process.env['FAKE_TYPES'] = 'x-special/gnome-copied-files\ntext/uri-list\n';
			expect(await clipboardImages(path.join(dir, 'store'))).toEqual([path.join(dir, 'my pics', 'dog photo.jpg')]);

			process.env['FAKE_TYPES'] = 'text/plain\n';
			expect(await clipboardImages(path.join(dir, 'store'))).toEqual([]);
		} finally {
			Object.assign(process.env, env);
			delete process.env['FAKE_TYPES'];
			delete process.env['FAKE_DIR'];
		}
	});
});
