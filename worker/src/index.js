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
 *
 * 14/08/2026: aggiunto l'OSSERVATORIO DEL CATALOGO (src/catalog.mjs) — sonde a
 * rotazione sulle top-200 risorse del discovery x402, vista free su /catalog,
 * feed completo via token per la webapp (che lo vende via x402). Il giro di
 * sonde SALTA il tick del sigillo giornaliero per stare nei 50 subrequest.
 *     cached upstream fetches (I/O, ~0 CPU) or tiny hex parsing.
 *   - Stateless: no sessions, no SSE stream, one JSON response per POST.
 *     Every JSON-RPC exchange is self-contained (spec-permitted mode).
 *   - Zero dependencies: the JSON-RPC handling is ~100 lines, hand-rolled,
 *     so there is no bundler and no supply chain.
 *   - Kill switch: env.MCP_DISABLED = "true" → 503 for everything.
 *   - Best-effort per-IP rate limit (per isolate): 60 req/min.
 */

import { catalogTick, catalogReport, catalogFull, observatoryPage, observatoryJson, observatoryBadge } from "./catalog.mjs";
// 18/08/2026: WITNESS (src/witness.mjs) — cofirma i checkpoint di log di
// trasparenza terzi (C2SP tlog-cosignature v1). Primo log: markovianprotocol.com,
// su loro invito. Zero costo: 1 lettura + 1 firma per tick; niente chain.
// Secret WITNESS_KEY assente → disattivato in silenzio (fail-safe).
import { witnessTick, witnessIndex, witnessLatestNote, witnessAddCheckpoint, witnessHistory, WITNESSED_LOGS } from "./witness.mjs";
import { sealAction, getReceipt, rlogStatus, demoAllowed, treeRoot, signedCheckpoint, proofFor, RLOG_ORIGIN } from "./rlog.mjs";

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
      "When deciding whether to deploy capital, take risk, or STAND DOWN in a volatile market, call this first — the 'Risk Gate' pattern a third-party ERC-8004 agent runs in production daily (gblin.digital/risk-gate). Returns the current BTC/ETH risk regime (calm | elevated | crash) read live from GBLIN's on-chain Crash Shield on Base. Free, unsigned — for a signed, attachable proof buy the x402 attestation (see how_to_buy_live_attestation).",
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
    name: "seal_action_demo",
    description:
      "AI ACTION RECEIPTS (demo, 5/day/IP): seal the HASHES of an AI action into GBLIN's public append-only transparency log and get back a portable receipt — Ed25519 signature + RFC 6962 inclusion proof + C2SP signed checkpoint, root anchored daily on Base via EAS. Send hashes only, never content. Proves existence and time, independently witnessed — not a compliance certificate. Unlimited seals: $0.01 via x402 (see how_to_seal_paid).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "What the AI did, short label (<=128 chars)" },
        input_hash: { type: "string", description: "sha256 hex (64 chars) of the input/prompt" },
        output_hash: { type: "string", description: "sha256 hex of the output (optional)" },
        agent_id: { type: "string", description: "Your agent identifier (optional, <=128)" },
        tool: { type: "string", description: "Tool/model used (optional, <=128)" },
        meta: { type: "string", description: "Extra JSON, <=512 chars (optional)" },
      },
      required: ["action", "input_hash"],
    },
    annotations: { title: "Seal an AI action (demo receipt)", readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: {
      type: "object",
      properties: {
        format: { type: "string" }, payload: { type: "object" },
        leaf: { type: "string" }, index: { type: "integer" }, tree_size: { type: "integer" },
        root: { type: "string" }, signature: { type: "string" }, verifier_key: { type: "string" },
        inclusion_proof: { type: "array", items: { type: "string" } }, checkpoint: { type: "string" },
      },
      required: ["format", "payload", "index", "inclusion_proof", "checkpoint"],
    },
  },
  {
    name: "get_receipt",
    description: "Fetch a sealed AI-action receipt by index from GBLIN's receipts transparency log, with a fresh inclusion proof and signed checkpoint. Free forever.",
    inputSchema: { type: "object", properties: { index: { type: "integer", description: "Receipt index in the log" } }, required: ["index"] },
    annotations: { title: "Get a receipt by index", ...RO },
    outputSchema: { type: "object", properties: { payload: { type: "object" }, inclusion_proof: { type: "array", items: { type: "string" } }, checkpoint: { type: "string" } }, required: ["payload", "checkpoint"] },
  },
  {
    name: "how_to_seal_paid",
    description: "How to buy unlimited AI-action seals ($0.01 USDC via x402 on Base) and verify receipts offline with zero dependencies.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "How to seal (paid, unlimited)", ...RO },
    outputSchema: { type: "object", properties: { paid_endpoint: { type: "string" }, price: { type: "string" }, fields: { type: "object" } }, required: ["paid_endpoint", "price"] },
  },
  {
    name: "get_coherence_report",
    description:
      "Coherence Proof (free, forever): does this subject DO what it publicly promised? v0 observes GBLIN itself — pre-registered, hash-pinned promises (uptime of the paid attestation endpoint, honesty of public counters) probed every 10 minutes, with kept/violated tallies; each closed UTC day is sealed on Base as an EAS attestation (schema 0x9f433a96…, verifiable on base.easscan.org). The certifier submits itself to its own instrument first. Reading is free by design; being observed is the paid service.",
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


// ── Ancora giornaliera del root del receipts-log su Base (EAS) ──────────────
// Riusa schema/wallet della Coerenza: promiseId = keccak256("gblin-receipts-log"),
// observations = tree size, evidenceURI = "root:<b64>@<size>". Idempotente per
// giorno e solo se il log è cresciuto. Fail-safe: senza ATTESTER_KEY non fa nulla.
async function rlogAnchorDaily(env) {
  if (!env.COHERENCE || !env.ATTESTER_KEY || !env.RLOG_KEY) return true;
  const today = utcDay();
  if (await env.COHERENCE.get(`rlog:anchored:${today}`)) return true;
  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  if (N === 0) return true;
  const last = Number((await env.COHERENCE.get("rlog:anchoredSize")) || 0);
  if (N === last) { await env.COHERENCE.put(`rlog:anchored:${today}`, "unchanged", { expirationTtl: 120 * 86400 }); return true; }
  let viem, accounts, chains;
  try { viem = await import("viem"); accounts = await import("viem/accounts"); chains = await import("viem/chains"); } catch { return false; }
  const root = await treeRoot(env, N);
  const rootB64 = btoa(String.fromCharCode(...root));
  const key = env.ATTESTER_KEY.startsWith("0x") ? env.ATTESTER_KEY : "0x" + env.ATTESTER_KEY;
  const account = accounts.privateKeyToAccount(key);
  const rpcs = env.GBLIN_RPC_URL ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS] : FALLBACK_RPCS;
  const transport = viem.fallback(rpcs.map((u) => viem.http(u)));
  const pub = viem.createPublicClient({ chain: chains.base, transport });
  const client = viem.createWalletClient({ account, chain: chains.base, transport });
  const start = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000);
  const promiseId = viem.keccak256(viem.toBytes("gblin-receipts-log"));
  const encoded = viem.encodeAbiParameters(SCHEMA_FIELDS, [
    SELF_SUBJECT, promiseId, BigInt(start), BigInt(start + 86399), N, 10000, 0,
    `root:${rootB64}@${N} https://gblin-mcp.gblin-mcp-worker.workers.dev/log/checkpoint`,
  ]);
  try {
    const nonce = await pub.getTransactionCount({ address: account.address });
    const hash = await client.writeContract({
      address: EAS_CONTRACT, abi: EAS_ATTEST_ABI, functionName: "attest", nonce,
      args: [{ schema: SCHEMA_UID, data: { recipient: SELF_SUBJECT, expirationTime: 0n, revocable: true,
        refUID: "0x0000000000000000000000000000000000000000000000000000000000000000", data: encoded, value: 0n } }],
    });
    await env.COHERENCE.put(`rlog:anchored:${today}`, hash, { expirationTtl: 120 * 86400 });
    await env.COHERENCE.put("rlog:anchoredSize", String(N));
    await env.COHERENCE.put("rlog:anchorLast", JSON.stringify({ day: today, size: N, root: rootB64, hash }));
    return true;
  } catch { return false; }
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

