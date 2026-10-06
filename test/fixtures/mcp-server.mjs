// A small MCP server for tests: echo (read-only), shout (changes things), broken (fails).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'test-server', version: '1.0.0' });
server.registerTool(
	'echo',
	{ description: 'Repeat a message.', inputSchema: { message: z.string() }, annotations: { readOnlyHint: true } },
	async ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }),
);
server.registerTool('shout', { description: 'Shout a message.', inputSchema: { message: z.string() } }, async ({ message }) => ({
	content: [{ type: 'text', text: message.toUpperCase() }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
}));
server.registerTool('broken', { description: 'Always fails.' }, async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }));
if (process.env.TEST_SERVER_STDERR) console.error(process.env.TEST_SERVER_STDERR);
await server.connect(new StdioServerTransport());
