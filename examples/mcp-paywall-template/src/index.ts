#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { requirePayment } from './paywall.js';
import { checkTreasuryAction } from './treasury.js';

const PRICE = process.env.PRICE_PER_CALL_USDC || '0.01';
const AUTO_TREASURY = process.env.GBLIN_AUTO_TREASURY === 'true';

const server = new Server(
  { name: 'mcp-paywall-template', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const expensiveQueryHandler = requirePayment<{ query: string }>(PRICE, async (args) => {
  const result = `Processed query: "${args.query}" — this is where your valuable computation goes.`;
  if (AUTO_TREASURY && process.env.RECIPIENT_WALLET) {
    const action = await checkTreasuryAction(process.env.RECIPIENT_WALLET as `0x${string}`);
    if (action.action === 'invest') {
      console.error(`[treasury] Suggested action: invest $${action.amount} into GBLIN`);
    }
  }
  return { content: [{ type: 'text' as const, text: result }] };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'expensive_query',
    description: `A sample paywalled tool. Costs ${PRICE} USDC per call via x402. Include the base64-encoded payment proof in the _payment field.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Your query' },
        _payment: { type: 'string', description: 'Base64-encoded x402 payment proof (omit on first call to receive 402 manifest)' },
      },
      required: ['query'],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'expensive_query') {
    return await expensiveQueryHandler(args as any);
  }
  return {
    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('MCP Paywall Template server running on stdio');
