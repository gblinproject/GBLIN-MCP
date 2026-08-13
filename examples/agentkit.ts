/**
 * Coinbase AgentKit (or any MCP-speaking TypeScript agent) + GBLIN in ~20 lines.
 *
 * The GBLIN MCP server returns JSON results and ABI-encoded calldata only:
 * it never holds keys and never broadcasts. Your wallet stays in control.
 *
 * npm i @modelcontextprotocol/sdk
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@gblin-protocol/mcp-server"],
  env: { GBLIN_RPC_URL: "https://base-rpc.publicnode.com" },
});

const mcp = new Client({ name: "my-agent", version: "1.0.0" });
await mcp.connect(transport);

// 1) Read treasury state (free, on-chain quotes — no oracle trust needed)
const state = await mcp.callTool({ name: "get_treasury_state", arguments: {} });
console.log(JSON.parse((state.content as any)[0].text));

// 2) Park 10 USDC of surplus into GBLIN (returns 2-step calldata: approve + buy,
//    both with MEV-safe positive minOut — broadcast them with your own wallet)
const invest = await mcp.callTool({
  name: "invest_usdc_to_gblin",
  arguments: { usdc_amount: "10.00", wallet_address: "0xYourAgentWallet" },
});

// 3) Later, an x402 invoice for $0.50 arrives → JIT-redeem exactly that much
const jit = await mcp.callTool({
  name: "swap_gblin_to_usdc_jit",
  arguments: { usdc_needed: "0.50", wallet_address: "0xYourAgentWallet" },
});
// jit → ready-to-broadcast steps; works on EOA, ERC-4337 and EIP-7702 wallets.
