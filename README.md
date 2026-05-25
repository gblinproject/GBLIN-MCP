# GBLIN MCP Server

> **Treasury standard for AI agents on Base mainnet.** A Model Context Protocol (MCP) server that lets autonomous agents hold capital in GBLIN — a diversified, Crash-Shield-protected on-chain index — and Just-In-Time swap to USDC the millisecond they need to pay an [x402](https://docs.cdp.coinbase.com/x402/welcome) invoice.

[![npm](https://img.shields.io/npm/v/@gblin-protocol/mcp-server.svg)](https://www.npmjs.com/package/@gblin-protocol/mcp-server)
[![CI](https://github.com/gblinproject/GBLIN-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/gblinproject/GBLIN-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Base Mainnet](https://img.shields.io/badge/network-Base%20mainnet-0052FF)](https://basescan.org/address/0x38DcDB3A381677239BBc652aed9811F2f8496345)
[![Governance: 48h Timelock](https://img.shields.io/badge/governance-48h%20Timelock-1f6feb)](https://basescan.org/address/0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd)

📖 **Full documentation and Quick Start:** [gblin.digital/agents](https://gblin.digital/agents)

---

## ElizaOS Plugin

For agents running on **ElizaOS**, install the companion plugin:

```bash
npm install plugin-gblin
# or: elizaos plugins add gblin
```

It exposes three native Actions (`CHECK_GBLIN_TREASURY_HEALTH`, `INVEST_IDLE_USDC_GBLIN`, `RESCUE_USDC_FROM_GBLIN`) and a Provider that injects live NAV + Crash Shield status into the agent context on every loop.

→ [Full Eliza plugin docs](https://github.com/gblinproject/GBLIN_PLUGIN)

---

## AI assistant discovery — `gblin-init`

Drop an `AGENTS.md` treasury policy into your repo so every modern AI coding
assistant (Claude Code, Cursor, Windsurf, GitHub Copilot, Codex) automatically
discovers GBLIN when it works on your codebase:

```bash
npx -p @gblin-protocol/mcp-server gblin-init
```

The command is **idempotent and safe**:

- If `AGENTS.md` does not exist → creates it from the canonical template at
  [`gblin.digital/AGENTS.template.md`](https://gblin.digital/AGENTS.template.md).
- If `AGENTS.md` exists → appends a clearly delimited GBLIN block at the
  bottom; your own content is never touched.
- Re-running is a no-op (detected via stable HTML markers).
- `--dry-run` prints what it would do without writing.
- `--force` refreshes the block to the latest version.

It also runs offline thanks to a bundled fallback template.

### Postinstall hint

When the package is installed as a regular dependency (`npm i @gblin-protocol/mcp-server`),
a short tip is printed once suggesting the command above. **No files are
written** during postinstall — security-friendly and Socket-compliant. Set
`GBLIN_SKIP_HINT=1` to silence it.

---

## Trust & Governance

**GBLIN_V5 is owned by a 48h Timelock Controller** — every admin operation (parameter change, oracle update, ownership transfer) is enforced on-chain to wait **172,800 seconds** before execution. Agents and integrators can verify this directly on BaseScan.

| Component | Address | Role |
|---|---|---|
| **GBLIN_V5 token** | [`0x38DcDB3A...6345`](https://basescan.org/address/0x38DcDB3A381677239BBc652aed9811F2f8496345) | Index contract — owned by timelock |
| **Timelock Controller** | [`0x6aBeC8716...8e5Dd`](https://basescan.org/address/0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd) | 48h immutable delay, 14d grace period |
| **Ownership transfer tx** | [`0xb653f54f...edaaf`](https://basescan.org/tx/0xb653f54ffa9b1764b41932e6a411077e7e34550605303f15d90900de682edaaf) | Transferred at block 46160610 |

Properties enforced at the contract level:
- `MIN_DELAY` is **immutable** (override of `updateDelay` reverts permanently)
- `PROPOSER_ROLE` and `CANCELLER_ROLE` are **strictly separated** (constructor reverts on overlap)
- `EXECUTOR_ROLE` is open (`address(0)`) — anyone can execute a matured operation, anti-censorship
- The timelock is **self-administered**: every role/config change must itself go through the 48h delay

This is why the `get_governance_state` tool returns `owner_is_timelock: true` and a verifiable `min_delay_seconds: 172800`. AI agents can use these flags to gate trust-sensitive actions.

---

## Why this exists

AI agents today hold their working capital in **USDC**. USDC sits flat: zero yield, full inflation exposure.

**GBLIN** is an on-chain index on Base (45% cbBTC + 45% WETH + 10% USDC) with an algorithmic Crash Shield that auto-rebalances toward USDC when a basket asset drops >20%. Agents holding GBLIN earn basket appreciation while keeping the ability to settle x402 invoices instantly via native one-tx atomic swaps.

This server exposes that capability to any LLM agent through the standard MCP protocol.

---

## Quick start

### Claude Desktop

Add to `claude_desktop_config.json` (on Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

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

Restart Claude Desktop. The 6 GBLIN tools appear in the tool picker.

### Windsurf / Cursor

Add to `~/.codeium/windsurf/mcp_config.json` (Windsurf) or the equivalent Cursor MCP config:

```json
{
  "mcpServers": {
    "gblin": {
      "command": "npx",
      "args": ["-y", "@gblin-protocol/mcp-server"],
      "env": {
        "GBLIN_RPC_URL": "https://base-rpc.publicnode.com"
      }
    }
  }
}
```

Refresh MCP servers from the IDE settings (or restart). The tools become callable inline.

### Coinbase AgentKit (TypeScript)

```ts
import { MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@gblin-protocol/mcp-server"],
});
const client = new MCPClient({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// List tools
const { tools } = await client.listTools();

// Quote a JIT payment of $0.50
const jit = await client.callTool({
  name: "swap_gblin_to_usdc_jit",
  arguments: { usdc_needed: "0.50", wallet_address: "0xYourAgent..." },
});
```

### ElizaOS / custom

Any framework that speaks MCP over stdio works:

```bash
npx @gblin-protocol/mcp-server
```

Also supports Cline, Continue.dev, and any agent that implements the MCP client spec.

---

## The 6 tools

| Tool | Purpose |
|---|---|
| `get_treasury_state` | NAV in USD + basket composition + Crash Shield status |
| `quote_safe_swap` | Preview buy or sell with dynamic slippage buffer |
| `swap_gblin_to_usdc_jit` | **The x402 magic**: generate atomic GBLIN→USDC calldata |
| `invest_usdc_to_gblin` | Convert USDC earnings into GBLIN treasury (MEV-safe) |
| `analyze_treasury_health` | Balances + gas + runway + rebalance advice |
| `get_governance_state` | Verify owner == 48h Timelock + pending asset proposals + min delay |

All tools return structured JSON. All values are quoted on-chain (NAV via `quoteSellGBLIN` × Chainlink ETH/USD, with 24h staleness guard). No mock data.

**Live verification:** the test suite (`npm test`) runs all six tools against Base mainnet and confirms calldata generation, oracle freshness, slippage math, and governance state. See the [latest CI run](https://github.com/gblinproject/GBLIN-MCP/actions).

---

## Architectural decisions

### Native atomic swap

The GBLIN contract exposes `sellGBLINForToken(amount, targetToken, fee, minOut)`. This burns GBLIN, swaps the basket → WETH → target token in a **single transaction**. No batched UserOp, no ERC-4337 dependency, no risk of half-finished JIT.

The MCP returns calldata that works identically on:
- **EOA wallets** (Privy, MetaMask, raw private key)
- **ERC-4337 smart accounts** (Safe, Coinbase smart account)
- **EIP-7702 delegated EOAs** (Pectra+)

### Dynamic slippage

Slippage tolerance scales with on-chain risk regime:

| Condition | Buffer |
|---|---|
| Normal market | **2.5%** |
| Crash Shield active (≥1 basket asset slashed) | **4.0%** |

The buffer is applied on top of the contract's internal `maxInternalSlippage` (200 bps), absorbing oracle drift and Uniswap pool variance.

### MEV protection

`invest_usdc_to_gblin` **never** passes `minOut = 0`. Both `minWethOut` and `minGblinOut` are computed from on-chain quotes plus the dynamic slippage buffer. This eliminates the sandwich-attack surface that plagues naïve buy-with-token tools.

### Cooldown enforcement

The contract enforces a 120-second sell lock after each buy. The JIT tool reads `lastDepositTime` and the **on-chain `block.timestamp`** (never `Date.now()`) and returns a clear `CooldownActive` error with the exact seconds remaining if the swap would revert.

---

## Configuration

The server reads `GBLIN_RPC_URL` from the environment. With no env var it falls back to `https://base-rpc.publicnode.com` (free, no key, generous limits).

For production load (>100 concurrent agents) use a dedicated provider:

```bash
export GBLIN_RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
npx @gblin-protocol/mcp-server
```

See `.env.example` for the full list.

---

## Development

```bash
git clone https://github.com/gblinproject/GBLIN-MCP
cd GBLIN-MCP
npm install
npm run build
npm test         # live read-only smoke test against Base mainnet
npm start        # run the compiled server
```

Project layout:

```
src/
  config.ts    # network constants, addresses, slippage params
  abi.ts       # GBLIN_V5 + Chainlink + ERC-20 ABIs
  client.ts    # viem PublicClient + on-chain timestamp helper
  helpers.ts   # NAV, basket state, slippage, cooldown, reverse quote
  tools.ts     # the 6 tool implementations + zod schemas
  index.ts     # MCP stdio server entry
scripts/
  test.ts      # live smoke test
```

---

## Security notes

- The server is **read-only**. It never holds, signs, or broadcasts.
- All quotes are derived from on-chain calls + Chainlink oracles. Stale or negative oracle answers cause the tool to abort with `OracleStale` / `OracleDead`.
- The agent's wallet is the sole signer. Calldata returned by tools is plain ABI-encoded bytes — review before broadcasting in untrusted environments.
- No telemetry, no analytics, no remote dependencies beyond the configured RPC.

---

## Roadmap

- **v0.2**: Uniswap V3 QuoterV2 integration for sub-1% slippage precision
- **v0.3**: Permit2 support (skip the approve step for x402 reinvestment)
- **v0.4**: Streamable HTTP transport for hosted multi-agent setups
- **v1.0**: Audited contract integration + remote-only deployment guide

---

## Links

- **Contract**: [0x38DcDB3A38…6345](https://basescan.org/address/0x38DcDB3A381677239BBc652aed9811F2f8496345)
- **Protocol site**: https://gblin.digital
- **Agent docs**: https://gblin.digital/agents
- **Issues**: https://github.com/gblinproject/GBLIN-MCP/issues

MIT © 2026 GBLIN Protocol
