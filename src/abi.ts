/**
 * GBLIN MCP — Contract ABIs
 *
 * Verified directly against GBLIN_V5.sol source on Base mainnet.
 * The basket() return signature exactly matches the Asset struct field order.
 */

import { parseAbi } from "viem";

/**
 * GBLIN_V5 selected functions.
 *
 * IMPORTANT — basket() returns the Asset struct in declaration order:
 *   (token, oracle, poolFee, isStable, baseWeight, dynamicWeight, peakPrice, lastPeakUpdate)
 *
 * Common mistake: assuming a 5-field tuple. This caused real production bugs
 * during the V4 audit cycle. Do not "simplify" this ABI.
 */
export const GBLIN_ABI = parseAbi([
  // Quotes (view, gas-free)
  "function quoteBuyGBLIN(uint256 ethAmount) view returns (uint256 gblinOut, uint256 founderFee, uint256 stabFee)",
  "function quoteSellGBLIN(uint256 gblinAmount) view returns (uint256 ethOut)",

  // Basket — full struct, 8 fields, do not truncate
  "function basket(uint256 index) view returns (address token, address oracle, uint24 poolFee, bool isStable, uint256 baseWeight, uint256 dynamicWeight, uint256 peakPrice, uint256 lastPeakUpdate)",

  // ERC-20 surface
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",

  // State helpers
  "function lastDepositTime(address user) view returns (uint256)",

  // Mutating — only used to build calldata (never executed by the MCP server)
  "function buyGBLIN(uint256 minGblinOut) payable",
  "function sellGBLINForEth(uint256 gblinAmount, uint256 minEthOut)",
  "function sellGBLINForToken(uint256 gblinAmount, address targetToken, uint24 wethToTargetFee, uint256 minTokenOut)",
  "function buyGBLINWithToken(bytes path, uint256 amountIn, uint256 minWethOut, uint256 minGblinOut)",
]);

/**
 * Chainlink AggregatorV3Interface — only the read we need.
 * Note: `answer` is int256 (can be negative — we guard against that).
 */
export const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

/**
 * Standard ERC-20 (USDC, etc).
 */
export const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
