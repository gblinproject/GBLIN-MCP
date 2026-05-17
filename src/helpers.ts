/**
 * GBLIN MCP — Core Helpers
 *
 * Domain logic shared by all tools: NAV calculation, Crash Shield detection,
 * dynamic slippage, cooldown checks, and reverse JIT quoting.
 *
 * All functions are read-only against Base mainnet. No private keys involved.
 */

import { formatUnits, parseUnits } from "viem";
import type { Address } from "viem";

import { client, getOnChainTimestamp } from "./client.js";
import {
  CHAINLINK_AGGREGATOR_ABI,
  ERC20_ABI,
  GBLIN_ABI,
} from "./abi.js";
import {
  BASKET_CACHE_TTL_MS,
  BPS_DENOMINATOR,
  COOLDOWN_SECONDS,
  ETH_USD_FEED,
  GBLIN_V5,
  NAV_CACHE_TTL_MS,
  ORACLE_STALENESS_SECONDS,
  SLIPPAGE_CRASH_SHIELD_BPS,
  SLIPPAGE_NORMAL_BPS,
  USDC,
} from "./config.js";

// ───────────────────────────────────────────────────────────────────────────
// ETH/USD PRICE (Chainlink) — with staleness guard
// ───────────────────────────────────────────────────────────────────────────

let ethPriceCache: { value: number; fetchedAt: number } | null = null;

export async function getEthPriceUsd(): Promise<number> {
  const now = Date.now();
  if (ethPriceCache && now - ethPriceCache.fetchedAt < NAV_CACHE_TTL_MS) {
    return ethPriceCache.value;
  }

  const data = await client.readContract({
    address: ETH_USD_FEED,
    abi: CHAINLINK_AGGREGATOR_ABI,
    functionName: "latestRoundData",
  });
  const answer = data[1]; // int256
  const updatedAt = Number(data[3]); // uint256 → seconds

  if (answer <= 0n) {
    throw new Error(
      "OracleDead: Chainlink ETH/USD feed returned non-positive value."
    );
  }

  const nowSec = Math.floor(now / 1_000);
  if (nowSec - updatedAt > ORACLE_STALENESS_SECONDS) {
    throw new Error(
      `OracleStale: Chainlink ETH/USD feed is ${nowSec - updatedAt}s old (max ${ORACLE_STALENESS_SECONDS}s). Aborting to protect against MEV/slippage.`
    );
  }

  // Chainlink ETH/USD on Base has 8 decimals
  const price = Number(answer) / 1e8;
  ethPriceCache = { value: price, fetchedAt: now };
  return price;
}

// ───────────────────────────────────────────────────────────────────────────
// NAV — net asset value of 1 GBLIN in USD
// ───────────────────────────────────────────────────────────────────────────

let navCache: { value: number; fetchedAt: number } | null = null;

export async function getNavUsd(): Promise<number> {
  const now = Date.now();
  if (navCache && now - navCache.fetchedAt < NAV_CACHE_TTL_MS) {
    return navCache.value;
  }

  const [ethPerGblinWei, ethPriceUsd] = await Promise.all([
    client.readContract({
      address: GBLIN_V5,
      abi: GBLIN_ABI,
      functionName: "quoteSellGBLIN",
      args: [parseUnits("1", 18)],
    }),
    getEthPriceUsd(),
  ]);

  const ethPerGblin = Number(formatUnits(ethPerGblinWei, 18));
  const navUsd = ethPerGblin * ethPriceUsd;
  navCache = { value: navUsd, fetchedAt: now };
  return navUsd;
}

// ───────────────────────────────────────────────────────────────────────────
// BASKET STATE & CRASH SHIELD DETECTION
// ───────────────────────────────────────────────────────────────────────────

export interface BasketEntry {
  token: Address;
  oracle: Address;
  poolFee: number;
  isStable: boolean;
  baseWeightBps: number;
  dynamicWeightBps: number;
  isSlashed: boolean;
}

export interface BasketState {
  entries: BasketEntry[];
  crashShieldActive: boolean;
  totalBaseWeight: number;
  totalDynamicWeight: number;
}

let basketCache: { value: BasketState; fetchedAt: number } | null = null;

/**
 * Reads basket(0), basket(1), basket(2) from the contract and derives whether
 * the Crash Shield is currently active.
 *
 * Crash Shield is "active" if any asset has dynamicWeight < baseWeight, which
 * happens when the contract's `refreshWeights()` detected a >20% drawdown.
 */
