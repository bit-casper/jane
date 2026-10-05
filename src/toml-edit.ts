// Change one value in a TOML file while keeping everything else (comments,
// order, spacing) as the user wrote it.

import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';

type Table = Record<string, unknown>;

function formatValue(value: unknown): string {
	return stringify({ v: value }).trim().replace(/^v = /, '');
}

function getPath(obj: Table, keys: string[]): unknown {
	let cur: unknown = obj;
	for (const key of keys) {
		if (typeof cur !== 'object' || cur === null || !(key in cur)) return undefined;
		cur = (cur as Table)[key];
	}
	return cur;
}

function setPath(obj: Table, keys: string[], value: unknown): void {
	let cur = obj;
	for (const key of keys.slice(0, -1)) {
		if (typeof cur[key] !== 'object' || cur[key] === null) {
			if (value === undefined) return; // nothing to remove
			cur[key] = {};
		}
		cur = cur[key] as Table;
	}
	const last = keys.at(-1)!;
	if (value === undefined) delete cur[last];
	else cur[last] = value;
}

/** A plain copy without empty tables, so removing a section's last key compares equal. */
function prune(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
	const out: Table = {};
	for (const [k, v] of Object.entries(value)) {
		const p = prune(v);
		if (typeof p === 'object' && p !== null && !Array.isArray(p) && Object.keys(p).length === 0) continue;
		out[k] = p;
	}
	return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A `# comment` after a value, if the value before it is valid TOML on its own. */
function trailingComment(line: string): string {
	const eq = line.indexOf('=');
	for (let i = line.indexOf('#', eq); i !== -1; i = line.indexOf('#', i + 1)) {
		try {
			parse(`v = ${line.slice(eq + 1, i).trim()}`);
			return '  ' + line.slice(i);
		} catch {}
	}
	return '';
}

function editLines(text: string, keys: string[], value: unknown): string {
	const section = keys.slice(0, -1).join('.');
	const key = keys.at(-1)!;
	const lines = text.split('\n');
	const header = new RegExp(`^\\s*\\[\\s*${escape(section).replace(/\\\./g, '\\s*\\.\\s*')}\\s*\\]\\s*(#.*)?$`);
	const start = lines.findIndex((l) => header.test(l));

	if (start === -1) {
		if (value === undefined) return text;
		const body = text.replace(/\n*$/, '');
		return `${body}${body ? '\n\n' : ''}[${section}]\n${key} = ${formatValue(value)}\n`;
	}

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s*\[/.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	const keyLine = new RegExp(`^(\\s*)${escape(key)}\\s*=`);
	for (let i = start + 1; i < end; i++) {
		const match = keyLine.exec(lines[i]!);
		if (!match) continue;
		if (value === undefined) {
			lines.splice(i, 1);
			// Drop the section header too if nothing but blank lines is left in it.
			if (lines.slice(start + 1, end - 1).every((l) => l.trim() === '')) {
				lines.splice(start, end - 1 - start);
			}
			const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
			return out ? out + '\n' : '';
		} else lines[i] = `${match[1]}${key} = ${formatValue(value)}${trailingComment(lines[i]!)}`;
		return lines.join('\n');
	}
	if (value === undefined) return text;
	// Add after the last non-empty line of the section.
	let at = end;
	while (at > start + 1 && lines[at - 1]!.trim() === '') at--;
	lines.splice(at, 0, `${key} = ${formatValue(value)}`);
	return lines.join('\n');
}

/**
 * Set `keys` to `value` in the TOML `text` (or remove it when `value` is
 * undefined). Edits just the one line when it can; if the file is laid out in
 * a way that makes that unsafe, it rewrites the file from the parsed data.
 */
export function setTomlValue(text: string, keys: string[], value: unknown): string {
	const edited = editLines(text, keys, value);
	try {
		const result = parse(edited) as Table;
		const original = text.trim() ? (parse(text) as Table) : {};
		setPath(original, keys, value);
		if (isDeepStrictEqual(prune(result), prune(original))) return edited;
	} catch {}
	const data = text.trim() ? (parse(text) as Table) : {};
	setPath(data, keys, value);
	return stringify(data) + '\n';
}

export { getPath };
