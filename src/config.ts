/**
 * GBLIN MCP — Network Configuration
 *
 * All addresses, constants, and tunable parameters.
 * Verified against GBLIN_V5 contract on Base mainnet.
 */

import type { Address } from "viem";

// ─── Network ────────────────────────────────────────────────────────────────
export const BASE_CHAIN_ID = 8453;
// publicnode.com is a free, no-key, generously-rated Base mainnet RPC
// (verified May 2026). Users can override via GBLIN_RPC_URL for Alchemy/QuickNode.
export const DEFAULT_RPC_URL = "https://base-rpc.publicnode.com";
export const RPC_URL = process.env.GBLIN_RPC_URL ?? DEFAULT_RPC_URL;

// ─── Core Contracts (Base Mainnet, verified) ────────────────────────────────
export const GBLIN_V5: Address = "0x38DcDB3A381677239BBc652aed9811F2f8496345";
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH: Address = "0x4200000000000000000000000000000000000006";

// GblinTimelockController — owns GBLIN_V5 since block 46160610 (May 2026).
// 48h immutable delay, 14d grace period, open executor.
export const GBLIN_TIMELOCK: Address = "0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd";
export const EXPECTED_MIN_DELAY_SECONDS = 172_800n; // 48 hours

// Chainlink ETH/USD price feed on Base
export const ETH_USD_FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

// Uniswap V3 pool fee tier used by `sellGBLINForToken` for WETH→USDC leg
export const WETH_USDC_POOL_FEE = 500; // 0.05%

// ─── Protocol Constants (mirrors GBLIN_V5.sol) ──────────────────────────────
export const MIN_DEPOSIT_WEI = 500_000_000_000_000n; // 0.0005 ETH
export const COOLDOWN_SECONDS = 120; // 2 minutes (sell lock after buy)
export const ORACLE_STALENESS_SECONDS = 86_400; // 24h Chainlink heartbeat

// ─── Slippage Buffers (basis points) ────────────────────────────────────────
// Applied on top of contract-internal slippage (maxInternalSlippage = 200 bps)
export const SLIPPAGE_NORMAL_BPS = 250n; // 2.5% — calm market
export const SLIPPAGE_CRASH_SHIELD_BPS = 400n; // 4.0% — Crash Shield active
export const BPS_DENOMINATOR = 10_000n;

// ─── Caching ────────────────────────────────────────────────────────────────
export const NAV_CACHE_TTL_MS = 30_000; // 30 seconds
export const BASKET_CACHE_TTL_MS = 60_000; // 60 seconds

// ─── Metadata ───────────────────────────────────────────────────────────────
export const SERVER_NAME = "gblin-treasury-mcp";
export const SERVER_VERSION = "0.1.0";
