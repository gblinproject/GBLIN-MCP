# awesome-x402 submission (ready to PR)

Goal: get GBLIN listed in the community x402 directory so discovery crawlers and
agents find it. Discovery is the #1 bottleneck for agent call volume — being in
the canonical list is table stakes.

Repo: https://github.com/xpaysh/awesome-x402
How: fork → add the bullet(s) below to the most relevant section → open a PR.

---

## Suggested bullets

Under **Services / Live endpoints** (crypto & DeFi data):

- **[GBLIN Protocol](https://gblin.digital/agents)** — Risk & treasury API for agents on Base. On-chain BTC/ETH **risk regime** signal (calm/elevated/crash) and a perishable, EIP-712-verifiable **Risk Attestation** an agent attaches to its actions as proof-of-diligence. Also: NAV/treasury state, MEV-safe swap calldata, JIT GBLIN→USDC for paying x402 invoices, and keeper bounties that *pay* agents. $0.001–$0.005 USDC/call. Machine index: `https://gblin.digital/api/x402/llms.txt` · OpenAPI: `https://gblin.digital/openapi.json`

Under **MCP servers** (if the list has that section):

- **[@gblin-protocol/mcp-server](https://www.npmjs.com/package/@gblin-protocol/mcp-server)** — 10 tools for Base treasury + risk. Free `verify_risk_attestation` (verify a peer's proof-of-diligence), free swap/quote calldata, paid `get_market_risk_regime` and `analyze_treasury_health`. `npx @gblin-protocol/mcp-server`.

---

## Also worth submitting to (same one-line pitch)

- **Coinbase Bazaar** — the CDP facilitator's discovery index. Requires settled x402 payments through the CDP facilitator; re-enable CDP (`X402_ENABLE_CDP="true"`) once Coinbase ships the getSupported fix, then a few live settlements list you automatically.
- **x402scan.com** — reads the `/api/x402/llms.txt` + `declareDiscoveryExtension` schemas already emitted by the middleware. Submit the domain if it isn't auto-indexed.
- **PayAI directory** — you already settle through `facilitator.payai.network`; ask them to feature the endpoints.
- **AgentMesh / agentic.market style catalogs** — same bullet as above.

## Copy for the PR description

> Adds GBLIN Protocol — an x402 risk & treasury API for autonomous agents on Base
> mainnet. Headline: a verifiable, perishable **Risk Attestation** agents attach to
> their actions as proof-of-diligence (novel — no other listed service sells a
> reusable "proof you checked risk"), plus a free MCP tool to verify one. All data
> is on-chain and independently verifiable. Machine-readable index and OpenAPI
> included.
