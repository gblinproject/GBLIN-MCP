#!/usr/bin/env node
/**
 * GBLIN MCP Server — entry point.
 *
 * Speaks the Model Context Protocol over stdio. Clients (Claude Desktop,
 * AgentKit, Eliza, custom agents) discover and invoke the 9 GBLIN tools.
 *
 * IMPORTANT: never write to stdout via console.log — that channel is reserved
 * for MCP JSON-RPC frames. Use console.error (stderr) for diagnostics.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools.js";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return handler(args ?? {}) as any;
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[${SERVER_NAME}] v${SERVER_VERSION} online — listening on stdio (${TOOL_DEFINITIONS.length} tools registered).`
  );
}

main().catch((err) => {
  console.error("[gblin-mcp] fatal:", err);
  process.exit(1);
});
