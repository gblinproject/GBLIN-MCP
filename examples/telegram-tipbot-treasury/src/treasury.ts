const AUTO_INVEST_THRESHOLD = parseFloat(process.env.AUTO_INVEST_THRESHOLD_USDC || '5.0');
const OPERATIONAL_RESERVE = 1.0;

export interface TreasurySuggestion {
  action: 'invest' | 'idle' | 'redeem';
  amount: number;
  reason: string;
  apiUrl?: string;
}

export function suggestTreasuryAction(usdcBalance: number, walletAddress: string): TreasurySuggestion {
  if (usdcBalance > AUTO_INVEST_THRESHOLD) {
    const investAmount = Math.floor((usdcBalance - OPERATIONAL_RESERVE) * 100) / 100;
    return {
      action: 'invest',
      amount: investAmount,
      reason: `USDC balance $${usdcBalance.toFixed(2)} exceeds threshold $${AUTO_INVEST_THRESHOLD}`,
      apiUrl: `https://gblin.digital/api/x402/invest?wallet=${walletAddress}&usdc=${investAmount}`,
    };
  }
  return {
    action: 'idle',
    amount: 0,
    reason: `USDC balance $${usdcBalance.toFixed(2)} below threshold`,
  };
}
