// Tiny MCP server (stdio) used by blackbox-mcp.test.ts: a calculator with an `add` tool.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'calc', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
    },
    { name: 'divide', description: 'Divide a by b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
    { name: 'weird.name/with spaces', description: 'Echo the arguments', inputSchema: { type: 'object' } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'add') return { content: [{ type: 'text', text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } };
  if (name === 'divide') {
    if (args.b === 0) return { isError: true, content: [{ type: 'text', text: 'division by zero' }] };
    return { content: [{ type: 'text', text: String(args.a / args.b) }] };
  }
  if (name === 'weird.name/with spaces') return { content: [{ type: 'text', text: JSON.stringify(args) }, { type: 'text', text: `pid=${process.pid}` }] };
  throw new Error(`unknown tool ${name}`);
});

await server.connect(new StdioServerTransport());