async function callTool(name, env, args = {}) {
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

    case "seal_action_demo": {
      const r = await sealAction(env, args, { demo: true });
      if (r.status !== 200) throw new Error(r.error);
      return r.receipt;
    }
    case "get_receipt": {
      const idx = Number(args.index);
      const r = await getReceipt(env, idx);
      if (r.status !== 200) throw new Error(r.error);
      return r.receipt;
    }
    case "how_to_seal_paid":
      return {
        what: "AI Action Receipts: a portable, signed, independently-witnessed receipt for any AI action. You send HASHES only (never content); you get back signature + RFC 6962 inclusion proof + C2SP checkpoint; the tree root is anchored daily on Base (EAS). Evidence of existence and time — NOT a compliance certificate.",
        paid_endpoint: `${SITE}/api/x402/seal`,
        price: "0.01 USDC on Base via x402 (unlimited)",
        demo: "MCP tool seal_action_demo or POST https://gblin-mcp.gblin-mcp-worker.workers.dev/v1/seal-demo (5/day/IP, receipts marked demo:true)",
        fields: { action: "string <=128 (required)", input_hash: "sha256 hex of your input (required)", output_hash: "sha256 hex (optional)", agent_id: "string <=128 (optional)", tool: "string <=128 (optional)", meta: "JSON <=512 chars (optional)" },
        read_free: "GET /v1/receipt/:index · /log/checkpoint · /log/proof/:index · human page /receipt/:index",
        verify_offline: "verify-receipt.mjs in github.com/gblinproject/gblin-treasury-risk-regime — zero dependencies",
      };

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
            "GBLIN Protocol on Base: free read-only tools — live market risk regime (calm|elevated|crash), the x402 uptime observatory (only ~1/3 of the catalog answers; our own endpoints sit in the same table), and a Coherence Proof sealed daily on Base via EAS. The signed risk attestation is a paid x402 endpoint (see how_to_buy_live_attestation). Everything is checkable on-chain; reading is free. Stateless server: no session required.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = params && params.name;
        try {
          const out = await callTool(name, env, (params && params.arguments) || {});
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
        witness: "/witness (we cosign third-party transparency-log checkpoints; C2SP tlog-cosignature v1)",
        receipts: "/log (AI Action Receipts: seal what your agent did — $0.01 via x402 at gblin.digital/api/x402/seal, demo via MCP tool seal_action_demo)",
      });
    }

    // Public coherence report for humans, dashboards and crawlers. Free forever.
    if (url.pathname === "/coherence" && request.method === "GET") {
      return json(await coherenceReport(env));
    }

    // Regime GRATUITO via REST (stessa matematica del tool MCP, cache 60s):
    // pensato per i provider dei plugin che girano a OGNI loop degli agenti.
    // Free tier: mai conteggiato nei contatori "paid" (promessa P2).
    if (url.pathname === "/regime" && request.method === "GET") {
      const regime = await cachedRegime(env);
      return json({
        ...regime,
        note: "Free unsigned reading, 60s cache. For a signed, offline-verifiable proof: gblin.digital/api/x402/attestation ($0.003). Risk Gate pattern: gblin.digital/risk-gate",
      });
    }

    // OSSERVATORIO PUBBLICO — artefatto citabile: pagina, JSON stabile, badge.
    if (url.pathname === "/observatory" && request.method === "GET") {
      return new Response(await observatoryPage(env), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600", ...CORS },
      });
    }
    if (url.pathname === "/observatory.json" && request.method === "GET") {
      return json(await observatoryJson(env), 200, { "cache-control": "public, max-age=600" });
    }
    if (url.pathname === "/observatory/badge.svg" && request.method === "GET") {
      return new Response(await observatoryBadge(env, url.searchParams.get("host")), {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=600", ...CORS },
      });
    }

    // AI ACTION RECEIPTS — sigilli firmati+testimoniati per le azioni delle IA.
    // Pagato: via webapp /api/x402/seal (x402 $0.01, inoltra qui col token).
    // Demo: 5/giorno/IP, marcati demo:true. Lettura e verifica: gratis per sempre.
    if (url.pathname === "/internal/seal" && request.method === "POST") {
      const tok = url.searchParams.get("token") || "";
      if (!env.CATALOG_TOKEN || tok !== env.CATALOG_TOKEN) return json({ error: "unauthorized" }, 401);
      let body; try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const r = await sealAction(env, body, { demo: false });
      return json(r.status === 200 ? r.receipt : { error: r.error }, r.status, { "cache-control": "no-store" });
    }
    if (url.pathname === "/v1/seal-demo" && request.method === "POST") {
      if (!(await demoAllowed(env, ip))) {
        return json({ error: "demo limit reached (5/day/IP). For unlimited seals pay $0.01 via x402: POST https://gblin.digital/api/x402/seal" }, 429);
      }
      let body; try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const r = await sealAction(env, body, { demo: true });
      return json(r.status === 200 ? r.receipt : { error: r.error }, r.status, { "cache-control": "no-store" });
    }
    if (url.pathname.startsWith("/v1/receipt/") && request.method === "GET") {
      const idx = Number(url.pathname.slice("/v1/receipt/".length));
      if (!Number.isInteger(idx) || idx < 0) return json({ error: "bad index" }, 400);
      const r = await getReceipt(env, idx);
      return json(r.status === 200 ? r.receipt : { error: r.error }, r.status, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname === "/log/checkpoint" && request.method === "GET") {
      const st = await rlogStatus(env);
      if (!st.checkpoint) return json({ error: "log empty or not armed", origin: st.origin, verifier_key: st.verifier_key }, 404);
      return new Response(st.checkpoint, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CORS } });
    }
    if (url.pathname === "/log" && request.method === "GET") {
      const st = await rlogStatus(env);
      return json({ ...st,
        what: "GBLIN AI Action Receipts — append-only RFC 6962 transparency log of sealed AI actions (hashes only, never content). A seal proves existence and time, independently witnessed; it is NOT a compliance certificate and NOT an endorsement.",
        seal_paid: "POST https://gblin.digital/api/x402/seal ($0.01 USDC via x402)",
        seal_demo: "POST /v1/seal-demo (5/day/IP, marked demo:true)",
        read: "GET /v1/receipt/:index (free forever) · GET /log/proof/:index · GET /log/checkpoint",
        explorer: "GET /receipt/:index (human page)",
        anchor: "tree root anchored daily on Base via EAS (schema " + "0x9f433a96..., promiseId keccak256('gblin-receipts-log'))",
        offline_verifier: "verify-receipt.mjs in github.com/gblinproject/gblin-treasury-risk-regime (zero deps)",
      }, 200, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname.startsWith("/log/proof/") && request.method === "GET") {
      const idx = Number(url.pathname.slice("/log/proof/".length));
      const N = Number((await env.COHERENCE?.get("rlog:size")) || 0);
      if (!Number.isInteger(idx) || idx < 0 || idx >= N) return json({ error: "bad index" }, 400);
      const root = await treeRoot(env, N);
      return json({ origin: RLOG_ORIGIN, index: idx, tree_size: N, root: btoa(String.fromCharCode(...root)), proof: await proofFor(env, idx, N), checkpoint: await signedCheckpoint(env, N, root) }, 200, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname.startsWith("/receipt/") && request.method === "GET") {
      const idx = Number(url.pathname.slice("/receipt/".length));
      const r = Number.isInteger(idx) && idx >= 0 ? await getReceipt(env, idx) : { status: 400, error: "bad index" };
      const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const body = r.status === 200
        ? `<h1>Receipt #${idx}</h1><p class="k">${esc(r.receipt.payload.ts)} · action <b>${esc(r.receipt.payload.action)}</b>${r.receipt.payload.demo ? " · <b>DEMO</b>" : ""}</p>
           <table>${["agent_id","tool","input_hash","output_hash"].map((k)=>`<tr><td class="k">${k}</td><td><code>${esc(r.receipt.payload[k] ?? "—")}</code></td></tr>`).join("")}
           <tr><td class="k">leaf</td><td><code>${esc(r.receipt.leaf)}</code></td></tr>
           <tr><td class="k">tree</td><td>index ${idx} of ${r.receipt.tree_size} · root <code>${esc(r.receipt.root)}</code></td></tr></table>
           <div class="box"><b>Checkpoint (C2SP signed note)</b><pre>${esc(r.receipt.checkpoint)}</pre></div>
           <p class="k">Verify offline with <a href="https://github.com/gblinproject/gblin-treasury-risk-regime">verify-receipt.mjs</a> — this page is a convenience, not the proof. A seal proves existence and time; it is not a compliance certificate.</p>
           <p class="k">JSON: <a href="/v1/receipt/${idx}">/v1/receipt/${idx}</a> · <a href="/log">about this log</a></p>`
        : `<h1>Receipt not found</h1><p class="k">${esc(r.error)}</p>`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GBLIN Receipt #${idx}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}code,pre{font-family:ui-monospace,monospace;font-size:.82em;word-break:break-all;white-space:pre-wrap}table{border-collapse:collapse;width:100%}td{padding:.3rem .5rem;border-bottom:1px solid #e5e5e5;vertical-align:top}.k{color:#555}.box{background:#f6f6f6;border-radius:8px;padding:.9rem 1.1rem;margin:1rem 0}
@media(prefers-color-scheme:dark){body{background:#111;color:#e6e6e6}td{border-color:#2c2c2c}.box{background:#1c1c1c}}</style></head><body>${body}</body></html>`;
      return new Response(html, { status: r.status === 200 ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", ...CORS } });
    }

    // WITNESS — indice pubblico (chiave di verifica, ultimo checkpoint cofirmato per log)
    // e la nota cofirmata in chiaro, nel formato che qualsiasi verificatore C2SP legge.
    if (url.pathname === "/witness/add-checkpoint" && request.method === "POST") {
      const bodyText = await request.text();
      if (bodyText.length > 65536) return new Response("too large\n", { status: 413 });
      const r = await witnessAddCheckpoint(env, bodyText);
      return new Response(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/witness" && request.method === "GET") {
      return json(await witnessIndex(env), 200, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname.startsWith("/witness/") && request.method === "GET") {
      const parts = url.pathname.slice("/witness/".length).replace(/\/$/, "").split("/");
      const id = parts[0];
      if (!WITNESSED_LOGS.some((l) => l.id === id)) return json({ error: "unknown log" }, 404);
      if (parts[1] === "history") {
        const h = await witnessHistory(env, id);
        return json({ log: id, count: h.length, entries: h.map((e) => ({ size: e.size, root: e.root, cosigned_at: e.ts, cosigned_at_iso: new Date(e.ts * 1000).toISOString(), via: e.via, url: `/witness/${id}/${e.size}` })) }, 200, { "cache-control": "public, max-age=60" });
      }
      if (parts[1] && /^\d+$/.test(parts[1])) {
        const h = await witnessHistory(env, id);
        const e = [...h].reverse().find((x) => String(x.size) === parts[1]);
        if (!e) return json({ error: "no cosigned note held for that size" }, 404);
        return new Response(e.note, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", ...CORS } });
      }
      const note = await witnessLatestNote(env, id);
      if (!note) return json({ error: "no cosigned checkpoint yet" }, 404);
      return new Response(note, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60", ...CORS } });
    }

    // Osservatorio del catalogo x402 — vista FREE (aggregati + nostre risorse).
    if (url.pathname === "/catalog" && request.method === "GET") {
      return json(await catalogReport(env));
    }
    // Feed completo per la webapp (che lo firma e lo vende via x402).
    if (url.pathname === "/catalog/full" && request.method === "GET") {
      const full = await catalogFull(env, url.searchParams.get("token"));
      if (!full) return json({ error: "forbidden" }, 403);
      return json(full);
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
      // Witness first: 1-2 subrequest, mai in conflitto col budget del sigillo.
      await witnessTick(env).catch((e) => console.error("witness:", e.message));
      await coherenceObserve(env);
      if (env.COHERENCE) {
        const today = utcDay();
        const marker = await env.COHERENCE.get("attest:lastRun");
        if (marker !== today) {
          // Advance the marker ONLY when every closed day is sealed. A partial
          // failure (one promise's tx fails) leaves the marker behind, so the very
          // next 10-min tick retries the missing seal instead of waiting a day.
          const done = await coherenceAttestClosedDay(env);
          const anchored = await rlogAnchorDaily(env);
          if (done && anchored) await env.COHERENCE.put("attest:lastRun", today);
        } else {
          // Giro di sonde del catalogo SOLO nei tick senza sigillo: il budget
          // free è 50 subrequest/invocazione e il sigillo ne consuma parecchi.
          await catalogTick(env).catch((e) => console.error("catalog:", e.message));
        }
      }
    })();
    ctx.waitUntil(work);
  },
};
