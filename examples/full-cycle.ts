/**
 * GBLIN full agent treasury cycle — RUNNABLE demo (read-only, no keys needed).
 *
 *   npx tsx examples/full-cycle.ts
 *
 * What it does, live against Base mainnet through the GBLIN MCP server:
 *   1. Reads treasury state (NAV, basket, Crash Shield) — on-chain quotes
 *   2. Checks the market-risk regime (the same math agents gate decisions on)
 *   3. Fetches a free risk attestation sample and verifies its EIP-712 digest
 *   4. Asks for the calldata to invest 10 USDC of idle cash into GBLIN
 *   5. Asks for the JIT calldata to redeem exactly 0.50 USDC for an x402 invoice
 *
 * SAFETY: this demo never holds keys and never broadcasts. Steps 4-5 return
 * ABI-encoded calldata with MEV-safe minOut values — broadcasting them (or not)
 * is entirely your wallet's decision. That is the GBLIN integration model.
 *
 * To buy a LIVE attestation instead of the sample ($0.003 over x402), see
 * `how_to_buy_live_attestation` on the hosted MCP, or use any x402 client
 * against GET https://gblin.digital/api/x402/attestation
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEMO_WALLET = process.env.DEMO_WALLET ?? "0x9ffa542e369c53af62380296092ec669f329a9ee";

function parse(res: unknown): any {
  const item = (res as { content: Array<{ text: string }> }).content[0];
  try { return JSON.parse(item.text); } catch { return item.text; }
}
const step = (n: number, title: string) => console.log(`\n━━ Step ${n} — ${title}`);

// Default spawns the published npm package. -p + explicit bin works on every
// published version (the package ships more than one executable, so the bare
// package name is ambiguous for npx). Inside a checkout of this repo, run the
// local build instead with: GBLIN_MCP_COMMAND="node dist/index.js"
const [cmd, ...cmdArgs] = (process.env.GBLIN_MCP_COMMAND ??
  "npx -y -p @gblin-protocol/mcp-server gblin-mcp").split(" ");
const transport = new StdioClientTransport({
  command: cmd,
  args: cmdArgs,
  env: { ...process.env, GBLIN_RPC_URL: process.env.GBLIN_RPC_URL ?? "https://base-rpc.publicnode.com" },
});
const mcp = new Client({ name: "gblin-full-cycle-demo", version: "1.0.0" });
await mcp.connect(transport);
console.log("Connected to GBLIN MCP server (Base mainnet, on-chain reads only).");

step(1, "Treasury state — NAV, basket, Crash Shield");
const state = parse(await mcp.callTool({ name: "get_treasury_state", arguments: {} }));
console.log(JSON.stringify(state, null, 2).slice(0, 600));

step(2, "Market-risk regime — the signal agents gate decisions on");
// Free over local stdio; the same signal is also sold as a SIGNED EIP-712
// attestation over HTTP x402 ($0.003) when you need a proof you can hand
// to a counterparty instead of a plain reading.
const regime = parse(await mcp.callTool({ name: "get_market_risk_regime", arguments: {} }));
console.log(JSON.stringify(regime, null, 2).slice(0, 500));

step(3, "Free attestation sample + offline EIP-712 verification");
const sample = await fetch("https://gblin.digital/api/x402/attestation-sample").then(r => r.json());
console.log(`sample.attestation_id: ${sample.attestation_id}`);
const verdict = parse(await mcp.callTool({
  name: "verify_risk_attestation",
  arguments: { attestation: sample },
}));
console.log("verification:", JSON.stringify(verdict, null, 2).slice(0, 400));

step(4, "Invest 10 idle USDC into GBLIN — calldata only, MEV-safe minOut");
const invest = parse(await mcp.callTool({
  name: "invest_usdc_to_gblin",
  arguments: { usdc_amount: "10.00", wallet_address: DEMO_WALLET },
}));
console.log(JSON.stringify(invest, null, 2).slice(0, 600));

step(5, "x402 invoice for $0.50 arrives → JIT redemption calldata");
const jit = parse(await mcp.callTool({
  name: "swap_gblin_to_usdc_jit",
  arguments: { usdc_needed: "0.50", wallet_address: DEMO_WALLET },
}));
console.log(JSON.stringify(jit, null, 2).slice(0, 600));

console.log(`\nDone. No keys were used, nothing was broadcast — every step above is
either a public on-chain read or calldata your own wallet may choose to send.
Whom should an agent pay? Someone it can verify. Docs: https://gblin.digital/agents`);
await mcp.close();
