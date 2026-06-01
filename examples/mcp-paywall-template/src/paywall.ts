import { z } from 'zod';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FACILITATOR = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';

const PaymentProofSchema = z.object({
  signature: z.string(),
  payer: z.string(),
  amount: z.string(),
  currency: z.string(),
  recipient: z.string(),
  nonce: z.string(),
  expiresAt: z.number(),
});

export type PaymentProof = z.infer<typeof PaymentProofSchema>;

export interface PaywallContext {
  paymentProof: PaymentProof | null;
}

/**
 * Wraps an MCP tool handler with x402 payment verification.
 * Returns a 402-like error structure if payment is missing.
 *
 * For full HTTP-based MCP servers, integrate this in middleware.
 * For stdio MCP servers, the payment proof must come via tool arguments
 * (typically via a `_payment` field in the input).
 */
export function requirePayment<T extends Record<string, any>>(
  price: string,
  handler: (args: T, ctx: PaywallContext) => Promise<any>
) {
  return async (args: T & { _payment?: string }) => {
    const recipient = process.env.RECIPIENT_WALLET;
    if (!recipient) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Server misconfigured: RECIPIENT_WALLET not set. Contact the operator.',
        }],
        isError: true,
      };
    }

    if (!args._payment) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'payment_required',
            payment: {
              amount: price,
              currency: 'USDC',
              currencyAddress: USDC_BASE,
              chain: 'base',
              chainId: 8453,
              recipient,
              facilitator: FACILITATOR,
            },
          }, null, 2),
        }],
        isError: true,
      };
    }

    let proof: PaymentProof;
    try {
      const decoded = JSON.parse(Buffer.from(args._payment, 'base64').toString('utf-8'));
      proof = PaymentProofSchema.parse(decoded);
    } catch {
      return {
        content: [{ type: 'text' as const, text: 'Invalid payment proof format.' }],
        isError: true,
      };
    }

    if (proof.expiresAt < Date.now() / 1000) {
      return {
        content: [{ type: 'text' as const, text: 'Payment proof expired.' }],
        isError: true,
      };
    }

    // In production, verify against facilitator's /verify endpoint
    return handler(args, { paymentProof: proof });
  };
}
