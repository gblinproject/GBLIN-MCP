/**
 * Live smoke test against Base mainnet (read-only).
 *
 * Run: npm test
 *
 * Exercises every tool with conservative inputs. The MCP server itself is
 * not started — we call the handlers directly to validate logic + RPC.
 * No transactions are broadcast.
 */

import {
  handleAnalyzeTreasury,
  handleGetGovernanceState,
  handleGetTreasuryState,
  handleInvest,
  handleJitSwap,
  handleQuoteSafeSwap,
} from "../src/tools.js";

// A well-known Base wallet for read-only balance probes (Coinbase hot wallet).
// Replace if you want to test against your own wallet.
const TEST_WALLET = "0x4200000000000000000000000000000000000006"; // WETH contract — always has balance

interface TestCase {
  name: string;
  run: () => Promise<unknown>;
}

const cases: TestCase[] = [
  {
    name: "get_treasury_state",
    run: () => handleGetTreasuryState(),
  },
  {
    name: "quote_safe_swap (buy 0.001 ETH)",
    run: () => handleQuoteSafeSwap({ direction: "buy", amount_in: "0.001" }),
  },
  {
    name: "quote_safe_swap (sell 1.0 GBLIN)",
    run: () => handleQuoteSafeSwap({ direction: "sell", amount_in: "1.0" }),
  },
  {
    name: "swap_gblin_to_usdc_jit ($0.50)",
    run: () =>
      handleJitSwap({
        usdc_needed: "0.50",
        wallet_address: TEST_WALLET,
      }),
  },
  {
    name: "invest_usdc_to_gblin ($10)",
    run: () => handleInvest({ usdc_amount: "10" }),
  },
  {
    name: "analyze_treasury_health (WETH contract)",
    run: () =>
      handleAnalyzeTreasury({
        wallet_address: TEST_WALLET,
        daily_burn_usd: 1.0,
      }),
  },
  {
    name: "get_governance_state",
    run: () => handleGetGovernanceState({}),
  },
];

function summarize(out: unknown): string {
  if (typeof out !== "object" || out === null) return String(out);
  const o = out as { isError?: boolean; content?: { text: string }[] };
  if (o.isError) return `⚠️  ERROR: ${o.content?.[0]?.text ?? "?"}`;
  const text = o.content?.[0]?.text ?? "";
  // Truncate long output for readability
  return text.length > 500 ? text.slice(0, 500) + "\n  ... [truncated]" : text;
}

async function main(): Promise<void> {
  console.log("─".repeat(70));
  console.log("GBLIN MCP — Live test against Base mainnet");
  console.log("─".repeat(70));

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const t0 = Date.now();
    try {
      const result = await tc.run();
      const dt = Date.now() - t0;
      const o = result as { isError?: boolean };
      if (o.isError) {
        failed++;
        console.log(`\n❌ ${tc.name}  (${dt}ms)`);
        console.log(summarize(result));
      } else {
        passed++;
        console.log(`\n✅ ${tc.name}  (${dt}ms)`);
        console.log(summarize(result));
      }
    } catch (err) {
      failed++;
      const dt = Date.now() - t0;
      console.log(`\n💥 ${tc.name}  (${dt}ms)`);
      console.log(`  Threw: ${(err as Error).message}`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(70));
  process.exit(failed > 0 ? 1 : 0);
}

main();
