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

// All tools are read-only, idempotent within their cache TTL, and touch the
// open world (public chain + public HTTP endpoints) — declared via annotations.
const RO = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const TOOLS = [
  {
    name: "get_market_risk_regime",
    description:
      "Current BTC/ETH market risk regime (calm | elevated | crash) read live from GBLIN's on-chain Crash Shield on Base mainnet. Free. Same math as the paid EIP-712 attestation, but unsigned — for a signed, attachable proof buy the x402 attestation (see how_to_buy_live_attestation).",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Market risk regime (live, free)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        regime: { type: "string", enum: ["calm", "elevated", "crash"], description: "Current risk regime" },
        regime_code: { type: "integer", description: "0 calm, 1 elevated, 2 crash" },
        risk_posture: { type: "string", enum: ["risk_on", "reduce", "risk_off"], description: "Suggested posture" },
        severity_pct: { type: "number", description: "Max crash-shield weight cut across risk assets, percent" },
        defensive_cash_pct: { type: "number", description: "USDC dynamic weight in the basket, percent" },
        shield_active: { type: "boolean", description: "True when any risk asset is currently slashed" },
        assets: {
          type: "array",
          description: "Per-risk-asset shield state",
          items: {
            type: "object",
            properties: {
              token: { type: "string", description: "ERC-20 address" },
              shielded: { type: "boolean" },
              base_weight_pct: { type: "number" },
              dynamic_weight_pct: { type: "number" },
              weight_cut_pct: { type: "number" },
            },
            required: ["token", "shielded", "weight_cut_pct"],
          },
        },
        contract: { type: "string", description: "GBLIN contract on Base" },
        chain_id: { type: "integer" },
        source: { type: "string" },
        note: { type: "string" },
      },
      required: ["regime", "regime_code", "severity_pct", "defensive_cash_pct", "shield_active", "assets"],
    },
  },
  {
    name: "get_attestation_sample",
    description:
      "FREE static sample of the paid Risk Attestation: identical shape and EIP-712 schema, sample:true, permanently expired. Wire your parser/verifier against this, then switch to the paid endpoint.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Attestation sample (free, expired)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        sample: { type: "boolean", description: "Always true — never a live signal" },
        attestation: {
          type: "object",
          description: "Same field contract as the paid attestation (regime, shield_active, severity_pct, defensive_cash_pct, expires_at, ...)",
        },
        eip712: { type: "object", description: "EIP-712 domain/types/message to recompute the digest" },
        attestation_id: { type: "string", description: "hashTypedData digest — recompute to verify" },
        signature: { type: ["string", "null"] },
        attestor: { type: ["string", "null"] },
        signed: { type: "boolean" },
        verify: { type: "object" },
        meta: { type: "object" },
      },
      required: ["sample", "attestation", "attestation_id", "signed"],
    },
  },
  {
    name: "get_agent_economy_stats",
    description:
      "Public GBLIN agent-economy observatory stats (x402 calls, payers, on-chain counters). Cached.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Agent-economy stats (free, cached)", ...RO },
    outputSchema: {
      type: "object",
      description:
        "Observatory payload from gblin.digital/api/agent-stats — cumulative x402 call and payer counters with methodology notes",
      additionalProperties: true,
    },
  },
  {
    name: "get_protocol_info",
    description:
      "GBLIN protocol overview for agents (llms.txt): contracts, endpoints, prices, payment flow, field contract of the attestation.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Protocol info / llms.txt (free)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        llms_txt: { type: "string", description: "The full llms.txt document (plain text)" },
      },
      required: ["llms_txt"],
    },
  },
  {
    name: "how_to_buy_live_attestation",
    description:
      "Instructions for buying the live EIP-712-signed risk attestation over x402 ($0.003 USDC on Base) and verifying it offline.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "How to buy the signed attestation", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Paid x402 endpoint URL" },
        price: { type: "string" },
        flow: { type: "string", description: "Step-by-step x402 payment flow" },
        free_sample: { type: "string", description: "Free integration-sample URL" },
        verify_offline: { type: "string", description: "How to verify the attestation without trusting the server" },
        stable_field_contract: {
          type: "array",
          items: { type: "string" },
          description: "Field names guaranteed stable without versioning",
        },
      },
      required: ["endpoint", "price", "flow"],
    },
  },
  {
    name: "get_coherence_report",
    description:
      "Coherence Proof (free, forever): does this subject DO what it publicly promised? v0 observes GBLIN itself — pre-registered, hash-pinned promises (uptime of the paid attestation endpoint, honesty of public counters) probed every 10 minutes, with kept/violated tallies. The certifier submits itself to its own instrument first. Reading is free by design; being observed is the paid service.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Coherence report (promises vs conduct, free)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Observed subject" },
        promises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short promise id (P1, P2, ...)" },
              promiseId: { type: "string", description: "keccak256 of the pre-registered promise file" },
              file: { type: "string", description: "Public URL of the promise file" },
              observations: { type: "integer" },
              kept: { type: "integer" },
              violations: { type: "integer" },
              kept_bps: { type: "integer", description: "Kept ratio in basis points (10000 = 100%)" },
              last_observation: { type: "string" },
              last_status: { type: "string", enum: ["kept", "violated"] },
            },
          },
        },
        observing_since: { type: "string" },
        method: { type: "string" },
      },
      required: ["subject", "promises"],
    },
  },
];

