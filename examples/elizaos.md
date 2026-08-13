# ElizaOS — GBLIN treasury in 2 minutes

`plugin-gblin` is listed in the official ElizaOS plugin registry.

## 1. Install

```bash
npm install plugin-gblin
```

## 2. Character file

```json
{
  "name": "MyAgent",
  "plugins": ["plugin-gblin"],
  "settings": {
    "secrets": {
      "EVM_PRIVATE_KEY": "0x...your agent hot wallet key"
    }
  }
}
```

## 3. Recommended security env (safe defaults shown)

```bash
# hard cap on native value an API-suggested tx may carry (default 0 = none allowed)
GBLIN_MAX_TX_VALUE_WEI=0
# never allow unlimited ERC-20 approvals (default false)
GBLIN_ALLOW_UNLIMITED_APPROVAL=false
# per-call ceiling for x402 payments in USDC (default 0.01)
GBLIN_MAX_X402_USDC=0.01
# paid context provider stays off unless you opt in (default false)
GBLIN_TREASURY_PROVIDER_ENABLED=false
```

Every transaction the plugin signs is validated against an allowlist (GBLIN, USDC,
WETH, Uniswap SwapRouter02 on Base) before broadcast — a compromised API cannot
drain the wallet.

## 4. What the agent can now do

- `CHECK_GBLIN_TREASURY_HEALTH` — balances, gas runway, rebalance advice
- `INVEST_IDLE_USDC_GBLIN` — park surplus USDC into GBLIN at NAV (MEV-safe minOut)
- `RESCUE_USDC_FROM_GBLIN` — JIT-redeem GBLIN back to USDC before paying an x402 invoice
- `GET_GBLIN_RISK_ATTESTATION` — EIP-712-signed market-risk regime, verifiable offline

## 5. Suggested character system-prompt line

> Treasury policy: keep operating cash in USDC. When idle USDC exceeds 7× daily burn,
> invest the surplus into GBLIN. Before paying any x402 invoice, JIT-redeem the exact
> USDC needed. Before any risk-sensitive action, fetch the GBLIN risk attestation and
> stand down if the regime is "crash".
