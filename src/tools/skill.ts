import { type Skill, skillContent } from '../skills.js';
import { type Tool, ToolError } from './types.js';

type SkillArgs = { name: string };

/** The skill tool loads a skill's full instructions when the model decides it needs them. */
export function makeSkillTool(getSkills: () => Skill[]): Tool<SkillArgs> {
	return {
		name: 'skill',
		description:
			'Load the full instructions of one of the skills listed in the system prompt. ' +
			'Call it when a task matches a skill, before doing the task.',
		params: {
			name: { type: 'string', description: 'The skill name, exactly as listed', required: true },
		},
		needsPermission: false,
		label: (args) => args.name,
		async run(args) {
			const skills = getSkills().filter((s) => !s.userOnly);
			const skill = skills.find((s) => s.name === args.name) ?? skills.find((s) => s.name.toLowerCase() === args.name.toLowerCase());
			if (!skill) {
				const names = skills.map((s) => s.name).join(', ') || '(none)';
				throw new ToolError(`There is no skill called "${args.name}". The skills are: ${names}.`);
			}
			let content: string;
			try {
				content = skillContent(skill);
			} catch (error) {
				throw new ToolError(`Could not read ${skill.file}: ${(error as Error).message}`);
			}
			return { output: content, display: { summary: `Loaded ${skill.source} skill` } };
		},
	};
}
