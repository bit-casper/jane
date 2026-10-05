// The block list: bash commands Jane always refuses, even in unrestricted mode.
// It's a safety net against accidents, not a security boundary.

/** Built-in rules: a readable name and a regular expression (case-sensitive). */
const BUILT_IN: { name: string; pattern: string }[] = [
	{
		name: 'rm -r on / or your home folder',
		pattern: String.raw`\brm\s+(?:-\S+\s+)*-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\s+(?:-\S+\s+)*["']?(?:/|~|\$HOME|\$\{HOME\})/?\*?["']?(?:\s|;|&|\||$)`,
	},
	{ name: 'formatting a disk (mkfs)', pattern: String.raw`\bmkfs(?:\.\w+)?\b` },
	{ name: 'wiping a disk (wipefs)', pattern: String.raw`\bwipefs\b` },
	{ name: 'dd onto a disk', pattern: String.raw`\bdd\b[^;&|]*\bof=/dev/(?:sd|nvme|mmcblk|hd|vd|xvd|disk)` },
	{ name: 'writing onto a disk', pattern: String.raw`>\s*/dev/(?:sd[a-z]|nvme\d|mmcblk\d|hd[a-z]|vd[a-z])` },
	{ name: 'shredding a disk', pattern: String.raw`\bshred\b[^;&|]*/dev/` },
	{ name: 'fork bomb', pattern: String.raw`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:` },
	{ name: 'chmod/chown -R on /', pattern: String.raw`\bch(?:mod|own)\s+(?:-\S+\s+)*-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+/(?:\s|$)` },
];

/** The built-in patterns, as they appear in the config. */
export const DEFAULT_BLOCK_PATTERNS = BUILT_IN.map((r) => r.pattern);

/** A readable name for a pattern: the built-in rule's name, or the pattern itself. */
export function describeRule(pattern: string): string {
	return BUILT_IN.find((r) => r.pattern === pattern)?.name ?? pattern;
}

export type BlockRule = { pattern: string; regex: RegExp };

/** Compile the patterns; returns the rules and warnings for patterns that aren't valid regexes. */
export function compileBlockList(patterns: string[]): { rules: BlockRule[]; warnings: string[] } {
	const rules: BlockRule[] = [];
	const warnings: string[] = [];
	for (const pattern of patterns) {
		try {
			rules.push({ pattern, regex: new RegExp(pattern) });
		} catch (error) {
			warnings.push(`block list pattern ${JSON.stringify(pattern)} isn't a valid regular expression (${(error as Error).message})`);
		}
	}
	return { rules, warnings };
}

/** The rule a command breaks, if any. */
export function blockedBy(command: string, rules: BlockRule[]): BlockRule | undefined {
	// Join lines continued with a backslash so a pattern can't be dodged by a line break.
	const flat = command.replace(/\\\n/g, ' ');
	return rules.find((rule) => rule.regex.test(flat));
}
