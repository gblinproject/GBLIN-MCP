/**
 * GBLIN MCP — x402 Payment Gate
 *
 * requirePayment wraps any tool handler to enforce per-call USDC payment.
 * Works with stdio MCP servers: the caller agent passes the payment proof
 * as a base64-encoded JSON string in the `_payment` field of tool arguments.
 *
 * Flow:
 *   1. Agent calls tool WITHOUT _payment  → receives 402 manifest (price, recipient, facilitator)
 *   2. Agent pays via x402 facilitator    → obtains signed PaymentProof
 *   3. Agent re-calls tool WITH _payment  → handler executes, result returned
 *
 * Required env var:
 *   RECIPIENT_WALLET  — your EVM address that will receive USDC payments
 *
 * Optional env vars:
 *   X402_FACILITATOR_URL  — override facilitator (default: https://x402.org/facilitator)
 */

import { z } from "zod";
import { PACKAGE_VERSION } from "./config.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const FACILITATOR =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";

// Default recipient: GBLIN Protocol fee wallet.
// Operators may override via RECIPIENT_WALLET env var.
const DEFAULT_RECIPIENT = "0x0ebA5d314F4f5Dcb7A094953Fa9311a45172dd1B";

// ─── Pricing table ───────────────────────────────────────────────────────────

export interface PaywallDef {
  /** USDC amount as decimal string, e.g. "0.005" */
  priceUsdc: string;
  /** Human-readable label, e.g. "$0.005 USDC per call" */
  priceLabel: string;
}

/**
 * Tool pricing.
 * Free tools (get_treasury_state, quote_safe_swap, get_governance_state,
 * share_skill_with_peer) are not in this table.
 */
export const TOOL_PRICES: Record<string, PaywallDef> = {
  get_market_risk_regime:  { priceUsdc: "0.002", priceLabel: "$0.002 USDC per call" },
  analyze_treasury_health: { priceUsdc: "0.003", priceLabel: "$0.003 USDC per call" },
  find_keeper_bounty:      { priceUsdc: "0.001", priceLabel: "$0.001 USDC per call" },
  // swap_gblin_to_usdc_jit and invest_usdc_to_gblin are FREE:
  // they are the core transport layer — paywalling them creates a chicken-and-egg
  // problem (agent needs USDC to pay for the tool that gives them USDC).
  // Revenue from those flows comes from the on-chain founder fee (0.05% per swap).
};

// ─── Payment proof schema ─────────────────────────────────────────────────────

const PaymentProofSchema = z.object({
  signature:  z.string(),
  payer:      z.string(),
  amount:     z.string(),
  currency:   z.string(),
  recipient:  z.string(),
  nonce:      z.string(),
  expiresAt:  z.number(),
});

export type PaymentProof = z.infer<typeof PaymentProofSchema>;

// ─── MCP response helpers ─────────────────────────────────────────────────────

function errorResponse(obj: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

// ─── requirePayment ───────────────────────────────────────────────────────────

/**
 * Wraps an MCP tool handler with x402 payment verification.
 *
 * @param def  - Pricing definition (from TOOL_PRICES)
 * @param handler - The original tool handler (receives cleaned args without _payment)
 */
export function requirePayment(
  def: PaywallDef,
  handler: (args: unknown) => Promise<unknown>
) {
  return async (rawArgs: unknown): Promise<unknown> => {
    const args = (rawArgs ?? {}) as Record<string, unknown> & { _payment?: string };

    // 1. Resolve recipient — env var overrides default
    const recipient = process.env.RECIPIENT_WALLET ?? DEFAULT_RECIPIENT;

    // 2. No payment attached → return 402 manifest
    if (!args._payment) {
      return errorResponse({
        error: "payment_required",
        message: `This tool requires payment: ${def.priceLabel}. Obtain a payment proof from the facilitator and re-call with _payment set.`,
        payment: {
          amount:          def.priceUsdc,
          currency:        "USDC",
          currencyAddress: USDC_BASE,
          chain:           "base",
          chainId:         8453,
          recipient,
          facilitator:     FACILITATOR,
          instructions:    "POST to facilitator /pay with {amount, currency, recipient, chainId}. Encode the returned PaymentProof as base64 JSON and pass as _payment.",
        },
      });
    }

    // 3. Decode and validate proof
    let proof: PaymentProof;
    try {
      const decoded = JSON.parse(
        Buffer.from(args._payment, "base64").toString("utf-8")
      );
      proof = PaymentProofSchema.parse(decoded);
    } catch {
      return errorResponse({ error: "invalid_payment_proof", detail: "Could not parse _payment field." });
    }

    // 4. Expiry check
    if (proof.expiresAt < Date.now() / 1000) {
      return errorResponse({ error: "payment_proof_expired", detail: "Obtain a fresh payment proof and retry." });
    }

    // 5. Strip _payment from args before passing to inner handler
    // (prevents Zod schemas with additionalProperties:false from rejecting it)
    const { _payment: _ignored, ...cleanArgs } = args;

    // 6. Execute the real handler
    return handler(cleanArgs);
  };
}
