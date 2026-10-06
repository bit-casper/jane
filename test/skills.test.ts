import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
	discoverSkills,
	omarchySkillsDir,
	parseSkillFile,
	skillContent,
	skillDirs,
	skillMessage,
	skillsPrompt,
	typedText,
} from '../src/skills.js';
import { makeSkillTool } from '../src/tools/skill.js';

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jane-skills-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeSkill(root: string, folder: string, frontMatter: string, body = 'Do the thing.') {
	fs.mkdirSync(path.join(root, folder), { recursive: true });
	fs.writeFileSync(path.join(root, folder, 'SKILL.md'), `---\n${frontMatter}\n---\n\n${body}\n`);
}

describe('skills', () => {
	it('reads front matter written like the Omarchy skills', () => {
		const { data, body } = parseSkillFile(
			'---\nname: omarchy\ndescription: >\n  REQUIRED for end-user customization.\n  Use when editing ~/.config/hypr/.\n---\n\n# Omarchy\nText',
		);
		expect(data['name']).toBe('omarchy');
		expect(data['description']).toBe('REQUIRED for end-user customization. Use when editing ~/.config/hypr/.\n');
		expect(body).toBe('# Omarchy\nText');
		expect(parseSkillFile('no front matter')).toEqual({ data: {}, body: 'no front matter' });
	});

	it('looks in project, user, Claude and Omarchy folders, in that order', () => {
		const dirs = skillDirs('/proj', ['jane', 'claude', 'omarchy'], ['~/more', 'rel'], '/home/u', '/home/u/.config/jane');
		expect(dirs).toEqual([
			{ dir: '/proj/.jane/skills', source: 'jane' },
			{ dir: '/proj/.claude/skills', source: 'claude' },
			{ dir: '/home/u/.config/jane/skills', source: 'jane' },
			{ dir: '/home/u/.claude/skills', source: 'claude' },
			{ dir: omarchySkillsDir, source: 'omarchy' },
			{ dir: '/home/u/more', source: 'extra' },
			{ dir: '/proj/rel', source: 'extra' },
		]);
		expect(skillDirs('/proj', ['omarchy'], [], '/home/u').map((d) => d.source)).toEqual(['omarchy']);
	});

	it('finds skills, lets higher-priority folders win, and skips broken ones', () => {
		const project = path.join(dir, 'project');
		const user = path.join(dir, 'user');
		writeSkill(project, 'deploy', 'name: deploy\ndescription: Project deploy steps');
		writeSkill(user, 'deploy', 'name: deploy\ndescription: User deploy steps');
		writeSkill(user, 'notes-folder', 'description: "No name: uses the folder name"');
		writeSkill(user, 'broken', 'name: broken');
		writeSkill(user, 'manual', 'name: manual\ndescription: Only by hand\ndisable-model-invocation: true');
		fs.writeFileSync(path.join(user, 'README.md'), 'not a skill');

		const { skills, warnings } = discoverSkills([
			{ dir: project, source: 'jane' },
			{ dir: user, source: 'claude' },
			{ dir: path.join(dir, 'missing'), source: 'omarchy' },
		]);
		expect(skills.map((s) => [s.name, s.source, s.description])).toEqual([
			['deploy', 'jane', 'Project deploy steps'],
			['manual', 'claude', 'Only by hand'],
			['notes-folder', 'claude', 'No name: uses the folder name'],
		]);
		expect(skills.find((s) => s.name === 'manual')?.userOnly).toBe(true);
		expect(warnings).toEqual([expect.stringMatching(/skill "broken" .* has no description/)]);
	});

	it('follows symlinked skill folders, like ~/.claude/skills/omarchy', () => {
		writeSkill(path.join(dir, 'real'), 'linked', 'name: linked\ndescription: Through a symlink');
		fs.mkdirSync(path.join(dir, 'claude'));
		fs.symlinkSync(path.join(dir, 'real', 'linked'), path.join(dir, 'claude', 'linked'));
		const { skills } = discoverSkills([{ dir: path.join(dir, 'claude'), source: 'claude' }]);
		expect(skills.map((s) => s.name)).toEqual(['linked']);
	});

	it('lists skills for the model, leaving out the ones only the user runs', () => {
		const { skills } = (() => {
			writeSkill(dir, 'a', 'name: a\ndescription: First');
			writeSkill(dir, 'b', 'name: b\ndescription: Second\ndisable-model-invocation: true');
			return discoverSkills([{ dir, source: 'jane' }]);
		})();
		expect(skillsPrompt(skills)).toEqual(
			expect.stringMatching(/^# Skills\nSkills hold instructions .* FIRST, before any other tool .*\n\n- a: First$/),
		);
		expect(skillsPrompt(skills.filter((s) => s.userOnly))).toBeUndefined();
	});

	it('loads a skill through the skill tool', async () => {
		writeSkill(dir, 'omarchy', 'name: omarchy\ndescription: Desktop config', '# Omarchy\nSee hyprland.md');
		writeSkill(dir, 'secret', 'name: secret\ndescription: Hidden\ndisable-model-invocation: true');
		const { skills } = discoverSkills([{ dir, source: 'omarchy' }]);
		const tool = makeSkillTool(() => skills);
		const ctx = { cwd: dir, signal: new AbortController().signal };
		const result = await tool.run({ name: 'Omarchy' }, ctx);
		expect(result.output).toBe(
			`Skill "omarchy" from ${path.join(dir, 'omarchy')}\nFiles this skill mentions are in that folder; open them with the read tool when you need them.\n\n# Omarchy\nSee hyprland.md`,
		);
		expect(result.display?.summary).toBe('Loaded omarchy skill');
		await expect(tool.run({ name: 'secret' }, ctx)).rejects.toThrow('There is no skill called "secret". The skills are: omarchy.');
	});

	it('shows a /skill message as what the user typed', () => {
		const skill = { name: 'omarchy', description: '', dir: '', file: '', source: 'omarchy' as const, userOnly: false };
		const content = 'Line one\n</skill> inside the text\nLine three';
		expect(typedText(skillMessage(skill, content, 'make the gaps bigger'))).toBe('/omarchy make the gaps bigger');
		expect(typedText(skillMessage(skill, content, ''))).toBe('/omarchy');
		expect(typedText('just a prompt')).toBe('just a prompt');
	});

	it('reads the skills settings and warns about unknown sources', () => {
		const file = path.join(dir, 'c.toml');
		fs.writeFileSync(file, '[skills]\nsources = ["claude", "cursor"]\nextra_dirs = ["~/my-skills"]\n');
		const { config, warnings } = loadConfig(dir, [file]);
		expect(config.skills).toEqual({ sources: ['claude'], extra_dirs: ['~/my-skills'] });
		expect(warnings).toEqual([expect.stringMatching(/not "cursor"/)]);
	});

	it('reads the real Omarchy skills when they are installed', () => {
		if (!fs.existsSync(omarchySkillsDir)) return;
		const { skills, warnings } = discoverSkills([{ dir: omarchySkillsDir, source: 'omarchy' }]);
		expect(warnings).toEqual([]);
		expect(skills.map((s) => s.name)).toContain('omarchy');
		expect(skillContent(skills.find((s) => s.name === 'omarchy')!)).toMatch(/^Skill "omarchy" from /);
	});
});
