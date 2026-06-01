# Telegram Tip Bot with GBLIN Treasury

A Telegram bot template that accepts USDC tips on Base mainnet and auto-invests the accumulated revenue into GBLIN treasury for capital preservation.

## What it does

- `/tip` — Generates a payment link for tipping the bot owner in USDC
- `/stats` — Shows live on-chain stats (USDC balance, GBLIN holdings, treasury value)
- `/about` — Explains the bot's economics

## Quick start

1. Create a bot via [@BotFather](https://t.me/botfather) and get the token
2. Generate a Base Smart Wallet for the bot's payouts
3. Clone this template:

```bash
cp -r examples/telegram-tipbot-treasury my-tipbot
cd my-tipbot
npm install
cp .env.example .env
# Edit .env
npm run dev
```

## Stack

- Telegraf (Telegram bot framework)
- viem (Base mainnet RPC)
- GBLIN x402 endpoints for treasury operations

## License

MIT. Fork freely.
