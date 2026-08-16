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

/* ────────────────────────────────────────────────────────────────────────────
 * OSSERVATORIO PUBBLICO (16/08/2026) — il report completo diventa un artefatto
 * citabile: pagina HTML datata + JSON grezzo a URL stabile + badge SVG.
 * Gratis per sempre, stesse regole per tutti — i NOSTRI endpoint compaiono
 * nella stessa tabella e sono giudicati dalle stesse sonde (niente voti su
 * misura per noi: è il punto dell'intero strumento).
 * ──────────────────────────────────────────────────────────────────────────*/

const METHODOLOGY = {
  selection: "top ~200 resources by lastUpdated on the public CDP x402 discovery catalog, refreshed daily; GBLIN's own endpoints are always included and judged by the same rules",
  probe: "plain GET, accept: application/json, 8s timeout, follow redirects; each endpoint is probed in rotation roughly every 2 hours",
  alive: "HTTP 402 with a parseable non-empty accepts[] array, or any 2xx, within the timeout",
  never: "probes never pay anyone, never retry, never judge quality — liveness only",
};

function fullRows(state) {
  return Object.entries(state?.entries || {})
    .filter(([, e]) => e.lastProbeAt)
    .map(([u, e]) => ({
      url: u,
      ours: u.startsWith(OUR_PREFIX),
      alive: !!e.ok,
      http: e.code,
      latency_ms: e.ms,
      last_ok: e.lastOkAt ? new Date(e.lastOkAt).toISOString() : null,
      consecutive_fails: e.fails || 0,
      first_seen: e.firstSeenAt ? new Date(e.firstSeenAt).toISOString() : null,
    }))
    .sort((a, b) => (a.alive === b.alive ? a.url.localeCompare(b.url) : a.alive ? -1 : 1));
}

export async function observatoryJson(env) {
  let state = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* vuoto */ }
  const rows = fullRows(state);
  const alive = rows.filter((r) => r.alive).length;
  return {
    name: "GBLIN x402 Uptime Observatory",
    generated_at: new Date(state?.updatedAt || Date.now()).toISOString(),
    stable_url: "https://gblin-mcp.gblin-mcp-worker.workers.dev/observatory.json",
    methodology: METHODOLOGY,
    summary: { tracked: rows.length, alive_now: alive, alive_pct: rows.length ? Math.round((1000 * alive) / rows.length) / 10 : 0 },
    endpoints: rows,
    free_market_risk_regime: "https://gblin-mcp.gblin-mcp-worker.workers.dev/regime",
    operator: "gblin.digital (ERC-8004 agent #59286 on Base) — our own endpoints appear in the table under the same rules",
  };
}

export async function observatoryPage(env) {
  const d = await observatoryJson(env);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const tr = d.endpoints.map((r) => {
    const host = r.url.replace(/^https?:\/\//, "").split("/")[0];
    const path = r.url.replace(/^https?:\/\/[^/]+/, "");
    return `<tr${r.ours ? ' class="ours"' : ""}><td>${r.alive ? "🟢" : "🔴"}</td><td>${esc(host)}${r.ours ? " <b>(ours)</b>" : ""}</td><td class="p">${esc(path)}</td><td>${r.http || "—"}</td><td>${r.latency_ms ?? "—"}</td><td>${r.last_ok ? esc(r.last_ok.slice(0, 16)) + "Z" : "never"}</td><td>${r.consecutive_fails}</td></tr>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402 Uptime Observatory — ${d.summary.alive_pct}% of the catalog answers | GBLIN</title>
<meta name="description" content="The x402 uptime observatory: continuous liveness probes of the ${d.summary.tracked} most recently updated x402 catalog resources. ${d.summary.alive_now} answer today (${d.summary.alive_pct}%). Free data, stable JSON, pre-registered method. By GBLIN, whose own endpoints sit in the same table.">
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:1080px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.5rem}code,td.p{font-family:ui-monospace,monospace;font-size:.85em}
table{border-collapse:collapse;width:100%;margin-top:1rem}td,th{padding:.3rem .55rem;border-bottom:1px solid #e5e5e5;text-align:left;font-size:.86rem}
tr.ours{background:#fffbe8}.k{color:#555}.box{background:#f6f6f6;border-radius:8px;padding:.9rem 1.1rem;margin:1rem 0}
@media(prefers-color-scheme:dark){body{background:#111;color:#e6e6e6}td,th{border-color:#2c2c2c}tr.ours{background:#2a2410}.box{background:#1c1c1c}}</style></head><body>
<h1>x402 Uptime Observatory</h1>
<p class="k">Generated ${esc(d.generated_at)} · refreshed continuously · <a href="/observatory.json">raw JSON (stable URL)</a> · <a href="/observatory/badge.svg">badge</a></p>
<p><b>${d.summary.alive_now} of ${d.summary.tracked}</b> tracked x402 resources answer right now — <b>${d.summary.alive_pct}%</b>. The rest of the catalog is unreachable, by the pre-registered definition below.</p>
<div class="box"><b>Method (pre-registered):</b> ${esc(d.methodology.selection)}. Probe: ${esc(d.methodology.probe)}. <b>Alive</b> = ${esc(d.methodology.alive)}. ${esc(d.methodology.never)}.</div>
<p class="k">Run by <a href="https://gblin.digital">GBLIN</a> (ERC-8004 agent #59286). Our own endpoints appear below under the same rules — highlighted, not exempted. The free on-chain market risk regime lives at <a href="/regime"><code>/regime</code></a>.</p>
<table><thead><tr><th></th><th>host</th><th>path</th><th>HTTP</th><th>ms</th><th>last OK (UTC)</th><th>fails</th></tr></thead><tbody>
${tr}
</tbody></table>
<p class="k">Reading is free forever. Data license: reuse with a link to this page. Contact: info@gblin.digital</p>
</body></html>`;
  return html;
}

export async function observatoryBadge(env, host) {
  const d = await observatoryJson(env);
  let label = "x402 catalog alive";
  let value = `${d.summary.alive_pct}%`;
  let color = d.summary.alive_pct >= 50 ? "#2da44e" : "#d4a72c";
  if (host) {
    const rows = d.endpoints.filter((r) => r.url.includes(host));
    const up = rows.filter((r) => r.alive).length;
    label = `x402 uptime · ${host}`;
    value = rows.length ? `${up}/${rows.length} up` : "not tracked";
    color = rows.length && up === rows.length ? "#2da44e" : up > 0 ? "#d4a72c" : "#cf222e";
  }
  const lw = 7 * label.length + 12, vw = 7 * value.length + 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label}: ${value}">
<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="6" y="14">${label}</text><text x="${lw + 6}" y="14">${value}</text></g></svg>`;
}
