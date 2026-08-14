// catalog.mjs — OSSERVATORIO DEL CATALOGO x402 (v1: osservazione + feed).
//
// Perché esiste: il catalogo discovery conta ~15.000 risorse e la domanda pagante
// più concreta dell'ecosistema è "chi è VIVO?" — misurata sui payer che bruciano
// $2-50/giorno sondando tutto a forza bruta. Qui la risposta viene prodotta una
// volta e servita a tutti: sondiamo le TOP-N risorse a rotazione e pubblichiamo
// stato/latenza/anzianità. Il feed completo è monetizzato dalla webapp (x402);
// qui restano il probing e una vista gratuita limitata.
//
// REGOLE PRE-REGISTRATE (non cambiarle senza dichiararlo):
//  - Selezione: le TRACK_N risorse più recenti per lastUpdated nel discovery CDP
//    (+ sempre le nostre). Refresh della lista 1 volta al giorno.
//  - "alive" = risponde entro 8s con: 402 e challenge JSON che espone accepts[],
//    oppure 2xx (risorsa free). Qualsiasi altro esito = not-ok (codice registrato).
//    Le sonde NON pagano mai nessuno.
//  - Nessun giudizio, solo fatti misurati: code, ms, lastOkAt, fails consecutivi.
//
// VINCOLI PIANO FREE (verificati): ≤50 subrequest/invocazione → PER_TICK sonde
// per giro, saltando il tick del sigillo giornaliero; ≤1000 scritture KV/giorno
// → UNA scrittura aggregata per tick. CPU: le attese fetch non contano.

const DISCOVERY_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const TRACK_N = 200;
const PER_TICK = 17;
const PROBE_TIMEOUT_MS = 8000;
const LIST_KEY = "cat:list";       // { fetchedAt, urls: [ ... ] }
const STATE_KEY = "cat:state";     // { updatedAt, cursor, entries: { url: {...} } }
const OUR_PREFIX = "https://gblin.digital/";

