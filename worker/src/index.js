/**
 * GBLIN MCP over Streamable HTTP — Cloudflare Worker (free plan).
 *
 * WHY THIS EXISTS: the npm server (@gblin-protocol/mcp-server) is stdio-only —
 * hosted agents and URL-based registries (Smithery) need an HTTPS endpoint.
 * This Worker is the HTTP twin: a STATELESS Streamable HTTP MCP server with
 * the light, free, read-only tools. It sells nothing and holds no keys; the
 * paid data stays on the x402 endpoints (gblin.digital), which this server
 * points buyers to.
 *
 * Design constraints (Workers free plan):
 *   - 100k requests/day, 10 ms CPU per invocation. All tools are either
 *     cached upstream fetches (I/O, ~0 CPU) or tiny hex parsing.
 *   - Stateless: no sessions, no SSE stream, one JSON response per POST.
 *     Every JSON-RPC exchange is self-contained (spec-permitted mode).
 *   - Zero dependencies: the JSON-RPC handling is ~100 lines, hand-rolled,
 *     so there is no bundler and no supply chain.
 *   - Kill switch: env.MCP_DISABLED = "true" → 503 for everything.
 *   - Best-effort per-IP rate limit (per isolate): 60 req/min.
 */

const GBLIN = "0x36C81d7E1966310F305eA637e761Cf77F90852f0";
const BASKET_SELECTOR = "0x8c7e0875"; // basket(uint256)
// Multiple public RPCs: some (e.g. mainnet.base.org) reject requests coming
// from Cloudflare's datacenter IPs, so the first reachable one wins.
const FALLBACK_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
];
const SITE = "https://gblin.digital";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "gblin-mcp-http", version: "0.1.0" };

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_market_risk_regime",
    description:
      "Current BTC/ETH market risk regime (calm | elevated | crash) read live from GBLIN's on-chain Crash Shield on Base mainnet. Free. Same math as the paid EIP-712 attestation, but unsigned — for a signed, attachable proof buy the x402 attestation (see how_to_buy_live_attestation).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_attestation_sample",
    description:
      "FREE static sample of the paid Risk Attestation: identical shape and EIP-712 schema, sample:true, permanently expired. Wire your parser/verifier against this, then switch to the paid endpoint.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_agent_economy_stats",
    description:
      "Public GBLIN agent-economy observatory stats (x402 calls, payers, on-chain counters). Cached.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_protocol_info",
    description:
      "GBLIN protocol overview for agents (llms.txt): contracts, endpoints, prices, payment flow, field contract of the attestation.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "how_to_buy_live_attestation",
    description:
      "Instructions for buying the live EIP-712-signed risk attestation over x402 ($0.003 USDC on Base) and verifying it offline.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ── Cached fetch helper (Cloudflare Cache API) ──────────────────────────────

async function cachedFetch(url, ttlSeconds, init) {
  const cacheKey = new Request(url, { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.clone();
  const res = await fetch(url, init);
  if (res.ok) {
    const toStore = new Response(res.clone().body, res);
    toStore.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    await cache.put(cacheKey, toStore);
  }
  return res;
}

// ── On-chain regime (same math as the attestation route / npm MCP tool) ─────

async function ethCallBasket(rpc, index) {
  const data =
    BASKET_SELECTOR + index.toString(16).padStart(64, "0");
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: GBLIN, data }, "latest"],
    }),
  });
  const out = await res.json();
  if (out.error || !out.result || out.result === "0x") return null;
  const hex = out.result.slice(2);
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  if (hex.length < 6 * 64) return null;
  return {
    token: "0x" + word(0).slice(24),
    isStable: BigInt("0x" + word(3)) === 1n,
    baseWeightBps: Number(BigInt("0x" + word(4))),
    dynamicWeightBps: Number(BigInt("0x" + word(5))),
  };
}

async function computeRegime(env) {
  const rpcs = env.GBLIN_RPC_URL
    ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS]
    : FALLBACK_RPCS;

  // Pick the first RPC that answers basket(0), then reuse it for the rest.
  let rpc = null;
  let first = null;
  for (const candidate of rpcs) {
    try {
      first = await ethCallBasket(candidate, 0);
      if (first) {
        rpc = candidate;
        break;
      }
    } catch {
      // try the next one
    }
  }
  if (!rpc || !first) throw new Error("basket read failed on all RPCs");

  const entries = [first];
  for (let i = 1; i < 8; i++) {
    let e = null;
    try {
      e = await ethCallBasket(rpc, i);
    } catch {
      break;
    }
    if (!e || (e.baseWeightBps === 0 && e.dynamicWeightBps === 0)) break;
    entries.push(e);
  }

  const riskAssets = entries.filter((e) => !e.isStable);
  const assets = riskAssets.map((e) => {
    const cut =
      e.baseWeightBps > 0
        ? Math.max(0, ((e.baseWeightBps - e.dynamicWeightBps) / e.baseWeightBps) * 100)
        : 0;
    return {
      token: e.token,
      shielded: e.dynamicWeightBps < e.baseWeightBps,
      base_weight_pct: e.baseWeightBps / 100,
      dynamic_weight_pct: e.dynamicWeightBps / 100,
      weight_cut_pct: Number(cut.toFixed(2)),
    };
  });
  const maxCut = assets.reduce((m, a) => Math.max(m, a.weight_cut_pct), 0);
  const usdc = entries.find((e) => e.isStable);
  const regimeCode = maxCut <= 0 ? 0 : maxCut < 40 ? 1 : 2;
  return {
    regime: ["calm", "elevated", "crash"][regimeCode],
    regime_code: regimeCode,
    risk_posture: ["risk_on", "reduce", "risk_off"][regimeCode],
    severity_pct: Number(maxCut.toFixed(2)),
    defensive_cash_pct: usdc ? usdc.dynamicWeightBps / 100 : 0,
    shield_active: entries.some((e) => e.dynamicWeightBps < e.baseWeightBps),
    assets,
    contract: GBLIN,
    chain_id: 8453,
    source: "GBLIN on-chain Crash Shield (Base mainnet), read live",
    note: "Unsigned free reading. For a signed, attachable, verifiable-offline proof: how_to_buy_live_attestation.",
  };
}