// ── Coherence Proof v0 — the automaton observing ourselves ──────────────────
//
// Pre-registered, hash-pinned promises (pattern borrowed from the one client
// that holds US accountable: a published file whose hash is the commitment).
// Every 10 minutes the scheduled handler probes the checks; every observation
// is tallied per promise per day in KV. Reading the report is free, forever —
// that is the design, not a promo. On-chain EAS attestation of the daily
// window ships when the dedicated attester wallet exists (founder action);
// nothing here needs to change for that, it only consumes these tallies.
const COHERENCE_SUBJECT = "gblin.digital (GBLIN Protocol, ERC-8004 #59286)";
const COHERENCE_PROMISES = [
  {
    id: "P1",
    file: "https://gblin.digital/promises/P1-attestation-uptime.json",
    promiseId: "0x39657f8b917beefaf60bc239889bd07ec2ed1c34d5bd9cd8230aa053081858a5",
    // kept when BOTH: paid endpoint answers 402 with a non-empty challenge body,
    // and the free sample answers 200 with sample:true.
    check: async () => {
      const paid = await fetch("https://gblin.digital/api/x402/attestation", {
        headers: { accept: "application/json" },
      });
      const paidBody = await paid.text();
      const paidOk = paid.status === 402 && paidBody.length > 2;
      const sample = await fetch("https://gblin.digital/api/x402/attestation-sample", {
        headers: { accept: "application/json" },
      });
      let sampleOk = false;
      if (sample.status === 200) {
        try { sampleOk = (await sample.json()).sample === true; } catch { sampleOk = false; }
      }
      return paidOk && sampleOk;
    },
  },
  {
    id: "P2",
    file: "https://gblin.digital/promises/P2-honest-counters.json",
    promiseId: "0xfd49bca1060869f41d97b877878e8886e028632d7d9c0be60110c174d31b3650",
    // kept when the public counters answer with numbers AND the disclosure file
    // (which carries our own wallet list) is still served. Silently removing
    // the disclosure is the violation this promise exists to catch.
    check: async () => {
      const stats = await fetch("https://gblin.digital/api/agent-stats", {
        headers: { accept: "application/json" },
      });
      let statsOk = false;
      if (stats.status === 200) {
        try {
          const j = await stats.json();
          statsOk = Number.isFinite(Number(j.total_paid_calls)) || Number.isFinite(Number(j.totalCalls));
        } catch { statsOk = false; }
      }
      const disc = await fetch("https://gblin.digital/promises/P2-honest-counters.json");
      let discOk = false;
      if (disc.status === 200) {
        const t = await disc.text();
        discOk = t.includes("our_wallets") && t.includes("0xd15ca75ff73aa5173c28bd82fff302204cf6c6d9");
      }
      return statsOk && discOk;
    },
  },
];

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

