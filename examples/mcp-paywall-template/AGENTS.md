# Agent Instructions — MCP Paywall Template

This is a starter template for an MCP server with x402 paywall.

## Project structure

- `src/index.ts` — MCP server entry point, registers paywalled tools
- `src/paywall.ts` — x402 payment verification middleware
- `src/treasury.ts` — optional auto-invest hook into GBLIN

## How to extend

1. Add a new tool in `src/index.ts` with `server.registerTool(...)`
2. Wrap the tool's handler with `requirePayment(price)` from `src/paywall.ts`
3. Set environment variables in `.env`

## Treasury hook

If `GBLIN_AUTO_TREASURY=true`, revenue above $5 USDC will auto-invest into GBLIN every 6 hours. For other treasury options, see the parent `skills/base-agent-treasury` skill.