// 60s regime cache via the Cache API (synthetic key).
async function cachedRegime(env) {
  const key = new Request("https://gblin-mcp.internal/regime-cache");
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const regime = await computeRegime(env);
  const res = new Response(JSON.stringify(regime), {
    headers: { "content-type": "application/json", "Cache-Control": "public, max-age=60" },
  });
  await cache.put(key, res.clone());
  return regime;
}

// ── Tool dispatch ───────────────────────────────────────────────────────────

async function callTool(name, env) {
  switch (name) {
    case "get_market_risk_regime":
      return cachedRegime(env);
    case "get_attestation_sample": {
      const r = await cachedFetch(`${SITE}/api/x402/attestation-sample`, 3600);
      return r.json();
    }
    case "get_agent_economy_stats": {
      const r = await cachedFetch(`${SITE}/api/agent-stats`, 300);
      return r.json();
    }
    case "get_protocol_info": {
      const r = await cachedFetch(`${SITE}/api/x402/llms.txt`, 3600);
      return { llms_txt: await r.text() };
    }
    case "how_to_buy_live_attestation":
      return {
        endpoint: `${SITE}/api/x402/attestation`,
        price: "0.003 USDC on Base (eip155:8453)",
        flow:
          "GET the endpoint → HTTP 402 with the payment challenge in both the PAYMENT-REQUIRED header and the JSON body → sign an EIP-3009 USDC transferWithAuthorization for the `accepts[0]` requirements → retry with the payment header → receive the signed attestation. Any x402 client (x402-fetch, AgentKit, Coinbase CDP) handles this automatically.",
        free_sample: `${SITE}/api/x402/attestation-sample`,
        verify_offline:
          "Recompute hashTypedData over `eip712` and compare to `attestation_id`; if `signed`, recover the EIP-712 signer and check it equals `attestor`. Then check expires_at > now. Free verifier: npx @gblin-protocol/mcp-server → verify_risk_attestation.",
        stable_field_contract: [
          "regime (calm|elevated|crash)",
          "shield_active",
          "severity_pct",
          "defensive_cash_pct",
          "expires_at",
        ],
      };
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

// ── JSON-RPC / MCP plumbing (stateless Streamable HTTP) ─────────────────────

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && "id" in msg ? msg.id : null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isNotification = !("id" in msg);

  try {
    switch (method) {
      case "initialize": {
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOLS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "GBLIN Protocol — the Machine Reserve on Base. Free read-only tools; the signed risk attestation is a paid x402 endpoint (see how_to_buy_live_attestation). Stateless server: no session required.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = params && params.name;
        try {
          const out = await callTool(name, env);
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
            isError: false,
          });
        } catch (err) {
          if (err && err.code === -32602) throw err;
          return rpcResult(id, {
            content: [{ type: "text", text: `Tool failed: ${err.message}` }],
            isError: true,
          });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized etc.
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, err.code || -32603, err.message || "Internal error");
  }
}

// ── Rate limit (best-effort, per isolate) ───────────────────────────────────

const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, windowStart: now };
  if (now - b.windowStart > 60_000) {
    b.count = 0;
    b.windowStart = now;
  }
  b.count++;
  buckets.set(ip, b);
  if (buckets.size > 10_000) buckets.clear(); // memory guard
  return b.count > 60;
}

// ── HTTP entry point ────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

export default {
  async fetch(request, env) {
    if (env.MCP_DISABLED === "true") {
      return json({ error: "GBLIN MCP temporarily disabled" }, 503);
    }

    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (rateLimited(ip)) return json({ error: "rate limited (60 req/min)" }, 429);

    // Info page for humans/probes at the root.
    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: SERVER_INFO.name,
        mcp_endpoint: "/mcp",
        transport: "streamable-http (stateless, JSON responses)",
        tools: TOOLS.map((t) => t.name),
        stdio_twin: "npx @gblin-protocol/mcp-server (full toolset, free)",
        site: SITE,
      });
    }

    if (url.pathname !== "/mcp") return json({ error: "not found — MCP endpoint is /mcp" }, 404);

    // Stateless server: no SSE stream to resume. Spec-permitted response.
    if (request.method === "GET") {
      return json({ error: "SSE not supported: stateless server, POST JSON-RPC to /mcp" }, 405, { Allow: "POST" });
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const results = [];
      for (const m of body) {
        const r = await handleMessage(m, env);
        if (r) results.push(r);
      }
      if (results.length === 0) return new Response(null, { status: 202, headers: CORS });
      return json(results);
    }

    const result = await handleMessage(body, env);
    if (result === null) return new Response(null, { status: 202, headers: CORS });
    return json(result);
  },
};