// One KV doc per promise per day: { obs, kept, last, lastStatus }.
async function coherenceObserve(env) {
  if (!env.COHERENCE) return; // binding absent (local dev): observation is a no-op
  const day = utcDay();
  for (const p of COHERENCE_PROMISES) {
    // A promise is IN FORCE only once its file is public: pre-registration is
    // the commitment. Until then we do not observe — recording violations for
    // an unpublished promise would be theatre, not measurement.
    try {
      const f = await fetch(p.file, { headers: { accept: "application/json" } });
      if (f.status !== 200) continue;
    } catch { continue; }
    let kept = false;
    try { kept = await p.check(); } catch { kept = false; }
    const key = `day:${p.id}:${day}`;
    let doc = { obs: 0, kept: 0, last: null, lastStatus: null };
    try { doc = JSON.parse((await env.COHERENCE.get(key)) || "null") || doc; } catch { /* fresh */ }
    doc.obs += 1;
    if (kept) doc.kept += 1;
    doc.last = new Date().toISOString();
    doc.lastStatus = kept ? "kept" : "violated";
    await env.COHERENCE.put(key, JSON.stringify(doc), { expirationTtl: 60 * 86400 });
    // First-ever observation timestamp, written once.
    const since = await env.COHERENCE.get("since");
    if (!since) await env.COHERENCE.put("since", doc.last);
  }
}

// ── On-chain attestation (EAS on Base) — the automaton's daily seal ─────────
//
// Once a day, for each promise, write one EAS attestation of the finished-day
// window (observations, kept, violations) signed by the dedicated observer
// wallet. Fully isolated and fail-safe: no ATTESTER_KEY → skipped silently, so
// the free report keeps working and nothing else in the Worker is touched. A
// wrong on-chain write is permanent, so this only runs on a CLOSED day (never
// the current one) and never re-attests a day already sealed (idempotent via KV).
const EAS_CONTRACT = "0x4200000000000000000000000000000000000021"; // EAS on Base
const SCHEMA_UID =
  "0x9f433a96467ab75530009970e5aa938ec94d8a49f08f66e7381822d557b448ef";

const EAS_ATTEST_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
];

const SCHEMA_FIELDS = [
  { name: "subject", type: "address" },
  { name: "promiseId", type: "bytes32" },
  { name: "windowStart", type: "uint64" },
  { name: "windowEnd", type: "uint64" },
  { name: "observations", type: "uint32" },
  { name: "keptBps", type: "uint16" },
  { name: "violations", type: "uint16" },
  { name: "evidenceURI", type: "string" },
];

// GBLIN's own on-chain identity, the subject of these self-attestations.
const SELF_SUBJECT = "0x9ffa542e369c53af62380296092ec669f329a9ee";

