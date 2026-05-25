/**
 * GBLIN Demo Agent — Complete end-to-end example
 * Shows all 6 MCP tools against Base mainnet (read-only, no transactions broadcast)
 *
 * Run: npx tsx examples/demo-agent.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEMO_WALLET = "0x0ebA5d314F4f5Dcb7A094953Fa9311a45172dd1B"; // GBLIN fee wallet as demo

async function runDemoAgent() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@gblin-protocol/mcp-server"],
  });

  const client = new Client({ name: "gblin-demo-agent", version: "1.0.0" });
  await client.connect(transport);

  console.log("=== GBLIN Demo Agent — All 6 Tools ===\n");

  // ─── Tool 1: get_treasury_state ───────────────────────────────────────────
  console.log("📊 [1/6] get_treasury_state");
  const treasuryResult = await client.callTool({
    name: "get_treasury_state",
    arguments: {},
  });
  const treasury = JSON.parse((treasuryResult.content[0] as { text: string }).text);
  console.log(`  NAV:           $${treasury.nav_usd}`);
  console.log(`  ETH price:     $${treasury.eth_price_usd}`);
  console.log(`  Crash Shield:  ${treasury.crash_shield_active ? "🔴 ACTIVE" : "🟢 inactive"}`);
  console.log(`  Slippage buf:  ${treasury.slippage_buffer_pct}% (${treasury.slippage_reason})\n`);

  // ─── Tool 2: quote_safe_swap (buy) ────────────────────────────────────────
  console.log("💱 [2/6] quote_safe_swap — buy preview (0.001 ETH)");
  const buyQuoteResult = await client.callTool({
    name: "quote_safe_swap",
    arguments: { direction: "buy", amount_in: "0.001" },
  });
  const buyQuote = JSON.parse((buyQuoteResult.content[0] as { text: string }).text);
  console.log(`  Expected GBLIN out: ${buyQuote.expected_gblin_out}`);
  console.log(`  Safe min GBLIN:     ${buyQuote.safe_min_gblin_out}`);
  console.log(`  Slippage buffer:    ${buyQuote.slippage_buffer_bps} bps\n`);

  // ─── Tool 2b: quote_safe_swap (sell) ─────────────────────────────────────
  console.log("💱 [2b/6] quote_safe_swap — sell preview (1.0 GBLIN)");
  const sellQuoteResult = await client.callTool({
    name: "quote_safe_swap",
    arguments: { direction: "sell", amount_in: "1.0" },
  });
  const sellQuote = JSON.parse((sellQuoteResult.content[0] as { text: string }).text);
  console.log(`  Expected ETH out: ${sellQuote.expected_eth_out}`);
  console.log(`  Safe min ETH:     ${sellQuote.safe_min_eth_out}\n`);

  // ─── Tool 3: swap_gblin_to_usdc_jit ──────────────────────────────────────
  console.log("⚡ [3/6] swap_gblin_to_usdc_jit — JIT swap for $0.50 x402 invoice");
  const jitResult = await client.callTool({
    name: "swap_gblin_to_usdc_jit",
    arguments: {
      usdc_needed: "0.50",
      wallet_address: DEMO_WALLET,
    },
  });
  const jit = JSON.parse((jitResult.content[0] as { text: string }).text);
  console.log(`  Action:          ${jit.action}`);
  console.log(`  Target contract: ${jit.target_contract}`);
  console.log(`  Calldata:        ${jit.calldata.slice(0, 20)}...`);
  console.log();

  // ─── Tool 4: invest_usdc_to_gblin ────────────────────────────────────────
  console.log("💰 [4/6] invest_usdc_to_gblin — convert $10 USDC → GBLIN");
  const investResult = await client.callTool({
    name: "invest_usdc_to_gblin",
    arguments: {
      usdc_amount: "10",
    },
  });
  const invest = JSON.parse((investResult.content[0] as { text: string }).text);
  console.log(`  Steps required: ${invest.steps.length}`);
  invest.steps.forEach((step: { step: number; description: string }) => {
    console.log(`  Step ${step.step}: ${step.description}`);
  });
  console.log();

  // ─── Tool 5: analyze_treasury_health ─────────────────────────────────────
  console.log("🏥 [5/6] analyze_treasury_health");
  const healthResult = await client.callTool({
    name: "analyze_treasury_health",
    arguments: { wallet_address: DEMO_WALLET },
  });
  const health = JSON.parse((healthResult.content[0] as { text: string }).text);
  console.log(`  Total USD:    $${health.balances.total_usd}`);
  console.log(`  Gas health:   ${health.gas_health.status}`);
  console.log(`  Cooldown:     ${health.cooldown.active ? `active (${health.cooldown.seconds_remaining}s)` : "none"}\n`);

  // ─── Tool 6: get_governance_state ────────────────────────────────────────
  console.log("🏛️  [6/6] get_governance_state");
  const govResult = await client.callTool({
    name: "get_governance_state",
    arguments: {},
  });
  const gov = JSON.parse((govResult.content[0] as { text: string }).text);
  console.log(`  Owner is timelock: ${gov.owner_is_timelock}`);
  console.log(`  Trust summary:     ${gov.trust_summary}`);

  console.log("\n=== ✅ All 6 tools verified against Base mainnet ===");
  console.log("Zero transactions broadcast. Read-only.\n");

  await client.close();
}

runDemoAgent().catch((err) => {
  console.error("Demo agent error:", err);
  process.exit(1);
});