async function fetchDiscoveryTop(env) {
  // 3 pagine da 100 → ordiniamo per lastUpdated e teniamo le TRACK_N più fresche.
  const all = [];
  for (let offset = 0; offset < 300; offset += 100) {
    try {
      const r = await fetch(`${DISCOVERY_URL}?limit=100&offset=${offset}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) break;
      const j = await r.json();
      const items = j.items || [];
      for (const it of items) {
        if (it?.resource && typeof it.resource === "string") {
          all.push({ url: it.resource, lastUpdated: it.lastUpdated || "" });
        }
      }
      if (items.length < 100) break;
    } catch { break; }
  }
  all.sort((a, b) => (b.lastUpdated > a.lastUpdated ? 1 : -1));
  const urls = [];
  const seen = new Set();
  for (const { url } of all) {
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= TRACK_N) break;
  }
  // le nostre risorse sono SEMPRE osservate (siamo il primo soggetto del nostro strumento)
  for (const u of urls.filter((u) => u.startsWith(OUR_PREFIX))) seen.add(u);
  if (![...seen].some((u) => u.startsWith(OUR_PREFIX))) {
    urls.unshift("https://gblin.digital/api/x402/attestation");
  }
  return urls;
}

async function probeOne(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "gblin-catalog-observer/1" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "follow",
    });
    const ms = Date.now() - t0;
    let ok = false;
    if (r.status === 402) {
      try {
        const j = await r.json();
        ok = Array.isArray(j?.accepts) && j.accepts.length > 0;
      } catch { ok = false; }
    } else if (r.status >= 200 && r.status < 300) {
      ok = true;
    }
    return { code: r.status, ms, ok };
  } catch {
    return { code: 0, ms: Date.now() - t0, ok: false };
  }
}

/** Un giro di sonde (chiamato dal cron, MAI nel tick del sigillo). */
export async function catalogTick(env, nowMs) {
  if (!env.COHERENCE) return;
  const now = nowMs ?? Date.now();

  // lista: refresh 1/giorno (3 subrequest, solo in questo caso)
  let list = null;
  try { list = JSON.parse(await env.COHERENCE.get(LIST_KEY)); } catch { /* prima volta */ }
  if (!list || now - (list.fetchedAt || 0) > 24 * 3600e3) {
    const urls = await fetchDiscoveryTop(env);
    if (urls.length) {
      list = { fetchedAt: now, urls };
      await env.COHERENCE.put(LIST_KEY, JSON.stringify(list));
    }
  }
  if (!list?.urls?.length) return;

  let state = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* prima volta */ }
  if (!state) state = { updatedAt: 0, cursor: 0, entries: {} };

  const batch = [];
  for (let i = 0; i < PER_TICK && i < list.urls.length; i++) {
    batch.push(list.urls[(state.cursor + i) % list.urls.length]);
  }
  state.cursor = (state.cursor + batch.length) % list.urls.length;

  const results = await Promise.all(batch.map((u) => probeOne(u)));
  for (let i = 0; i < batch.length; i++) {
    const u = batch[i], r = results[i];
    const e = state.entries[u] || { firstSeenAt: now, fails: 0 };
    e.code = r.code; e.ms = r.ms; e.ok = r.ok; e.lastProbeAt = now;
    if (r.ok) { e.lastOkAt = now; e.fails = 0; } else { e.fails = (e.fails || 0) + 1; }
    state.entries[u] = e;
  }
  // poti le voci uscite dalla lista (tienile 7 giorni per lo storico breve)
  for (const [u, e] of Object.entries(state.entries)) {
    if (!list.urls.includes(u) && now - (e.lastProbeAt || 0) > 7 * 864e5) delete state.entries[u];
  }
  state.updatedAt = now;
  await env.COHERENCE.put(STATE_KEY, JSON.stringify(state)); // UNA scrittura per tick
}

function summarize(state) {
  const entries = Object.entries(state?.entries || {});
  const probed = entries.filter(([, e]) => e.lastProbeAt);
  const alive = probed.filter(([, e]) => e.ok);
  return {
    tracked: entries.length,
    probed_at_least_once: probed.length,
    alive_now: alive.length,
    alive_pct: probed.length ? Math.round((alive.length / probed.length) * 1000) / 10 : null,
    updated_at: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null,
  };
}

/** Vista GRATUITA: aggregati + le nostre risorse in chiaro (dogfooding pubblico). */
export async function catalogReport(env) {
  let state = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* vuoto */ }
  const ours = {};
  for (const [u, e] of Object.entries(state?.entries || {})) {
    if (u.startsWith(OUR_PREFIX)) ours[u] = { ok: e.ok, code: e.code, ms: e.ms, last_ok: e.lastOkAt ? new Date(e.lastOkAt).toISOString() : null };
  }
  return {
    what: "x402 catalog observatory (v1 beta) — factual liveness of the most recently updated Bazaar listings, probed in rotation. No payments are made by probes; no judgements, only measurements.",
    alive_definition: "answers within 8s with HTTP 402 + parseable accepts[] challenge, or any 2xx",
    summary: summarize(state),
    our_own_listings: ours,
    full_feed: "per-endpoint detail (code, latency, last_ok, consecutive fails) is available as a paid x402 resource — see gblin.digital/api/x402/llms.txt",
    selection_rule: `top ${TRACK_N} listings by lastUpdated on the public CDP discovery catalog, refreshed daily`,
  };
}

/** Feed COMPLETO per la webapp (che lo firma e lo vende via x402). Token condiviso. */
export async function catalogFull(env, token) {
  if (!env.CATALOG_TOKEN || token !== env.CATALOG_TOKEN) return null;
  let state = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* vuoto */ }
  return { summary: summarize(state), entries: state?.entries || {}, updated_at: state?.updatedAt || 0 };
}