async function coherenceAttestClosedDay(env) {
  if (!env.COHERENCE || !env.ATTESTER_KEY) return false; // not armed yet — by design
  let viem, accounts, chains;
  try {
    viem = await import("viem");
    accounts = await import("viem/accounts");
    chains = await import("viem/chains");
  } catch {
    return false; // library unavailable: never block the heartbeat
  }

  const today = utcDay();
  const key = env.ATTESTER_KEY.startsWith("0x") ? env.ATTESTER_KEY : "0x" + env.ATTESTER_KEY;
  const account = accounts.privateKeyToAccount(key);
  // Base's own RPC rejects Cloudflare egress IPs; rotate over the same fallback
  // list the read path uses (working endpoints first, mainnet.base.org last) so
  // the cron's writes actually land instead of failing silently.
  const rpcs = env.GBLIN_RPC_URL ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS] : FALLBACK_RPCS;
  const transport = viem.fallback(rpcs.map((u) => viem.http(u)));
  const pub = viem.createPublicClient({ chain: chains.base, transport });
  const client = viem.createWalletClient({ account, chain: chains.base, transport });
  // Explicit nonce: multiple seals in one run must not collide on a stale nonce.
  let nonce = await pub.getTransactionCount({ address: account.address });

  let complete = true; // false if any closed day is left unsealed this run
  let sealedThisRun = 0;
  const MAX_SEALS_PER_RUN = 12; // safety cap for CPU / subrequest limits

  for (const p of COHERENCE_PROMISES) {
    // Seal EVERY closed day (day < today) that has observations and isn't sealed
    // yet — oldest first. This catches up days missed while sealing was down, so
    // a failed run genuinely retries later instead of losing the day forever.
    const prefix = `day:${p.id}:`;
    const list = await env.COHERENCE.list({ prefix });
    const days = list.keys
      .map((k) => k.name.slice(prefix.length))
      .filter((day) => day < today) // YYYY-MM-DD compares lexicographically
      .sort();
    for (const day of days) {
      if (sealedThisRun >= MAX_SEALS_PER_RUN) return false; // more days remain — retry next tick
      const sealKey = `sealed:${p.id}:${day}`;
      if (await env.COHERENCE.get(sealKey)) continue; // already attested
      const dayDoc = await env.COHERENCE.get(`${prefix}${day}`);
      if (!dayDoc) continue; // no observations that day: nothing to seal
      let d;
      try { d = JSON.parse(dayDoc); } catch { continue; }
      if (!d.obs) continue;

      const keptBps = Math.round((d.kept / d.obs) * 10000);
      const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
      const end = start + 86399;
      const encoded = viem.encodeAbiParameters(SCHEMA_FIELDS, [
        SELF_SUBJECT,
        p.promiseId,
        BigInt(start),
        BigInt(end),
        d.obs,
        keptBps,
        d.obs - d.kept,
        p.file,
      ]);

      try {
        const hash = await client.writeContract({
          address: EAS_CONTRACT,
          abi: EAS_ATTEST_ABI,
          functionName: "attest",
          nonce,
          args: [
            {
              schema: SCHEMA_UID,
              data: {
                recipient: SELF_SUBJECT,
                expirationTime: 0n,
                revocable: true,
                refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
                data: encoded,
                value: 0n,
              },
            },
          ],
        });
        nonce += 1; // advance only after a successful submission
        sealedThisRun += 1;
        // Mark sealed only after a tx hash exists, so a failure retries next run.
        await env.COHERENCE.put(sealKey, hash, { expirationTtl: 120 * 86400 });
        await env.COHERENCE.put(`txlast:${p.id}`, JSON.stringify({ day, hash }));
      } catch {
        // RPC/gas hiccup: leave this day unsealed AND mark the run incomplete, so
        // the outer daily gate keeps retrying every 10 min instead of waiting a
        // full day (per-day idempotency still prevents any double-seal).
        complete = false;
      }
    }
  }
  return complete;
}

