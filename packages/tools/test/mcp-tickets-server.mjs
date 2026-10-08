// MCP server fixture (stdio by default, streamable HTTP with `--http`) used by the MCP production-composition tests: a tiny
// ticket tracker. `create_ticket` appends to the JSON-lines file named by TICKETS_FILE (a real, observable side effect)
// and needs TICKETS_TOKEN (passed by NAME through the configuration's envFrom; over HTTP the bearer token of the
// configured `authorization` header must equal it); `list_tickets` reads the file. Started by the tests through the
// configuration (`tools.mcpServers`), never imported.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const file = process.env.TICKETS_FILE;
const token = process.env.TICKETS_TOKEN;

function tickets() {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function newServer(authorized) {
  const server = new Server({ name: 'tickets', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'create_ticket', description: 'Create a ticket', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      { name: 'list_tickets', description: 'List the tickets', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (!authorized) return { isError: true, content: [{ type: 'text', text: 'unauthenticated: TICKETS_TOKEN is missing' }] };
    if (name === 'create_ticket') {
      const ticket = { id: tickets().length + 1, title: String(args.title) };
      appendFileSync(file, `${JSON.stringify(ticket)}\n`);
      return { content: [{ type: 'text', text: `created ticket ${ticket.id}` }], structuredContent: ticket };
    }
    if (name === 'list_tickets') {
      const all = tickets();
      return { content: [{ type: 'text', text: JSON.stringify(all) }], structuredContent: { count: all.length, tickets: all } };
    }
    throw new Error(`unknown tool ${name}`);
  });
  return server;
}

const httpAt = process.argv.indexOf('--http');
if (httpAt >= 0) {
  // stateless streamable HTTP: one server + transport per request; the bearer token must equal TICKETS_TOKEN
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const authorized = typeof token === 'string' && token !== '' && req.headers.authorization === `Bearer ${token}`;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = newServer(authorized);
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  http.listen(Number(process.argv[httpAt + 1] ?? 0), '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${http.address().port}/mcp` })}\n`);
  });
  process.on('SIGTERM', () => http.close(() => process.exit(0)));
} else {
  await newServer(typeof token === 'string' && token !== '').connect(new StdioServerTransport());
}
