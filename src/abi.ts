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

  // Governance / ownership (public state vars)
  "function owner() view returns (address)",
  "function founderWallet() view returns (address)",
  "function proposedAsset() view returns (address token, address oracle, uint24 poolFee, bool isStable, uint256 baseWeight, uint256 executeAfter)",

  // Mutating — only used to build calldata (never executed by the MCP server)
  "function buyGBLIN(uint256 minGblinOut) payable",
  "function sellGBLINForEth(uint256 gblinAmount, uint256 minEthOut)",
  "function sellGBLINForToken(uint256 gblinAmount, address targetToken, uint24 wethToTargetFee, uint256 minTokenOut)",
  "function buyGBLINWithToken(bytes path, uint256 amountIn, uint256 minWethOut, uint256 minGblinOut)",
  // V6: direct single-asset in-kind buy (deposit USDC directly, no swap)
  "function buyGBLINInKind(address token, uint256 amountIn, uint256 minGblinOut)",
]);

/**
 * GblinTimelockController — OpenZeppelin TimelockController v5 surface.
 * Only the views we need to read governance state.
 */
export const TIMELOCK_ABI = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function GRACE_PERIOD() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event Cancelled(bytes32 indexed id)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
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
