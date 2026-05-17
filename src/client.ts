/**
 * GBLIN MCP — viem Public Client
 *
 * Read-only Base mainnet client. The MCP server never signs or broadcasts;
 * it only reads state and builds calldata for the agent's wallet to execute.
 */

import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { RPC_URL } from "./config.js";

export const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, {
    timeout: 10_000,
    retryCount: 2,
    retryDelay: 500,
  }),
});

/**
 * Fetch the latest block timestamp from the chain.
 * Used for cooldown checks — never trust local clock (Date.now()).
 */
export async function getOnChainTimestamp(): Promise<bigint> {
  const block = await client.getBlock();
  return block.timestamp;
}
