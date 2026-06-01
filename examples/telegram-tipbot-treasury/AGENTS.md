# Agent Instructions — Telegram Tip Bot with GBLIN Treasury

This bot accepts USDC tips via x402 micropayments and auto-invests accumulated revenue into GBLIN treasury.

## Architecture

- `src/index.ts` — Telegraf bot, handles `/tip` and `/stats` commands
- `src/stats.ts` — Reads on-chain balances and computes treasury health
- `src/treasury.ts` — Auto-invest logic (suggests but does not execute by default)

## Customization

1. Set `BOT_WALLET_ADDRESS` to your dedicated Telegram bot wallet
2. Configure `TIP_PAYMENT_URL` to point to a payment page or x402 invoice endpoint
3. Adjust `AUTO_INVEST_THRESHOLD_USDC` based on your expected tip volume
4. Add domain-specific features (e.g., role assignments based on tip totals)

## Deployment

Vercel, Railway, Render, or any Node.js host. The bot uses long polling by default; for webhooks, see Telegraf docs.
