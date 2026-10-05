import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCK_PATTERNS, blockedBy, compileBlockList, describeRule } from '../src/blocklist.js';
import { loadConfig } from '../src/config.js';

const { rules } = compileBlockList(DEFAULT_BLOCK_PATTERNS);
const blocked = (command: string) => blockedBy(command, rules) !== undefined;

describe('block list', () => {
	it('blocks disasters', () => {
		for (const command of [
			'rm -rf /',
			'rm -rf ~',
			'rm -rf ~/',
			'rm -rf ~/*',
			'rm -fr /*',
			'rm -r -f /',
			'rm -f -r ~',
			'rm --recursive --force /',
			'sudo rm -rf --no-preserve-root /',
			'rm -Rf $HOME',
			'rm -rf "$HOME"',
			'rm -rf ${HOME}/',
			'cd /tmp && rm -rf ~ && echo done',
			'rm -rf \\\n  /',
			'mkfs.ext4 /dev/sda1',
			'sudo mkfs -t btrfs /dev/nvme0n1p2',
			'wipefs -a /dev/sda',
			'dd if=/dev/zero of=/dev/sda bs=1M',
			'sudo dd if=image.iso of=/dev/nvme0n1',
			'cat x > /dev/sda',
			'shred -n 1 /dev/nvme0n1',
			':(){ :|:& };:',
			'chmod -R 777 /',
			'sudo chown -R me:me /',
		]) {
			expect(blocked(command), command).toBe(true);
		}
	});

	it('allows everyday commands', () => {
		for (const command of [
			'rm -rf node_modules',
			'rm -rf ./dist',
			'rm -rf /tmp/build',
			'rm -rf ~/projects/old-thing',
			'rm -rf "$HOME/.cache/jane"',
			'rm -f /tmp/x',
			'rm ~/notes.txt',
			'rm -rf build/ && npm run build',
			'ls -la / ~',
			'dd if=/dev/zero of=./disk.img bs=1M count=10',
			'echo hi > /dev/null',
			'cat /dev/sda1.log',
			'chmod -R 755 ./public',
			'chown -R me:me ~/project',
			'npm run format',
			'grep -r mkfsd .',
		]) {
			expect(blocked(command), command).toBe(false);
		}
	});

	it('names the built-in rules', () => {
		expect(describeRule(blockedBy('rm -rf ~', rules)!.pattern)).toBe('rm -r on / or your home folder');
		expect(describeRule(blockedBy('mkfs.ext4 /dev/sda1', rules)!.pattern)).toBe('formatting a disk (mkfs)');
		expect(describeRule('my-own-rule')).toBe('my-own-rule');
	});

	it('reports invalid patterns', () => {
		const { rules: compiled, warnings } = compileBlockList(['ok', '(broken']);
		expect(compiled.map((r) => r.pattern)).toEqual(['ok']);
		expect(warnings).toEqual([expect.stringMatching(/"\(broken" isn't a valid regular expression/)]);
	});

	it('comes from the config, where it can be turned off', () => {
		const { config } = loadConfig('/nowhere', []);
		expect(config.block_list).toEqual({ enabled: true, patterns: DEFAULT_BLOCK_PATTERNS });
	});
});
