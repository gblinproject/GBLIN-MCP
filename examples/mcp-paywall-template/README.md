# MCP Paywall Template

A minimal Model Context Protocol server with x402 micropayment paywall and optional GBLIN auto-treasury hook. MIT-licensed starting point for monetized MCP tools.

## What it does

1. Exposes a sample tool (`expensive-query`) that requires payment in USDC via x402
2. Verifies the payment proof in the `X-Payment` header
3. Optionally auto-invests accumulated revenue into GBLIN treasury

## Quick start

```bash
git clone <this-repo>
cd mcp-paywall-template
npm install
cp .env.example .env
# Edit .env with your RECIPIENT_WALLET
npm run dev
```

## Add to Claude Desktop / Cursor / Windsurf

```json
{
  "mcpServers": {
    "my-paywalled-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-paywall-template/dist/index.js"],
      "env": {
        "RECIPIENT_WALLET": "0xYourWallet"
      }
    }
  }
}
```

## Adding your own tools

1. Open `src/index.ts`
2. Add a new tool registration:

```typescript
server.registerTool(
  'my-tool',
  {
    title: 'My Tool',
    description: 'What this tool does',
    inputSchema: { /* zod schema */ },
  },
  requirePayment('0.05', async (args) => {
    // Your tool logic here
    return { content: [{ type: 'text', text: 'Result' }] };
  })
);
```

## License

MIT. Fork freely.

## Related

- GBLIN MCP server: https://github.com/gblinproject/GBLIN-MCP
- x402 spec: https://www.x402.org
- Skills for treasury patterns: see `../../skills/`