// One-shot "genesis" seal: attest the real cumulative window observed so far
// (from first observation to now), honestly labelled as a partial genesis
// window — never a full closed day. Used to write the very first on-chain proof
// on demand and to test the signing path end-to-end while a human is watching.
async function coherenceAttestGenesis(env) {
  if (!env.COHERENCE) return { ok: false, error: "no KV binding" };
  if (!env.ATTESTER_KEY) return { ok: false, error: "no ATTESTER_KEY set" };
  let viem, accounts, chains;
  try {
    viem = await import("viem");
    accounts = await import("viem/accounts");
    chains = await import("viem/chains");
  } catch (e) {
    return { ok: false, error: "viem import failed: " + (e.message || e) };
  }

  let account;
  try {
    const key = env.ATTESTER_KEY.startsWith("0x") ? env.ATTESTER_KEY : "0x" + env.ATTESTER_KEY;
    account = accounts.privateKeyToAccount(key);
  } catch (e) {
    return { ok: false, error: "bad ATTESTER_KEY: " + (e.message || e) };
  }
  const rpcs = env.GBLIN_RPC_URL ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS] : FALLBACK_RPCS;
  const transport = viem.fallback(rpcs.map((u) => viem.http(u)));
  const pub = viem.createPublicClient({ chain: chains.base, transport });
  const client = viem.createWalletClient({ account, chain: chains.base, transport });

  const sinceIso = await env.COHERENCE.get("since");
  const start = sinceIso ? Math.floor(Date.parse(sinceIso) / 1000) : Math.floor(Date.now() / 1000);
  const end = Math.floor(Date.now() / 1000);
  const results = [];
  // Manage the nonce ourselves: two writes from one wallet in the same request
  // would otherwise collide on a stale nonce (the cause of the P2 failure).
  let nonce = await pub.getTransactionCount({ address: account.address });

  for (const p of COHERENCE_PROMISES) {
    // Idempotent per promise: skip one already sealed as genesis.
    let existing = null;
    try { existing = JSON.parse((await env.COHERENCE.get(`txlast:${p.id}`)) || "null"); } catch { /* none */ }
    if (existing && existing.day === "genesis") { results.push({ id: p.id, skipped: "already sealed" }); continue; }

    let obs = 0, kept = 0;
    const list = await env.COHERENCE.list({ prefix: `day:${p.id}:` });
    for (const k of list.keys) {
      try { const d = JSON.parse((await env.COHERENCE.get(k.name)) || "{}"); obs += d.obs || 0; kept += d.kept || 0; } catch { /* skip */ }
    }
    if (!obs) { results.push({ id: p.id, skipped: "no observations yet" }); continue; }

    const keptBps = Math.round((kept / obs) * 10000);
    const encoded = viem.encodeAbiParameters(SCHEMA_FIELDS, [
      SELF_SUBJECT, p.promiseId, BigInt(start), BigInt(end), obs, keptBps, obs - kept,
      p.file + "#genesis",
    ]);
    try {
      const hash = await client.writeContract({
        address: EAS_CONTRACT,
        abi: EAS_ATTEST_ABI,
        functionName: "attest",
        nonce,
        args: [{
          schema: SCHEMA_UID,
          data: {
            recipient: SELF_SUBJECT, expirationTime: 0n, revocable: true,
            refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
            data: encoded, value: 0n,
          },
        }],
      });
      nonce += 1; // advance only after a successful submission
      await env.COHERENCE.put(`txlast:${p.id}`, JSON.stringify({ day: "genesis", hash }));
      results.push({ id: p.id, hash, observations: obs, keptBps });
    } catch (e) {
      results.push({ id: p.id, error: (e.shortMessage || e.message || String(e)).slice(0, 200) });
    }
  }
  return { ok: results.some((r) => r.hash), results };
}

