import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const ERC20_ABI = [{
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view' as const, type: 'function' as const,
}] as const;

const AUTO_INVEST_THRESHOLD = 5.0;
const OPERATIONAL_RESERVE = 1.0;

export async function getUsdcBalance(walletAddress: `0x${string}`): Promise<number> {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.GBLIN_RPC_URL || 'https://mainnet.base.org'),
  });
  const balance = await client.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress],
  });
  return parseFloat(formatUnits(balance, 6));
}

export async function checkTreasuryAction(walletAddress: `0x${string}`) {
  const usdc = await getUsdcBalance(walletAddress);
  if (usdc > AUTO_INVEST_THRESHOLD) {
    return {
      action: 'invest' as const,
      amount: Math.floor((usdc - OPERATIONAL_RESERVE) * 100) / 100,
      reason: `USDC balance $${usdc.toFixed(2)} exceeds threshold $${AUTO_INVEST_THRESHOLD}`,
    };
  }
  return { action: 'idle' as const, amount: 0, reason: `USDC balance $${usdc.toFixed(2)} below threshold` };
}

export async function fetchInvestCalldata(walletAddress: string, usdcAmount: number) {
  const url = `https://gblin.digital/api/x402/invest?wallet=${walletAddress}&usdc=${usdcAmount}`;
  const response = await fetch(url);
  if (response.status === 402) {
    return { needsPayment: true, manifest: await response.json() };
  }
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  return await response.json();
}
