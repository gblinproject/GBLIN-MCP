/**
 * GBLIN MCP — Tool Implementations
 *
 * Six focused tools. Each returns structured JSON the LLM can parse:
 *
 *   1. get_treasury_state      → NAV, basket, Crash Shield (snapshot)
 *   2. quote_safe_swap         → preview a buy/sell with safe minOut
 *   3. swap_gblin_to_usdc_jit  → calldata for Just-In-Time x402 payment
 *   4. invest_usdc_to_gblin    → calldata to convert USDC earnings → GBLIN
 *   5. analyze_treasury_health → balances + gas check + runway estimate
 *   6. get_governance_state    → verify 48h timelock ownership + pending ops
 */

import {
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from "viem";
import { z } from "zod";

import { ERC20_ABI, GBLIN_ABI, TIMELOCK_ABI } from "./abi.js";
import { client } from "./client.js";
import {
  EXPECTED_MIN_DELAY_SECONDS,
  GBLIN_TIMELOCK,
  GBLIN_V5,
  MIN_DEPOSIT_WEI,
  USDC,
  WETH,
  WETH_USDC_POOL_FEE,
} from "./config.js";
import {
  applySlippageBuffer,
  checkCooldown,
  getBasketState,
  getDynamicSlippage,
  getEthPriceUsd,
  getNavUsd,
  getWalletBalances,
  quoteGblinForUsdc,
} from "./helpers.js";

// ───────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ───────────────────────────────────────────────────────────────────────────

const AddressSchema = z
  .string()
  .refine((v) => isAddress(v), { message: "Invalid EVM address" })
  .transform((v) => getAddress(v));

const AmountStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal string");

function toolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, jsonReplacer, 2),
      },
    ],
  };
}

function toolError(message: string, hint?: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, hint }, null, 2),
      },
    ],
  };
}

