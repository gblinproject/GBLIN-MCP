import { createPublicClient, http, encodeFunctionData, formatEther } from 'viem';
import { base } from 'viem/chains';

const GBLIN = '0x38DcDB3A381677239BBc652aed9811F2f8496345' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const BPS = 10000n;
const REWARD = 100000000000000n;        // 0.0001 ether
const MIN_FLOOR = 10000000000000000n;   // 0.01 ether

const GBLIN_ABI = [
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'basket',
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'isStable', type: 'bool' },
      { name: 'baseWeight', type: 'uint256' },
      { name: 'dynamicWeight', type: 'uint256' },
      { name: 'peakPrice', type: 'uint256' },
      { name: 'lastPeakUpdate', type: 'uint256' },
    ],
    stateMutability: 'view', type: 'function',
  },
  { inputs: [], name: 'stabilityFund', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'WETH_ORACLE', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  {
    inputs: [
      { name: 'assetIndex', type: 'uint256' },
      { name: 'isWethToAsset', type: 'bool' },
      { name: 'amountToSwap', type: 'uint256' },
    ],
    name: 'incentivizedRebalance', outputs: [], stateMutability: 'nonpayable', type: 'function',
  },
] as const;

const ERC20_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
] as const;

const ORACLE_ABI = [
  { inputs: [], name: 'latestRoundData', outputs: [
    { name: 'roundId', type: 'uint80' },
    { name: 'answer', type: 'int256' },
    { name: 'startedAt', type: 'uint256' },
    { name: 'updatedAt', type: 'uint256' },
    { name: 'answeredInRound', type: 'uint80' },
  ], stateMutability: 'view', type: 'function' },
] as const;

function convertToEth(amount: bigint, assetPrice: bigint, wethPrice: bigint, decimals: number): bigint {
  if (wethPrice === 0n || assetPrice === 0n) return 0n;
  let val = (amount * assetPrice) / wethPrice;
  if (decimals < 18) val = val * (10n ** BigInt(18 - decimals));
  else if (decimals > 18) val = val / (10n ** BigInt(decimals - 18));
  return val;
}

function convertEthToAsset(ethAmount: bigint, assetPrice: bigint, wethPrice: bigint, decimals: number): bigint {
  if (wethPrice === 0n || assetPrice === 0n) return 0n;
  let val = (ethAmount * wethPrice) / assetPrice;
  if (decimals < 18) val = val / (10n ** BigInt(18 - decimals));
  else if (decimals > 18) val = val * (10n ** BigInt(decimals - 18));
  return val;
}

async function getOraclePrice(client: any, oracle: `0x${string}`): Promise<bigint> {
  try {
    const data: any = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'latestRoundData' });
    const answer: bigint = data[1];
    const updatedAt: bigint = data[3];
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now - updatedAt > 86400n || answer <= 0n) return 0n;
    return answer;
  } catch { return 0n; }
}

export interface KeeperBounty {
  bountyAvailable: boolean;
  reason?: string;
  assetIndex?: number;
  token?: string;
  direction?: 'WETH->asset' | 'asset->WETH';
  amountToSwap?: string;
  estimatedRewardEth?: string;
  target?: string;
  calldata?: string;
  value?: string;
  stabilityFundEth?: string;
  note?: string;
}

export async function findKeeperBounty(rpcUrl?: string): Promise<KeeperBounty> {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl || process.env.GBLIN_RPC_URL || 'https://base-rpc.publicnode.com'),
  });

  const wethOracle = await client.readContract({ address: GBLIN, abi: GBLIN_ABI, functionName: 'WETH_ORACLE' }) as `0x${string}`;
  const wethPrice = await getOraclePrice(client, wethOracle);
  if (wethPrice === 0n) return { bountyAvailable: false, reason: 'WETH oracle stale or dead' };

  const stabilityFund = await client.readContract({ address: GBLIN, abi: GBLIN_ABI, functionName: 'stabilityFund' }) as bigint;
  if (stabilityFund < REWARD) {
    return { bountyAvailable: false, reason: 'Stability fund too low to pay the keeper reward right now', stabilityFundEth: formatEther(stabilityFund) };
  }

  // Read basket entries until revert
  const assets: any[] = [];
  for (let i = 0; i < 16; i++) {
    try {
      const a: any = await client.readContract({ address: GBLIN, abi: GBLIN_ABI, functionName: 'basket', args: [BigInt(i)] });
      assets.push({ index: i, token: a[0] as `0x${string}`, oracle: a[1] as `0x${string}`, dynamicWeight: a[5] as bigint });
    } catch { break; }
  }
  if (assets.length === 0) return { bountyAvailable: false, reason: 'Empty basket' };

  const wethBalance = await client.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [GBLIN] }) as bigint;
  const availableWeth = wethBalance > stabilityFund ? wethBalance - stabilityFund : 0n;
  let totalEthValue = availableWeth;

  const assetData: any[] = [];
  for (const asset of assets) {
    if (asset.token.toLowerCase() === WETH.toLowerCase()) continue;
    if (asset.dynamicWeight === 0n) continue;
    const price = await getOraclePrice(client, asset.oracle);
    if (price === 0n) continue;
    const balance = await client.readContract({ address: asset.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [GBLIN] }) as bigint;
    const decimals = await client.readContract({ address: asset.token, abi: ERC20_ABI, functionName: 'decimals' }) as number;
    const ethValue = convertToEth(balance, price, wethPrice, Number(decimals));
    totalEthValue += ethValue;
    assetData.push({ ...asset, price, decimals: Number(decimals), currentEthValue: ethValue });
  }

  if (totalEthValue === 0n) return { bountyAvailable: false, reason: 'No treasury value to rebalance' };

  let minSwapRequired = wethBalance / 100n;
  if (minSwapRequired < MIN_FLOOR) minSwapRequired = MIN_FLOOR;

  for (const a of assetData) {
    const targetEthValue = (totalEthValue * a.dynamicWeight) / BPS;
    const current = a.currentEthValue as bigint;

    let isWethToAsset: boolean;
    let amountEth: bigint;

    if (current < targetEthValue) {
      isWethToAsset = true;
      amountEth = targetEthValue - current;
      if (amountEth > availableWeth) amountEth = availableWeth;
    } else if (current > targetEthValue) {
      isWethToAsset = false;
      amountEth = current - targetEthValue;
    } else {
      continue;
    }

    if (amountEth < minSwapRequired) continue;

    let amountToSwap: bigint;
    if (isWethToAsset) {
      amountToSwap = amountEth;
    } else {
      amountToSwap = convertEthToAsset(amountEth, a.price, wethPrice, a.decimals);
    }
    if (amountToSwap === 0n) continue;

    const calldata = encodeFunctionData({
      abi: GBLIN_ABI, functionName: 'incentivizedRebalance',
      args: [BigInt(a.index), isWethToAsset, amountToSwap],
    });

    return {
      bountyAvailable: true,
      assetIndex: a.index,
      token: a.token,
      direction: isWethToAsset ? 'WETH->asset' : 'asset->WETH',
      amountToSwap: amountToSwap.toString(),
      estimatedRewardEth: formatEther(REWARD),
      target: GBLIN,
      calldata,
      value: '0',
      stabilityFundEth: formatEther(stabilityFund),
      note: 'Send this calldata to the target contract to execute the rebalance and earn the reward. The swap uses the contract\'s own funds; the caller only pays gas (~$0.01 on Base).',
    };
  }

  return { bountyAvailable: false, reason: 'Pool is balanced. No profitable rebalance available right now. Check again later.' };
}
