import type { ToolSchema } from '../client.js';
import { bashTool } from './bash.js';
import { editTool, readTool, writeTool } from './files.js';
import { globTool, grepTool } from './search.js';
import type { Tool } from './types.js';

export const tools: Tool<any>[] = [readTool, writeTool, editTool, bashTool, globTool, grepTool];

export function findTool(name: string, list: Tool<any>[] = tools): Tool<any> | undefined {
	return list.find((t) => t.name === name);
}

export function toolSchemas(list: Tool<any>[] = tools): ToolSchema[] {
	return list.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.schema ?? {
				type: 'object',
				properties: Object.fromEntries(
					Object.entries(tool.params).map(([key, spec]) => [key, { type: spec.type, description: spec.description }]),
				),
				required: Object.entries(tool.params)
					.filter(([, spec]) => spec.required)
					.map(([key]) => key),
			},
		},
	}));
}

/**
 * Parse and check a tool call's arguments. Returns the arguments, or an error
 * message written for the model so it can fix the call. Small models often
 * send numbers and booleans as strings, so those are converted.
 */
export function parseArgs(tool: Tool<any>, raw: string): { args: Record<string, unknown> } | { error: string } {
	let parsed: unknown;
	try {
		parsed = raw.trim() === '' ? {} : JSON.parse(raw);
	} catch {
		return { error: `The arguments for ${tool.name} are not valid JSON: ${raw.slice(0, 200)}` };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { error: `The arguments for ${tool.name} must be a JSON object.` };
	}
	// Tools with their own schema (MCP) check their arguments themselves.
	if (tool.schema) return { args: parsed as Record<string, unknown> };
	const args = { ...(parsed as Record<string, unknown>) };
	const problems: string[] = [];
	for (const [key, spec] of Object.entries(tool.params)) {
		let value = args[key];
		if (value === undefined || value === null) {
			delete args[key];
			if (spec.required) problems.push(`"${key}" is required`);
			continue;
		}
		if (spec.type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) value = Number(value);
		if (spec.type === 'boolean' && (value === 'true' || value === 'false')) value = value === 'true';
		const ok =
			spec.type === 'integer' ? Number.isInteger(value) : spec.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string';
		if (!ok) problems.push(`"${key}" must be a ${spec.type}`);
		args[key] = value;
	}
	for (const key of Object.keys(args)) {
		if (!(key in tool.params)) delete args[key];
	}
	if (problems.length) return { error: `Invalid arguments for ${tool.name}: ${problems.join(', ')}.` };
	return { args };
}