/** JSON.stringify replacer that turns BigInt into string. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 1 — get_treasury_state
// ───────────────────────────────────────────────────────────────────────────

export const GET_TREASURY_STATE_DEFINITION = {
  name: "get_treasury_state",
  description:
    "Read the current GBLIN protocol state on Base mainnet: NAV in USD, basket composition with dynamic weights, and Crash Shield status. Use this BEFORE any swap to know the current price and risk regime.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
};

export async function handleGetTreasuryState() {
  try {
    const [navUsd, ethPriceUsd, basket, slippage] = await Promise.all([
      getNavUsd(),
      getEthPriceUsd(),
      getBasketState(),
      getDynamicSlippage(),
    ]);

    return toolResult({
      nav_usd: Number(navUsd.toFixed(6)),
      eth_price_usd: Number(ethPriceUsd.toFixed(2)),
      crash_shield_active: basket.crashShieldActive,
      slippage_buffer_pct: slippage.pct,
      slippage_reason: slippage.reason,
      basket: basket.entries.map((e) => ({
        token: e.token,
        is_stable: e.isStable,
        base_weight_pct: e.baseWeightBps / 100,
        dynamic_weight_pct: e.dynamicWeightBps / 100,
        slashed: e.isSlashed,
        pool_fee_bps: e.poolFee,
      })),
      meta: {
        contract: GBLIN_V5,
        chain: "base",
        chain_id: 8453,
      },
    });
  } catch (err) {
    return toolError((err as Error).message, "Check RPC connectivity and oracle freshness.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 2 — quote_safe_swap
// ───────────────────────────────────────────────────────────────────────────

const QuoteSafeSwapSchema = z.object({
  direction: z.enum(["buy", "sell"]),
  amount_in: AmountStringSchema.describe(
    "For direction=buy → ETH amount (e.g. '0.01'). For direction=sell → GBLIN amount (e.g. '5.0')."
  ),
});

export const QUOTE_SAFE_SWAP_DEFINITION = {
  name: "quote_safe_swap",
  description:
    "Preview a buy (ETH→GBLIN) or sell (GBLIN→ETH) without executing. Returns expected output, safe minOut with dynamic slippage buffer (2.5% normal / 4% during Crash Shield), and fee breakdown. Read-only.",
  inputSchema: {
    type: "object" as const,
    properties: {
      direction: { type: "string", enum: ["buy", "sell"] },
      amount_in: {
        type: "string",
        description: "Positive decimal. ETH for buy, GBLIN for sell.",
      },
    },
    required: ["direction", "amount_in"],
    additionalProperties: false,
  },
};

export async function handleQuoteSafeSwap(args: unknown) {
  let parsed: z.infer<typeof QuoteSafeSwapSchema>;
  try {
    parsed = QuoteSafeSwapSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    const slippage = await getDynamicSlippage();
    const amountWei = parseUnits(parsed.amount_in, 18);

    if (parsed.direction === "buy") {
      if (amountWei < MIN_DEPOSIT_WEI) {
        return toolError(
          `DepositTooSmall: minimum buy is ${formatUnits(MIN_DEPOSIT_WEI, 18)} ETH.`,
          "Increase amount_in or pool buys into batches."
        );
      }

      const [gblinOut, founderFee, stabFee] = await client.readContract({
        address: GBLIN_V5,
        abi: GBLIN_ABI,
        functionName: "quoteBuyGBLIN",
        args: [amountWei],
      });

      const safeMin = applySlippageBuffer(gblinOut, slippage.bps);
      return toolResult({
        direction: "buy",
        amount_in_eth: parsed.amount_in,
        expected_gblin_out: formatUnits(gblinOut, 18),
        safe_min_gblin_out: formatUnits(safeMin, 18),
        fees: {
          founder_eth: formatUnits(founderFee, 18),
          stability_eth: formatUnits(stabFee, 18),
          total_fee_bps: 10,
        },
        slippage_buffer_bps: Number(slippage.bps),
        slippage_reason: slippage.reason,
        will_revert_with_zero_tolerance: true,
        next_step: "Call contract.buyGBLIN(safe_min_gblin_out) with msg.value = amount_in.",
      });
    }

    // sell
    const ethOut = await client.readContract({
      address: GBLIN_V5,
      abi: GBLIN_ABI,
      functionName: "quoteSellGBLIN",
      args: [amountWei],
    });
    const safeMin = applySlippageBuffer(ethOut, slippage.bps);

    return toolResult({
      direction: "sell",
      amount_in_gblin: parsed.amount_in,
      expected_eth_out: formatUnits(ethOut, 18),
      safe_min_eth_out: formatUnits(safeMin, 18),
      slippage_buffer_bps: Number(slippage.bps),
      slippage_reason: slippage.reason,
      cooldown_note:
        "Sell reverts with CooldownActive if last buy was <2 min ago. Check via analyze_treasury_health.",
      next_step: "Call contract.sellGBLINForEth(amount_in, safe_min_eth_out).",
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 3 — swap_gblin_to_usdc_jit  (THE JIT TOOL FOR x402)
// ───────────────────────────────────────────────────────────────────────────

const JitSwapSchema = z.object({
  usdc_needed: AmountStringSchema.describe(
    "Exact USDC required for the x402 payment (e.g. '0.50')."
  ),
  wallet_address: AddressSchema.describe(
    "The agent's wallet address — used to check cooldown status."
  ),
});

export const JIT_SWAP_DEFINITION = {
  name: "swap_gblin_to_usdc_jit",
  description:
    "Generate ready-to-broadcast calldata that converts GBLIN → USDC in a single atomic transaction via the contract's native sellGBLINForToken function. Works on any wallet (EOA, ERC-4337 smart account, EIP-7702). Use this immediately before paying an x402 invoice.",
  inputSchema: {
    type: "object" as const,
    properties: {
      usdc_needed: { type: "string", description: "USDC amount, decimal string." },
      wallet_address: {
        type: "string",
        description: "Agent's 0x address (for cooldown check).",
      },
    },
    required: ["usdc_needed", "wallet_address"],
    additionalProperties: false,
  },
};

export async function handleJitSwap(args: unknown) {
  let parsed: z.infer<typeof JitSwapSchema>;
  try {
    parsed = JitSwapSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    // 1. Cooldown check (on-chain block.timestamp, NOT Date.now)
    const cooldown = await checkCooldown(parsed.wallet_address);
    if (cooldown.active) {
      return toolError(
        `CooldownActive: ${cooldown.secondsRemaining}s remaining until sell is unlocked.`,
        "The agent recently called buyGBLIN. Wait or use existing USDC reserves."
      );
    }

    // 2. Reverse quote: how much GBLIN to sell?
    const quote = await quoteGblinForUsdc(parsed.usdc_needed);

    // 3. Build calldata for native atomic swap
    const calldata = encodeFunctionData({
      abi: GBLIN_ABI,
      functionName: "sellGBLINForToken",
      args: [
        quote.gblinToSell,
        USDC,
        WETH_USDC_POOL_FEE,
        quote.minUsdcOut,
      ],
    });

    return toolResult({
      action: "single_atomic_tx",
      target_contract: GBLIN_V5,
      calldata,
      value: "0",
      params: {
        gblin_amount: formatUnits(quote.gblinToSell, 18),
        target_token: USDC,
        pool_fee: WETH_USDC_POOL_FEE,
        min_usdc_out: formatUnits(quote.minUsdcOut, 6),
      },
      expected: {
        usdc_out: formatUnits(quote.expectedUsdcOut, 6),
        nav_used_usd: Number(quote.navUsd.toFixed(6)),
        slippage_buffer_pct: quote.slippage.pct,
        slippage_reason: quote.slippage.reason,
      },
      compatibility: {
        eoa: true,
        erc4337: true,
        eip7702: true,
        note: "Single contract call — no batching needed for atomicity.",
      },
      gas_hint: 600_000,
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 4 — invest_usdc_to_gblin  (treasury accumulation)
// ───────────────────────────────────────────────────────────────────────────

const InvestSchema = z.object({
  usdc_amount: AmountStringSchema,
});

export const INVEST_DEFINITION = {
  name: "invest_usdc_to_gblin",
  description:
    "Generate calldata to convert USDC earnings into GBLIN (treasury accumulation). Returns two sequential steps: (1) approve USDC, (2) call buyGBLINWithToken. Includes properly-quoted minOut values to prevent MEV sandwich attacks — never accepts 0 minOut.",
  inputSchema: {
    type: "object" as const,
    properties: {
      usdc_amount: {
        type: "string",
        description: "USDC amount to invest (decimal string).",
      },
    },
    required: ["usdc_amount"],
    additionalProperties: false,
  },
};

export async function handleInvest(args: unknown) {
  let parsed: z.infer<typeof InvestSchema>;
  try {
    parsed = InvestSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    const usdcUnits = parseUnits(parsed.usdc_amount, 6);
    if (usdcUnits === 0n) {
      return toolError("usdc_amount must be > 0.");
    }

    const [ethPriceUsd, slippage] = await Promise.all([
      getEthPriceUsd(),
      getDynamicSlippage(),
    ]);

    // Step 1: estimate WETH out from USDC via oracle price.
    //   usdc_decimal_units / ethPriceUsd ≈ ETH
    //   Convert: (usdcUnits * 1e18) / (ethPriceUsd * 1e6)
    const ethPriceScaled = BigInt(Math.round(ethPriceUsd * 1_000_000)); // 6 decimals
    const wethExpected = (usdcUnits * parseUnits("1", 18)) / ethPriceScaled;
    const minWethOut = applySlippageBuffer(wethExpected, slippage.bps);

    if (minWethOut < MIN_DEPOSIT_WEI) {
      return toolError(
        `DepositTooSmall: ${parsed.usdc_amount} USDC converts to ~${formatUnits(wethExpected, 18)} WETH, below contract minimum of ${formatUnits(MIN_DEPOSIT_WEI, 18)} ETH.`,
        "Aggregate more USDC before investing."
      );
    }

    // Step 2: quote GBLIN out from the contract using the min WETH amount.
    const [gblinExpected] = await client.readContract({
      address: GBLIN_V5,
      abi: GBLIN_ABI,
      functionName: "quoteBuyGBLIN",
      args: [minWethOut],
    });
    const minGblinOut = applySlippageBuffer(gblinExpected, slippage.bps);

    // Uniswap V3 path encoding: USDC → (fee=500) → WETH
    const path = encodePacked(
      ["address", "uint24", "address"],
      [USDC, WETH_USDC_POOL_FEE, WETH]
    );

    const approveCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [GBLIN_V5, usdcUnits],
    });

    const buyCalldata = encodeFunctionData({
      abi: GBLIN_ABI,
      functionName: "buyGBLINWithToken",
      args: [path, usdcUnits, minWethOut, minGblinOut],
    });

    return toolResult({
      action: "sequential_txs",
      steps: [
        {
          step: 1,
          description: "Approve GBLIN contract to spend USDC",
          target: USDC,
          calldata: approveCalldata,
          value: "0",
        },
        {
          step: 2,
          description: "Buy GBLIN with USDC via native contract function",
          target: GBLIN_V5,
          calldata: buyCalldata,
          value: "0",
        },
      ],
      expected: {
        usdc_in: parsed.usdc_amount,
        weth_min: formatUnits(minWethOut, 18),
        gblin_min: formatUnits(minGblinOut, 18),
        slippage_buffer_pct: slippage.pct,
      },
      security: {
        mev_protected: true,
        min_outs_set: true,
        note: "minWethOut and minGblinOut are both > 0, computed from on-chain quotes + dynamic slippage. Reverts on bad execution.",
      },
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 5 — analyze_treasury_health
// ───────────────────────────────────────────────────────────────────────────

const AnalyzeSchema = z.object({
  wallet_address: AddressSchema,
  daily_burn_usd: z
    .number()
    .nonnegative()
    .optional()
    .describe("Optional: agent's average daily API spend in USD. Enables runway estimate."),
});

export const ANALYZE_TREASURY_DEFINITION = {
  name: "analyze_treasury_health",
  description:
    "Analyze an agent wallet's treasury health: GBLIN/USDC/ETH balances, gas runway, and (if daily_burn_usd provided) days of operational runway plus rebalance recommendation. Critical for autonomous decision-making.",
  inputSchema: {
    type: "object" as const,
    properties: {
      wallet_address: { type: "string", description: "Agent's 0x address." },
      daily_burn_usd: {
        type: "number",
        description: "Optional. Average daily spend in USD (e.g. 1.5).",
      },
    },
    required: ["wallet_address"],
    additionalProperties: false,
  },
};

export async function handleAnalyzeTreasury(args: unknown) {
  let parsed: z.infer<typeof AnalyzeSchema>;
  try {
    parsed = AnalyzeSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    const [balances, cooldown] = await Promise.all([
      getWalletBalances(parsed.wallet_address),
      checkCooldown(parsed.wallet_address),
    ]);

    const ethBalanceNum = Number(balances.ethFormatted);
    const gasHealth: "sufficient" | "low" | "critical" =
      ethBalanceNum >= 0.001
        ? "sufficient"
        : ethBalanceNum >= 0.0003
          ? "low"
          : "critical";

    const usdcNum = Number(balances.usdcFormatted);
    const gblinPct =
      balances.totalUsd > 0
        ? (balances.gblinValueUsd / balances.totalUsd) * 100
        : 0;
    const usdcPct =
      balances.totalUsd > 0 ? (usdcNum / balances.totalUsd) * 100 : 0;

    // Strategy presets:
    //   high burn  (> $2/day) → conservative 70/30
    //   low burn   (≤ $2/day) → aggressive   90/10
    let recommendation: {
      target_gblin_pct: number;
      target_usdc_pct: number;
      action: "rebalance_to_gblin" | "rebalance_to_usdc" | "hold";
      runway_days: number | null;
      reasoning: string;
    } = {
      target_gblin_pct: 90,
      target_usdc_pct: 10,
      action: "hold",
      runway_days: null,
      reasoning: "No daily_burn_usd provided. Default preset is aggressive 90/10.",
    };

    if (parsed.daily_burn_usd !== undefined && parsed.daily_burn_usd > 0) {
      const highBurn = parsed.daily_burn_usd > 2;
      const targetGblin = highBurn ? 70 : 90;
      const targetUsdc = highBurn ? 30 : 10;
      const runwayDays = Math.floor(usdcNum / parsed.daily_burn_usd);

      let action: "rebalance_to_gblin" | "rebalance_to_usdc" | "hold" = "hold";
      if (usdcPct < targetUsdc - 5) action = "rebalance_to_usdc";
      else if (usdcPct > targetUsdc + 10) action = "rebalance_to_gblin";

      recommendation = {
        target_gblin_pct: targetGblin,
        target_usdc_pct: targetUsdc,
        action,
        runway_days: runwayDays,
        reasoning: highBurn
          ? `High burn rate ($${parsed.daily_burn_usd}/day): hold larger USDC buffer (30%) to avoid forced GBLIN liquidations during market stress.`
          : `Low burn rate ($${parsed.daily_burn_usd}/day): maximize GBLIN exposure (90%) for treasury yield. JIT-swap on demand.`,
      };
    }

    return toolResult({
      wallet: parsed.wallet_address,
      balances: {
        gblin: balances.gblinFormatted,
        gblin_value_usd: Number(balances.gblinValueUsd.toFixed(4)),
        usdc: balances.usdcFormatted,
        eth: balances.ethFormatted,
        eth_value_usd: Number(balances.ethValueUsd.toFixed(4)),
        total_usd: Number(balances.totalUsd.toFixed(4)),
      },
      ratios: {
        gblin_pct: Number(gblinPct.toFixed(2)),
        usdc_pct: Number(usdcPct.toFixed(2)),
      },
      gas_health: {
        status: gasHealth,
        eth_balance: balances.ethFormatted,
        warning:
          gasHealth === "critical"
            ? "ETH below 0.0003 — JIT swaps will likely fail due to insufficient gas. Top up immediately."
            : gasHealth === "low"
              ? "ETH between 0.0003 and 0.001 — limited gas headroom."
              : null,
      },
      cooldown: {
        active: cooldown.active,
        seconds_remaining: cooldown.secondsRemaining,
        last_deposit_unix: cooldown.lastDeposit,
      },
      recommendation,
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 6 — get_governance_state
// ───────────────────────────────────────────────────────────────────────────

const GovernanceStateSchema = z.object({
  operation_id: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "operation_id must be a 32-byte hex string")
    .optional()
    .describe(
      "Optional. A specific TimelockController operation id (bytes32) to inspect — returns pending/ready/done/timestamp."
    ),
});

export const GET_GOVERNANCE_STATE_DEFINITION = {
  name: "get_governance_state",
  description:
    "Verify GBLIN protocol governance state: confirms whether GBLIN_V5 is owned by the 48h Timelock, reads the timelock's min delay and grace period, reports role member counts, and surfaces any pending asset-addition proposal on the index contract. If an operation_id is provided, also reports the status of that specific timelock operation. Read-only — use this to gate trust-sensitive agent actions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      operation_id: {
        type: "string",
        description:
          "Optional 0x-prefixed 32-byte hex id of a specific timelock operation to inspect.",
      },
    },
    additionalProperties: false,
  },
};

export async function handleGetGovernanceState(args: unknown) {
  let parsed: z.infer<typeof GovernanceStateSchema>;
  try {
    parsed = GovernanceStateSchema.parse(args ?? {});
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    // 1. Read owner + pending asset from GBLIN_V5
    const [owner, founder, proposedAsset] = await Promise.all([
      client.readContract({
        address: GBLIN_V5,
        abi: GBLIN_ABI,
        functionName: "owner",
      }),
      client.readContract({
        address: GBLIN_V5,
        abi: GBLIN_ABI,
        functionName: "founderWallet",
      }),
      client.readContract({
        address: GBLIN_V5,
        abi: GBLIN_ABI,
        functionName: "proposedAsset",
      }),
    ]);

    const ownerNorm = getAddress(owner);
    const timelockNorm = getAddress(GBLIN_TIMELOCK);
    const ownerIsTimelock = ownerNorm === timelockNorm;
    const ownerIsRenounced = ownerNorm === "0x0000000000000000000000000000000000000000";

    // 2. Read timelock state — only if owner actually is the timelock,
    //    otherwise still report expected vs actual for transparency.
    let timelockState: Record<string, unknown>;
    try {
      const [
        minDelay,
        proposerRole,
        cancellerRole,
        executorRole,
        adminRole,
      ] = await Promise.all([
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "getMinDelay",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "PROPOSER_ROLE",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "CANCELLER_ROLE",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "EXECUTOR_ROLE",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "DEFAULT_ADMIN_ROLE",
        }),
      ]);

      const [
        proposerCount,
        cancellerCount,
        executorOpen,
      ] = await Promise.all([
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "getRoleMemberCount",
          args: [proposerRole],
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "getRoleMemberCount",
          args: [cancellerRole],
        }),
        // executor open to anyone if address(0) holds the role
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "hasRole",
          args: [executorRole, "0x0000000000000000000000000000000000000000"],
        }),
      ]);

      timelockState = {
        address: timelockNorm,
        min_delay_seconds: Number(minDelay),
        min_delay_hours: Number(minDelay) / 3600,
        min_delay_matches_expected: minDelay === EXPECTED_MIN_DELAY_SECONDS,
        expected_min_delay_seconds: Number(EXPECTED_MIN_DELAY_SECONDS),
        roles: {
          proposer_count: Number(proposerCount),
          canceller_count: Number(cancellerCount),
          executor_open_to_anyone: executorOpen,
          self_administered_note:
            "DEFAULT_ADMIN_ROLE is held by the timelock itself; role changes also take 48h.",
        },
        role_ids: {
          PROPOSER_ROLE: proposerRole,
          CANCELLER_ROLE: cancellerRole,
          EXECUTOR_ROLE: executorRole,
          DEFAULT_ADMIN_ROLE: adminRole,
        },
      };
    } catch (err) {
      timelockState = {
        address: timelockNorm,
        error: `Could not read timelock state: ${(err as Error).message}`,
      };
    }

    // 3. Optional: inspect a specific pending timelock operation
    let operationStatus: Record<string, unknown> | null = null;
    if (parsed.operation_id) {
      try {
        const [isOp, isPending, isReady, isDone, ts] = await Promise.all([
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperation",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperationPending",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperationReady",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperationDone",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "getTimestamp",
            args: [parsed.operation_id as `0x${string}`],
          }),
        ]);

        const tsNum = Number(ts);
        const nowSec = Math.floor(Date.now() / 1000);
        operationStatus = {
          id: parsed.operation_id,
          exists: isOp,
          pending: isPending,
          ready: isReady,
          done: isDone,
          execute_after_unix: tsNum,
          execute_after_iso:
            tsNum > 1 ? new Date(tsNum * 1000).toISOString() : null,
          seconds_until_ready: tsNum > nowSec ? tsNum - nowSec : 0,
        };
      } catch (err) {
        operationStatus = {
          id: parsed.operation_id,
          error: (err as Error).message,
        };
      }
    }

    // 4. Pending asset proposal inside GBLIN_V5 itself (separate 48h mini-timelock)
    const [pToken, pOracle, pPoolFee, pIsStable, pBaseWeight, pExecuteAfter] =
      proposedAsset;
    const hasPendingAsset = pExecuteAfter > 0n;
    const nowSec = Math.floor(Date.now() / 1000);

    const pendingAssetProposal = hasPendingAsset
      ? {
          token: getAddress(pToken),
          oracle: getAddress(pOracle),
          pool_fee_bps: pPoolFee,
          is_stable: pIsStable,
          base_weight_bps: Number(pBaseWeight),
          execute_after_unix: Number(pExecuteAfter),
          execute_after_iso: new Date(Number(pExecuteAfter) * 1000).toISOString(),
          seconds_until_executable:
            Number(pExecuteAfter) > nowSec ? Number(pExecuteAfter) - nowSec : 0,
        }
      : null;

    return toolResult({
      gblin_v5: GBLIN_V5,
      owner: ownerNorm,
      owner_is_timelock: ownerIsTimelock,
      owner_is_renounced: ownerIsRenounced,
      founder_wallet: getAddress(founder),
      trust_summary: ownerIsRenounced
        ? "Ownership fully renounced — no admin can touch the contract."
        : ownerIsTimelock
          ? "Ownership held by the 48h Timelock. All admin actions are delay-enforced on-chain."
          : "WARNING: owner is an EOA / unknown contract — admin actions are NOT timelocked.",
      timelock: timelockState,
      pending_asset_proposal: pendingAssetProposal,
      pending_timelock_operation: operationStatus,
      verification: {
        gblin_v5_basescan: `https://basescan.org/address/${GBLIN_V5}#readContract`,
        timelock_basescan: `https://basescan.org/address/${GBLIN_TIMELOCK}#readContract`,
        ownership_transfer_tx:
          "https://basescan.org/tx/0xb653f54ffa9b1764b41932e6a411077e7e34550605303f15d90900de682edaaf",
      },
    });
  } catch (err) {
    return toolError((err as Error).message, "Check RPC connectivity and that the contract addresses match Base mainnet.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// REGISTRY
// ───────────────────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  GET_TREASURY_STATE_DEFINITION,
  QUOTE_SAFE_SWAP_DEFINITION,
  JIT_SWAP_DEFINITION,
  INVEST_DEFINITION,
  ANALYZE_TREASURY_DEFINITION,
  GET_GOVERNANCE_STATE_DEFINITION,
];

export const TOOL_HANDLERS: Record<
  string,
  (args: unknown) => Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError>>
> = {
  get_treasury_state: handleGetTreasuryState,
  quote_safe_swap: handleQuoteSafeSwap,
  swap_gblin_to_usdc_jit: handleJitSwap,
  invest_usdc_to_gblin: handleInvest,
  analyze_treasury_health: handleAnalyzeTreasury,
  get_governance_state: handleGetGovernanceState,
};
