import chalk, { type ChalkInstance } from 'chalk';
import { createContext, useContext } from 'react';
import type { Config } from '../config.js';

export type Colors = Config['ui']['colors'];

/** A chalk function for a colour name ("cyan", "gray") or hex ("#88c0d0"). */
export function paint(color: string): ChalkInstance {
	if (color.startsWith('#')) return chalk.hex(color);
	const fn = (chalk as unknown as Record<string, ChalkInstance>)[color === 'grey' ? 'gray' : color];
	return typeof fn === 'function' ? fn : chalk.reset;
}

export const ThemeContext = createContext<Colors>(null as unknown as Colors);

export function useColors(): Colors {
	return useContext(ThemeContext);
}
