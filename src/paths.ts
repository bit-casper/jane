import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

function xdg(variable: string, fallback: string): string {
	const value = process.env[variable];
	return value && path.isAbsolute(value) ? value : path.join(home, fallback);
}

export const configDir = path.join(xdg('XDG_CONFIG_HOME', '.config'), 'jane');
export const dataDir = path.join(xdg('XDG_DATA_HOME', '.local/share'), 'jane');
export const stateDir = path.join(xdg('XDG_STATE_HOME', '.local/state'), 'jane');

export const userConfigFile = path.join(configDir, 'config.toml');
export const sessionsDir = path.join(dataDir, 'sessions');
export const logFile = path.join(stateDir, 'jane.log');

export function projectConfigFile(cwd: string): string {
	return path.join(cwd, '.jane', 'config.toml');
}

/** Turn an absolute directory into a single folder name, e.g. /home/a/b -> -home-a-b. */
export function projectSlug(cwd: string): string {
	return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** Show a path with the home directory as ~. */
export function tildify(p: string): string {
	return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}
