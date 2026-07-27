# GBLIN Risk Attestation — partner outreach list (Jul 2026)

Goal: get **one** partner to *require or reward* a fresh GBLIN Risk Attestation, so
their existing agent flow generates recurring paid mints for us. Ordered by
leverage × reachability. Confirm each project's current X/Discord from its site
before sending (handles change).

Mint: `GET https://gblin.digital/api/x402/attestation` ($0.003) · Verify (free):
`verify_risk_attestation` in `@gblin-protocol/mcp-server` · One-pager:
`distribution/partner-integration.md`.

**Ready-to-send messages** for targets 1–5 are drafted in
[`outreach-messages.md`](./outreach-messages.md) (2026-07-27).

---

## Tier 1 — capital-moving agents (best fit: they *should* check risk)

**1. Giza / ARMA** — agents that allocate real capital across Base DeFi
(Moonwell, Silo, Morpho, Yearn, Euler, Avantis). Reported ~$3.96B agentic volume;
ARMA alone 25,000+ agent instances optimizing $35M+ across 100k+ txs.
- **Ask:** let ARMA agents attach a GBLIN risk attestation to allocations, and
  tighten sizing when `regime = crash`. It's a free, independent risk gate they
  didn't have to build, and a "risk-managed" signal for their users.
- **Reach:** Giza docs/GitHub → their X + Discord. Start in their dev/builders channel.
- **Effort:** medium · **Leverage:** very high.

**2. Stable-Up style vaults / Yield Pilot** — AI copilots that route deposits
across Base yield (ERC-4626). Yield Pilot optimizes risk/APY/gas automatically;
Stable-Up-type products run agents across dozens of protocols.
- **Ask:** show the current GBLIN regime on the allocation screen and require a
  fresh attestation before high-risk moves; badge agents that gate on it.
- **Reach:** site → X/Discord.
- **Effort:** medium · **Leverage:** high.

## Tier 2 — reputation / routing meta-layers (fold us into scoring)

**3. Kompass** — agent-commerce meta-router: queries 12 registries (ACP, MCP,
x402, ERC-8004, Locus, Bankr, Olas, Skills, A2A, L402, ADP, Kompass), ranks with
Bayesian reputation, routes payments.
- **Ask:** add "carries a fresh GBLIN risk attestation" as a reputation input, or
  route treasury/risk checks to GBLIN. One integration → every agent they route
  is incentivized to mint.
- **Reach:** Kompass site → X/Discord/GitHub.
- **Effort:** medium · **Leverage:** very high (it's a distribution multiplier).

## Tier 3 — frameworks (distribution: put the tool in every agent's hands)

**4. Coinbase AgentKit** — framework-agnostic agent wallet toolkit; supports the
OpenAI Agents SDK and has an ElizaOS plugin. Huge reach.
- **Ask:** contribute a "GBLIN risk attestation" action (mint + verify) to AgentKit
  so any agent can prove diligence in one call.
- **Reach:** `github.com/coinbase/agentkit` (issue/PR) + CDP Discord / DevRel.
- **Effort:** medium-high · **Leverage:** very high (but slower, it's Coinbase).

**5. ElizaOS** — you already publish `plugin-gblin`. Push the attestation capability
into it and get the plugin featured.
- **Ask:** feature `plugin-gblin` in the ElizaOS plugins registry with the
  attestation flow front-and-center; propose it in their showcase.
- **Reach:** `github.com/elizaos-plugins` + ElizaOS Discord.
- **Effort:** low (you're already in) · **Leverage:** medium-high.

## Tier 4 — infra & discovery (visibility, not gating)

**6. AsterPay** — x402 facilitator with an ElizaOS plugin, ERC-8004 ready.
Ask to be featured as a listed x402 service. Low effort, low commitment.

**7. Base MCP (official)** — integrates Morpho/Moonwell via conversational AI.
Ask to be included so agents can call GBLIN risk from the official Base MCP.

**8. Morpho curators** — you already run a GBLIN-USDC market. Ask a curator to use
the on-chain regime as a risk input and co-market the market. Warm intro via the
existing market.

---

## Where to start (this week)
1. **Kompass** + **Giza** — highest leverage; one yes = compounding volume.
2. **ElizaOS feature** — you're already in; cheapest win.
3. Keep **AgentKit** as the slow-burn big prize (open a GitHub issue to plant the seed).

## Simple tracker

| # | Target | Channel | Ask | Sent | Reply | Status |
|---|--------|---------|-----|------|-------|--------|
| 1 | Giza / ARMA | X/Discord | attach + gate on crash | | | DRAFT READY (msg 2) |
| 2 | Yield Pilot / Stable-Up | X/Discord | show regime + gate | | | DRAFT READY (msg 5) |
| 3 | Kompass | X/Discord/GH | reputation input | | | DRAFT READY (msg 1 — send first) |
| 4 | Coinbase AgentKit | GitHub/Discord | native action | | | DRAFT READY (msg 3) |
| 5 | ElizaOS | GitHub/Discord | feature plugin-gblin | | | DRAFT READY (msg 4) |
| 6 | AsterPay | site | list as service | | | |
| 7 | Base MCP | GitHub | include GBLIN risk | | | |
| 8 | Morpho curator | market/X | risk input + co-market | | | |
