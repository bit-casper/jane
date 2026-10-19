// Images: files the model can look at (with a vision model), pasted from the
// clipboard or named in a prompt. Messages only carry the file path; the image
// itself is read when a request is sent.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.js';

export const imagesDir = path.join(dataDir, 'images');

/** Bigger images are refused: the request would be huge and the server shrinks them anyway. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** About how many tokens one image takes (llm-serve caps it at 1024). */
export const IMAGE_TOKENS = 1000;

const TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

export function isImagePath(file: string): boolean {
	return path.extname(file).toLowerCase() in TYPES;
}

/** Thrown when an image can't be used; the message says why. */
export class ImageError extends Error {}

/** Check an image file before attaching it. Returns its size in bytes. */
export function checkImage(file: string): number {
	let stat;
	try {
		stat = fs.statSync(file);
	} catch {
		throw new ImageError(`Image not found: ${file}`);
	}
	if (!stat.isFile()) throw new ImageError(`${file} is not a file.`);
	if (stat.size > MAX_IMAGE_BYTES) throw new ImageError(`${file} is too big to look at (${Math.round(stat.size / 1024 / 1024)} MB, the limit is 20 MB).`);
	return stat.size;
}

// Requests send the whole conversation every time, so keep the encoded images.
const cache = new Map<string, { key: string; url: string }>();

/** The image as a data: URL, or undefined if it can't be read any more. */
export function imageDataUrl(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		const key = `${stat.size}:${stat.mtimeMs}`;
		const hit = cache.get(file);
		if (hit?.key === key) return hit.url;
		if (stat.size > MAX_IMAGE_BYTES) return undefined;
		const type = TYPES[path.extname(file).toLowerCase()] ?? 'image/png';
		const url = `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
		cache.set(file, { key, url });
		return url;
	} catch {
		return undefined;
	}
}

/** Save image bytes (e.g. from the clipboard) under Jane's data directory. Same image, same file. */
export function saveImage(data: Buffer, ext = '.png', dir = imagesDir): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)}${ext}`);
	if (!fs.existsSync(file)) fs.writeFileSync(file, data);
	return file;
}

function run(cmd: string, args: string[], encoding: 'buffer' | 'utf8'): Promise<Buffer | string | undefined> {
	return new Promise((resolve) => {
		execFile(cmd, args, { encoding, maxBuffer: MAX_IMAGE_BYTES + 1024, timeout: 5000 }, (error, stdout) =>
			resolve(error ? undefined : stdout),
		);
	});
}

const CLIPBOARD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Images on the clipboard: a copied picture (saved to a file), or image files
 * copied in a file manager. Empty if there are none or the clipboard can't be
 * read (needs wl-paste on Wayland, or xclip on X11).
 */
export async function clipboardImages(dir = imagesDir): Promise<string[]> {
	const wayland = Boolean(process.env['WAYLAND_DISPLAY']);
	const read = (type: string, encoding: 'buffer' | 'utf8') =>
		wayland ? run('wl-paste', ['--no-newline', '--type', type], encoding) : run('xclip', ['-selection', 'clipboard', '-t', type, '-o'], encoding);
	const types = wayland ? await run('wl-paste', ['--list-types'], 'utf8') : await run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], 'utf8');
	if (typeof types !== 'string') return [];
	const offered = types.split('\n').map((t) => t.trim());
	const type = CLIPBOARD_TYPES.find((t) => offered.includes(t));
	if (type) {
		const data = await read(type, 'buffer');
		if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_IMAGE_BYTES) return [];
		const ext = type === 'image/jpeg' ? '.jpg' : `.${type.slice('image/'.length)}`;
		return [saveImage(data, ext, dir)];
	}
	if (offered.includes('text/uri-list')) {
		const list = await read('text/uri-list', 'utf8');
		return typeof list === 'string' ? imagePathsIn(list.split(/\r?\n/).filter((l) => l.startsWith('file://')).join(' '), '/') : [];
	}
	return [];
}

/** Text on the clipboard, for Ctrl+V when it holds no image. */
export async function clipboardText(): Promise<string | undefined> {
	const text = process.env['WAYLAND_DISPLAY']
		? await run('wl-paste', ['--no-newline', '--type', 'text/plain;charset=utf-8'], 'utf8')
		: await run('xclip', ['-selection', 'clipboard', '-o'], 'utf8');
	return typeof text === 'string' ? text : undefined;
}

/** How a pasted image shows up in the prompt. */
export const imageLabel = (n: number) => `[Image #${n}]`;

/**
 * Image files named in a prompt: dragged into the terminal (quoted, with
 * escaped spaces or as file:// URLs) or typed. Only files that exist count.
 */
export function imagePathsIn(text: string, cwd: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/'([^']+)'|"([^"]+)"|((?:\\ |[^\s'"])+)/g)) {
		let candidate = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\\ /g, ' ');
		// Typed in a sentence: "look at cat.png."
		candidate = candidate.replace(/[.,;:!?)]+$/, '').replace(/^\(/, '');
		if (candidate.startsWith('file://')) {
			try {
				candidate = decodeURIComponent(new URL(candidate).pathname);
			} catch {
				continue;
			}
		}
		if (!isImagePath(candidate)) continue;
		if (candidate.startsWith('~/')) candidate = path.join(process.env['HOME'] ?? '', candidate.slice(2));
		const file = path.resolve(cwd, candidate);
		try {
			if (fs.statSync(file).isFile() && !found.includes(file)) found.push(file);
		} catch {
			// Not a file here; just a word that looks like one.
		}
	}
	return found;
}
