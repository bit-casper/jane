// Skills: folders with a SKILL.md (YAML front matter + Markdown instructions),
// in the same format as Claude Code skills, so existing skills work in Jane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configDir } from './paths.js';

export type SkillSource = 'jane' | 'claude' | 'omarchy';
export const SKILL_SOURCES: readonly SkillSource[] = ['jane', 'claude', 'omarchy'];

export type Skill = {
	name: string;
	description: string;
	/** The folder holding SKILL.md and any files it refers to. */
	dir: string;
	file: string;
	source: SkillSource | 'extra';
	/** Only run when the user types /name, never chosen by the model. */
	userOnly: boolean;
};

export const omarchySkillsDir = '/usr/share/omarchy/default/agents/skills';

/** Folders to look in, highest priority first: project before user, Jane before Claude before Omarchy. */
export function skillDirs(
	cwd: string,
	sources: string[],
	extraDirs: string[],
	home = os.homedir(),
	janeDir = configDir,
): { dir: string; source: Skill['source'] }[] {
	const dirs: { dir: string; source: Skill['source'] }[] = [];
	const on = (s: SkillSource) => sources.includes(s);
	if (on('jane')) dirs.push({ dir: path.join(cwd, '.jane', 'skills'), source: 'jane' });
	if (on('claude')) dirs.push({ dir: path.join(cwd, '.claude', 'skills'), source: 'claude' });
	if (on('jane')) dirs.push({ dir: path.join(janeDir, 'skills'), source: 'jane' });
	if (on('claude')) dirs.push({ dir: path.join(home, '.claude', 'skills'), source: 'claude' });
	if (on('omarchy')) dirs.push({ dir: omarchySkillsDir, source: 'omarchy' });
	for (const dir of extraDirs) dirs.push({ dir: dir.startsWith('~/') ? path.join(home, dir.slice(2)) : path.resolve(cwd, dir), source: 'extra' });
	return dirs;
}

/** Split a SKILL.md into its front matter data and body. */
export function parseSkillFile(text: string): { data: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!match) return { data: {}, body: text.trim() };
	let data: unknown;
	try {
		data = parseYaml(match[1]!);
	} catch {
		data = {};
	}
	return {
		data: typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {},
		body: text.slice(match[0].length).trim(),
	};
}

function realDir(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return dir;
	}
}

function isInside(dir: string, parent: string): boolean {
	return dir === parent || dir.startsWith(parent + path.sep);
}

function oneLine(value: unknown): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Find skills: each `<dir>/<skill>/SKILL.md`. When two have the same name, the
 * one from the higher-priority folder wins. Problems are returned as warnings.
 */
export function discoverSkills(dirs: { dir: string; source: Skill['source'] }[]): { skills: Skill[]; warnings: string[] } {
	const byName = new Map<string, Skill>();
	const warnings: string[] = [];
	for (const { dir, source } of dirs) {
		let entries: string[];
		try {
			entries = fs.readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			const file = path.join(dir, entry, 'SKILL.md');
			let text: string;
			try {
				text = fs.readFileSync(file, 'utf8');
			} catch {
				continue; // not a skill folder
			}
			const { data } = parseSkillFile(text);
			const name = oneLine(data['name']) || entry;
			const description = oneLine(data['description']);
			if (!description) {
				warnings.push(`skill "${name}" (${file}) has no description, so it was skipped`);
				continue;
			}
			if (byName.has(name)) continue;
			byName.set(name, {
				name,
				description,
				dir: path.dirname(file),
				file,
				source: isInside(realDir(path.dirname(file)), omarchySkillsDir) ? 'omarchy' : source,
				userOnly: data['disable-model-invocation'] === true,
			});
		}
	}
	return { skills: [...byName.values()], warnings };
}

/** The instructions of a skill, for the model, with a note on where its other files are. */
export function skillContent(skill: Skill): string {
	const { body } = parseSkillFile(fs.readFileSync(skill.file, 'utf8'));
	return `Skill "${skill.name}" from ${skill.dir}\nFiles this skill mentions are in that folder; open them with the read tool when you need them.\n\n${body}`;
}

/** The skills part of the system prompt. */
export function skillsPrompt(skills: Skill[]): string | undefined {
	const listed = skills.filter((s) => !s.userOnly);
	if (listed.length === 0) return undefined;
	return [
		'# Skills',
		'Skills hold instructions for specific kinds of tasks, written for this machine. When a task matches a skill below, call the skill tool with that skill\'s name FIRST, before any other tool (even before looking at files), and then follow what it says. Don\'t guess at how to do something a skill covers.',
		'',
		...listed.map((s) => `- ${s.name}: ${s.description}`),
	].join('\n');
}

/** The user message sent for /<skill> [request]: the skill's instructions, then the request. */
export function skillMessage(skill: Skill, content: string, request: string): string {
	return `<skill name="${skill.name}">\n${content}\n</skill>\n\n${request || 'Follow the skill above.'}`;
}

/** What the user typed, for a message made by skillMessage (or the message itself). */
export function typedText(message: string): string {
	const m = /^<skill name="([^"]+)">\n[\s\S]*\n<\/skill>\n\n([\s\S]*)$/.exec(message);
	if (!m) return message;
	return m[2] === 'Follow the skill above.' ? `/${m[1]}` : `/${m[1]} ${m[2]}`;
}