export async function getBasketState(): Promise<BasketState> {
  const now = Date.now();
  if (basketCache && now - basketCache.fetchedAt < BASKET_CACHE_TTL_MS) {
    return basketCache.value;
  }

  const entries: BasketEntry[] = [];
  let crashShieldActive = false;
  let totalBase = 0;
  let totalDynamic = 0;

  // Basket has exactly 3 slots in V5 (cbBTC, WETH, USDC). We probe defensively
  // up to 8 so future asset additions don't break the tool.
  for (let i = 0; i < 8; i++) {
    try {
      const raw = await client.readContract({
        address: GBLIN_V5,
        abi: GBLIN_ABI,
        functionName: "basket",
        args: [BigInt(i)],
      });
      // raw is the 8-tuple: [token, oracle, poolFee, isStable, baseWeight, dynamicWeight, peakPrice, lastPeakUpdate]
      const [token, oracle, poolFee, isStable, baseWeight, dynamicWeight] = raw;
      const baseBps = Number(baseWeight);
      const dynBps = Number(dynamicWeight);

      if (baseBps === 0 && dynBps === 0) break; // end of basket

      const isSlashed = dynBps < baseBps;
      if (isSlashed) crashShieldActive = true;

      entries.push({
        token,
        oracle,
        poolFee: Number(poolFee),
        isStable,
        baseWeightBps: baseBps,
        dynamicWeightBps: dynBps,
        isSlashed,
      });

      totalBase += baseBps;
      totalDynamic += dynBps;
    } catch {
      // Out-of-bounds index — viem throws. Treat as end of basket.
      break;
    }
  }

  const state: BasketState = {
    entries,
    crashShieldActive,
    totalBaseWeight: totalBase,
    totalDynamicWeight: totalDynamic,
  };
  basketCache = { value: state, fetchedAt: now };
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// DYNAMIC SLIPPAGE
// ───────────────────────────────────────────────────────────────────────────

export interface SlippageProfile {
  bps: bigint;
  pct: number;
  reason: "normal" | "crash_shield_active";
}

export async function getDynamicSlippage(): Promise<SlippageProfile> {
  const basket = await getBasketState();
  if (basket.crashShieldActive) {
    return {
      bps: SLIPPAGE_CRASH_SHIELD_BPS,
      pct: Number(SLIPPAGE_CRASH_SHIELD_BPS) / 100,
      reason: "crash_shield_active",
    };
  }
  return {
    bps: SLIPPAGE_NORMAL_BPS,
    pct: Number(SLIPPAGE_NORMAL_BPS) / 100,
    reason: "normal",
  };
}

/**
 * Apply slippage buffer to an expected output amount.
 * minOut = expected * (10000 - bps) / 10000
 */
export function applySlippageBuffer(expected: bigint, bps: bigint): bigint {
  return (expected * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR;
}

// ───────────────────────────────────────────────────────────────────────────
// COOLDOWN CHECK
// ───────────────────────────────────────────────────────────────────────────

export interface CooldownStatus {
  active: boolean;
  secondsRemaining: number;
  lastDeposit: number;
}

export async function checkCooldown(wallet: Address): Promise<CooldownStatus> {
  const [lastDeposit, blockTimestamp] = await Promise.all([
    client.readContract({
      address: GBLIN_V5,
      abi: GBLIN_ABI,
      functionName: "lastDepositTime",
      args: [wallet],
    }),
    getOnChainTimestamp(),
  ]);

  const lastDepositNum = Number(lastDeposit);
  const nowOnChain = Number(blockTimestamp);
  const unlockAt = lastDepositNum + COOLDOWN_SECONDS;

  if (nowOnChain < unlockAt) {
    return {
      active: true,
      secondsRemaining: unlockAt - nowOnChain,
      lastDeposit: lastDepositNum,
    };
  }
  return { active: false, secondsRemaining: 0, lastDeposit: lastDepositNum };
}

// ───────────────────────────────────────────────────────────────────────────
// REVERSE QUOTE — USD → GBLIN amount needed
// ───────────────────────────────────────────────────────────────────────────

/**
 * Given a USD target (e.g. "$5 needed for x402 payment"), compute how much
 * GBLIN must be sold via sellGBLINForToken to receive that USD amount, with
 * the dynamic slippage buffer baked in (so the call won't revert).
 *
 * Approach (no Quoter dependency in v0.1):
 *   1. usdcTarget × buffer = grossUsdcTarget
 *   2. grossUsdcTarget / navUsd = gblinToSell
 *
 * The buffer absorbs both protocol internal slippage and Uniswap WETH→USDC.
 */
export async function quoteGblinForUsdc(
  usdcTargetStr: string
): Promise<{
  gblinToSell: bigint;
  minUsdcOut: bigint;
  expectedUsdcOut: bigint;
  navUsd: number;
  slippage: SlippageProfile;
}> {
  const navUsd = await getNavUsd();
  const slippage = await getDynamicSlippage();

  const usdcTargetUnits = parseUnits(usdcTargetStr, 6); // USDC = 6 decimals

  // Gross-up the target by the slippage buffer so we sell enough GBLIN.
  // grossTarget = target * 10000 / (10000 - bps)
  const grossUsdcTarget =
    (usdcTargetUnits * BPS_DENOMINATOR) / (BPS_DENOMINATOR - slippage.bps);

  // Convert USDC (6 dec) → GBLIN (18 dec) using NAV.
  // gblin = (grossUsdc / 1e6) / navUsd  →  scale to 18-dec wei
  // Using BigInt math: gblin = grossUsdc * 1e12 * 1e6 / (navUsd_scaled)
  // We scale navUsd by 1e6 for precision.
  const navUsdScaled = BigInt(Math.round(navUsd * 1_000_000));
  // gblinToSell = grossUsdcTarget(6 dec) * 1e18 / (navUsdScaled / 1e6) → simplifies to:
  // gblinToSell = grossUsdcTarget * 1e18 * 1e6 / (navUsdScaled * 1e6) = grossUsdcTarget * 1e18 / navUsdScaled
  // Wait — need to align decimals carefully:
  // grossUsdcTarget has 6 decimals → represents USD * 1e6
  // navUsdScaled represents USD * 1e6
  // So gblinUnits (18 decimals) = (grossUsdcTarget / navUsdScaled) * 1e18
  const gblinToSell =
    (grossUsdcTarget * parseUnits("1", 18)) / navUsdScaled;

  // minUsdcOut = exact target (we asked for this much; agent fails if it gets less)
  const minUsdcOut = usdcTargetUnits;

  // expectedUsdcOut = gross target (what the agent should approximately receive)
  const expectedUsdcOut = grossUsdcTarget;

  return {
    gblinToSell,
    minUsdcOut,
    expectedUsdcOut,
    navUsd,
    slippage,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// BALANCE HELPERS
// ───────────────────────────────────────────────────────────────────────────

export interface WalletBalances {
  gblin: bigint;
  gblinFormatted: string;
  gblinValueUsd: number;
  usdc: bigint;
  usdcFormatted: string;
  eth: bigint;
  ethFormatted: string;
  ethValueUsd: number;
  totalUsd: number;
}

export async function getWalletBalances(wallet: Address): Promise<WalletBalances> {
  const [gblin, usdc, eth, navUsd, ethPriceUsd] = await Promise.all([
    client.readContract({
      address: GBLIN_V5,
      abi: GBLIN_ABI,
      functionName: "balanceOf",
      args: [wallet],
    }),
    client.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    }),
    client.getBalance({ address: wallet }),
    getNavUsd(),
    getEthPriceUsd(),
  ]);

  const gblinFormatted = formatUnits(gblin, 18);
  const usdcFormatted = formatUnits(usdc, 6);
  const ethFormatted = formatUnits(eth, 18);

  const gblinValueUsd = Number(gblinFormatted) * navUsd;
  const ethValueUsd = Number(ethFormatted) * ethPriceUsd;
  const totalUsd = gblinValueUsd + Number(usdcFormatted) + ethValueUsd;

  return {
    gblin,
    gblinFormatted,
    gblinValueUsd,
    usdc,
    usdcFormatted,
    eth,
    ethFormatted,
    ethValueUsd,
    totalUsd,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CACHE INVALIDATION (for tests)
// ───────────────────────────────────────────────────────────────────────────

export function clearCaches(): void {
  ethPriceCache = null;
  navCache = null;
  basketCache = null;
}