async function coherenceReport(env) {
  const promises = [];
  const since = env.COHERENCE ? await env.COHERENCE.get("since") : null;
  for (const p of COHERENCE_PROMISES) {
    let obs = 0, kept = 0, last = null, lastStatus = null;
    if (env.COHERENCE) {
      const list = await env.COHERENCE.list({ prefix: `day:${p.id}:` });
      for (const k of list.keys) {
        try {
          const d = JSON.parse((await env.COHERENCE.get(k.name)) || "{}");
          obs += d.obs || 0;
          kept += d.kept || 0;
          if (!last || (d.last && d.last > last)) { last = d.last; lastStatus = d.lastStatus; }
        } catch { /* skip corrupt day */ }
      }
    }
    // Most recent on-chain seal for this promise, if any.
    let lastSeal = null;
    if (env.COHERENCE) {
      try { lastSeal = JSON.parse((await env.COHERENCE.get(`txlast:${p.id}`)) || "null"); } catch { /* none */ }
    }
    promises.push({
      id: p.id,
      promiseId: p.promiseId,
      file: p.file,
      observations: obs,
      kept,
      violations: obs - kept,
      kept_bps: obs > 0 ? Math.round((kept / obs) * 10000) : null,
      last_observation: last,
      last_status: lastStatus,
      last_onchain_seal: lastSeal
        ? { day: lastSeal.day, tx: lastSeal.hash, basescan: `https://basescan.org/tx/${lastSeal.hash}` }
        : null,
    });
  }
  const anchored = promises.some((p) => p.last_onchain_seal);
  return {
    subject: COHERENCE_SUBJECT,
    promises,
    observing_since: since,
    onchain: {
      anchored,
      schema_uid: SCHEMA_UID,
      eas: EAS_CONTRACT,
      schema: "https://base.easscan.org/schema/view/" + SCHEMA_UID,
      note: anchored
        ? "Each closed day is sealed as an EAS attestation on Base by the observer wallet."
        : "On-chain sealing is armed once the observer wallet key is configured; the off-chain report above is live now.",
    },
    method:
      "Promises are pre-registered, hash-pinned public files (promiseId = keccak256 of the file). An automaton probes the declared checks every 10 minutes from Cloudflare's edge and tallies kept/violated per day, then seals each closed day as an EAS attestation on Base. Reading is free forever; the paid service is being observed.",
  };
}

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
    case "get_coherence_report":
      return await coherenceReport(env);

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
            structuredContent: out, // matches the tool's declared outputSchema
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

    // Public coherence report for humans, dashboards and crawlers. Free forever.
    if (url.pathname === "/coherence" && request.method === "GET") {
      return json(await coherenceReport(env));
    }

    // One-shot genesis seal, token-gated. Writes the first on-chain proof on
    // demand (also an end-to-end test of the signing path). Idempotent: refuses
    // once genesis is done. No token configured → 404 (feature stays invisible).
    if (url.pathname === "/coherence/genesis" && request.method === "POST") {
      if (!env.SEAL_TOKEN) return json({ error: "not found" }, 404);
      if (url.searchParams.get("token") !== env.SEAL_TOKEN) return json({ error: "forbidden" }, 403);
      return json(await coherenceAttestGenesis(env));
    }

    // Manual catch-up seal, token-gated. Forces a closed-day seal run on demand —
    // e.g. to recover a day whose tx failed transiently — without waiting for the
    // daily gate. Idempotent (per-day sealKey), so it is safe to call repeatedly.
    if (url.pathname === "/coherence/seal" && request.method === "POST") {
      if (!env.SEAL_TOKEN) return json({ error: "not found" }, 404);
      if (url.searchParams.get("token") !== env.SEAL_TOKEN) return json({ error: "forbidden" }, 403);
      const complete = await coherenceAttestClosedDay(env);
      if (complete) await env.COHERENCE.put("attest:lastRun", utcDay());
      return json({ ok: true, complete, ...(await coherenceReport(env)) });
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

  // Cron: the automaton's heartbeat. Every 10-minute tick observes every
  // promise once; on the first tick of a new UTC day it also seals the day
  // that just closed as an on-chain attestation (no-op until the key is set).
  async scheduled(_event, env, ctx) {
    const work = (async () => {
      await coherenceObserve(env);
      if (env.COHERENCE) {
        const today = utcDay();
        const marker = await env.COHERENCE.get("attest:lastRun");
        if (marker !== today) {
          // Advance the marker ONLY when every closed day is sealed. A partial
          // failure (one promise's tx fails) leaves the marker behind, so the very
          // next 10-min tick retries the missing seal instead of waiting a day.
          const done = await coherenceAttestClosedDay(env);
          if (done) await env.COHERENCE.put("attest:lastRun", today);
        }
      }
    })();
    ctx.waitUntil(work);
  },
};
