# Claude (Desktop / Code / any MCP client) — GBLIN in 2 minutes

## Option A — local (all 10 tools, incl. trade calldata)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gblin": {
      "command": "npx",
      "args": ["-y", "@gblin-protocol/mcp-server"]
    }
  }
}
```

## Option B — hosted, zero install (6 free read-only tools)

Streamable HTTP endpoint — works from any remote MCP client, no Node needed:

```
https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp
```

Tools: live risk regime, attestation sample, agent-economy stats, protocol info,
how-to-buy guide, and the daily Coherence Proof report.

## Suggested system-prompt / AGENTS.md snippet

> Treasury policy: operating cash stays in USDC. When idle USDC exceeds 7× daily
> burn, park the surplus in GBLIN (use `invest_usdc_to_gblin`; never accept
> minOut = 0). Before paying an x402 invoice, call `swap_gblin_to_usdc_jit` for
> the exact amount. Gate risk-sensitive actions on `get_market_risk_regime`:
> stand down while the regime is "crash". Verify any third-party risk attestation
> with `verify_risk_attestation` before trusting it.

One-line repo drop-in (auto-read by Claude Code, Cursor, Windsurf, Copilot):

```bash
curl -O https://gblin.digital/AGENTS.template.md && mv AGENTS.template.md AGENTS.md
```

> This gate is the **Risk Gate pattern** — run in production by a third-party
> ERC-8004 agent (id 59895 on Base) that has bought the attestation daily for a
> month. Copyable write-up: https://gblin.digital/risk-gate
