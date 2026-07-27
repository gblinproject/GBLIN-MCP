# CoinGecko + CoinMarketCap listing — fill-in sheet (2026-07-27)

Everything needed to complete both listing forms in one sitting. Copy-paste the
values; the description block is pre-written to house honesty rules (no
"audited" without qualification, no "immutable"/"no admin key", no contract
version numbers, no unverifiable "first/only" claims).

## Token basics

| Field | Value |
|---|---|
| Token name | Global Balanced Liquidity Index |
| Ticker / symbol | GBLIN |
| Chain / platform | Base (chain ID 8453) |
| Contract address | `0x36C81d7E1966310F305eA637e761Cf77F90852f0` |
| Decimals | 18 |
| Token standard | ERC-20 (with EIP-2612 Permit) |
| Launch type | Fair launch, no token sale |
| Logo (PNG, direct URL) | `https://raw.githubusercontent.com/gblinproject/GBLIN/main/LOGO_GBLIN.png` |
| Website | `https://gblin.digital` |
| Contact email | info@gblin.digital |

## Supply API endpoints (already live, plain-text number as required)

| Field | Value |
|---|---|
| Total supply API | `https://gblin.digital/api/supply/total` |
| Circulating supply API | `https://gblin.digital/api/supply/circulating` |
| Max supply | None fixed (supply mints/burns against NAV on buy/sell) |

Both endpoints return the bare number in plain text — the format CoinGecko and
CMC require. Test them in a browser before submitting.

## Markets / liquidity pools

| Venue | Pair | Pool address |
|---|---|---|
| Aerodrome (Base) | GBLIN/WETH | `0x6Ac18D5e90278D2477027B5769EFb2fF0711FFbB` |
| Uniswap (Base) | GBLIN/WETH | `0xAb305c45F4E42A73909a49a6775e3f7782239dAE` |
| Protocol contract | direct buy/sell at NAV | `0x36C81d7E1966310F305eA637e761Cf77F90852f0` |

GeckoTerminal / DEX aggregator links for the form (auto-derived from the pools):
- `https://www.geckoterminal.com/base/pools/0x6Ac18D5e90278D2477027B5769EFb2fF0711FFbB`
- `https://www.geckoterminal.com/base/pools/0xAb305c45F4E42A73909a49a6775e3f7782239dAE`

## Project description (paste as-is)

> GBLIN is a NAV-backed basket token on Base: each token is redeemable pro-rata
> against an on-chain treasury of cbBTC, WETH and USDC, with buys and sells
> executed directly against the contract at NAV. An automated on-chain
> crash-response mechanism ("Crash Shield") reduces volatile-asset exposure
> during severe oracle-measured drawdowns and restores it in recovery. Fees are
> 0.05% (founder) + 0.05% (stability, accruing to NAV); parameters are governed
> by a 48-hour public timelock, and the contract has been analyzed with Slither
> (0 critical / 0 high findings; no external manual audit).

## Explorer links

- BaseScan token page: `https://basescan.org/token/0x36C81d7E1966310F305eA637e761Cf77F90852f0`
- BaseScan contract (verified source): `https://basescan.org/address/0x36C81d7E1966310F305eA637e761Cf77F90852f0#code`
- Blockscout (Base): `https://base.blockscout.com/token/0x36C81d7E1966310F305eA637e761Cf77F90852f0`

## Socials / links

| Channel | Value |
|---|---|
| Telegram | `https://t.me/GBLINHub` |
| Farcaster | `https://warpcast.com/gblin` (@gblin) |
| X / Twitter | `https://x.com/GBLIN_Protocol` |
| GitHub | `https://github.com/gblinproject` |
| Docs / agents page | `https://gblin.digital/agents` |

## Where to submit — step by step

### CoinGecko
1. Go to `https://www.coingecko.com/en/coins/new` (the "Request Form" — also
   reachable from the site footer → "Request Form" / support.coingecko.com).
2. Log in / create a (free) CoinGecko account with info@gblin.digital.
3. Choose "New cryptoasset (token) listing" and fill the form with the tables
   above: contract + chain first (it auto-detects name/symbol/decimals), then
   supply APIs, pools, logo URL, description, socials.
4. Submit. Typical review is days-to-weeks; they reply to the account email.
   Track status from the same form portal; do not submit duplicates.

### CoinMarketCap
1. Go to `https://coinmarketcap.com/request/` and pick "[New Listing] Add
   cryptoasset".
2. Log in / create a CMC account with info@gblin.digital.
3. Fill the same data. CMC additionally asks for: date launched, a one-line
   "what makes this project unique" (use the first sentence of the description),
   supply APIs, and at least one active market — give both pools plus the
   GeckoTerminal links as price sources.
4. Submit and keep the ticket ID from the confirmation email for follow-ups.

### Notes
- Both forms are free; anyone asking for payment to "expedite" is a scammer.
- If a form field demands a "security audit link", link the Slither report in
  `GBLIN-Protocol/audits/` and state plainly: static analysis only, 0 critical /
  0 high, no external manual audit.
- Listing forms occasionally move; if a URL 404s, reach the form from the site
  footer ("Request Form" on CoinGecko, "Request" on CMC).
