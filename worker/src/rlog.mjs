// rlog.mjs — GBLIN AI ACTION RECEIPTS: append-only transparency log + sealing.
//
// Cosa fa: un agente (o un'app IA) manda gli HASH di ciò che ha fatto
// (input/output/azione); il log li accoda a un albero Merkle RFC 6962,
// firma un checkpoint C2SP e restituisce una RICEVUTA portabile e
// verificabile OFFLINE: payload canonico + firma Ed25519 + indice nel log
// + inclusion proof + checkpoint firmato. Il root viene ancorato su Base
// (EAS) una volta al giorno dal wallet osservatore. Nessun contenuto viene
// mai memorizzato: SOLO hash e stringhe corte (GDPR-light by design).
//
// Regole pre-registrate (non cambiarle senza dichiararlo nel changelog):
//  - leaf = SHA256(0x00 || canonical_payload_utf8)   (RFC 6962)
//  - node = SHA256(0x01 || left || right)
//  - canonical JSON: chiavi ordinate, nessuno spazio, UTF-8
//  - receipt signature: Ed25519 su "gblin-receipt/v1\n" + canonical_payload
//  - checkpoint: signed note C2SP, origin "gblin.digital/receipts-log"
//  - il log NON giudica e NON verifica i contenuti: attesta esistenza+tempo.
//    "evidence, not endorsement; a seal is not a compliance certificate."
//
// Secret: RLOG_KEY = "<hex seed 32B>:<hex pub 32B>" (come WITNESS_KEY).
// KV (binding COHERENCE): rlog:size · rlog:entry:<n> · rlog:node:<l>:<i>
//                         rlog:demo:<ip>:<day> · rlog:anchored:<day>

export const RLOG_ORIGIN = "gblin.digital/receipts-log";
const MAX_STR = 128;           // max per action/agent_id/tool
const MAX_META = 512;          // max chars del JSON meta
const DEMO_PER_DAY = 5;        // sigilli demo gratis per IP/giorno

const te = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/.{2}/g).map((x) => parseInt(x, 16)));
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
const leafHash = (data) => sha256(cat(Uint8Array.of(0x00), data));
const nodeHash = (l, r) => sha256(cat(Uint8Array.of(0x01), l, r));

// Canonical JSON: chiavi ordinate ricorsivamente, separatori minimi.
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

// ---------- chiave del log ----------
function parseKey(secret) {
  const m = /^([0-9a-fA-F]{64}):([0-9a-fA-F]{64})$/.exec((secret || "").trim());
  if (!m) throw new Error("RLOG_KEY must be <hex seed>:<hex pub>");
  return { seed: unhex(m[1]), pub: unhex(m[2]) };
}
async function signer(kp) {
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64url(kp.seed), x: b64url(kp.pub) };
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}
async function keyHash(name, alg, pub) {
  return (await sha256(cat(te.encode(name + "\n"), Uint8Array.of(alg), pub))).slice(0, 4);
}
export async function rlogVerifierKey(pub) {
  const h = await keyHash(RLOG_ORIGIN, 0x01, pub);
  return `${RLOG_ORIGIN}+${hex(h)}+${b64(cat(Uint8Array.of(0x01), pub))}`;
}

// ---------- Merkle su KV (nodi congelati) ----------
const nk = (l, i) => `rlog:node:${l}:${i}`;
async function getNode(env, l, i) {
  const v = await env.COHERENCE.get(nk(l, i));
  if (!v) throw new Error(`missing node ${l}:${i}`);
  return unhex(v);
}
// Root di un range [a,b) con b<=N, usando SOLO nodi congelati (ogni foglia
// scritta congela node:0:i, e ogni coppia completa congela il genitore).
async function rangeRoot(env, a, b) {
  const len = b - a;
  if (len === 1) return getNode(env, 0, a);
  // range perfetto allineato → nodo congelato diretto
  const isPow2 = (len & (len - 1)) === 0;
  if (isPow2 && a % len === 0) {
    const level = Math.log2(len);
    return getNode(env, level, a / len);
  }
  let k = 1; while (k * 2 < len) k *= 2;
  const [L, R] = await Promise.all([rangeRoot(env, a, a + k), rangeRoot(env, a + k, b)]);
  return nodeHash(L, R);
}
export async function treeRoot(env, N) {
  if (N === 0) return sha256(new Uint8Array(0)); // RFC 6962: root dell'albero vuoto
  return rangeRoot(env, 0, N);
}
// Inclusion proof RFC 6962 per la foglia i in un albero di N foglie.
async function inclusionPath(env, i, a, b) {
  if (b - a === 1) return [];
  let k = 1; while (k * 2 < b - a) k *= 2;
  if (i < a + k) {
    const sub = await inclusionPath(env, i, a, a + k);
    sub.push(await rangeRoot(env, a + k, b));
    return sub;
  }
  const sub = await inclusionPath(env, i, a + k, b);
  sub.push(await rangeRoot(env, a, a + k));
  return sub;
}
export async function proofFor(env, index, N) {
  if (!(index >= 0 && index < N)) throw new Error("index out of range");
  const path = await inclusionPath(env, index, 0, N);
  return path.map(b64);
}

// ---------- checkpoint (signed note C2SP) ----------
export async function signedCheckpoint(env, N, root) {
  const kp = parseKey(env.RLOG_KEY);
  const body = `${RLOG_ORIGIN}\n${N}\n${b64(root)}\n`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await signer(kp), te.encode(body)));
  const kh = await keyHash(RLOG_ORIGIN, 0x01, kp.pub);
  return body + "\n" + `— ${RLOG_ORIGIN} ${b64(cat(kh, sig))}` + "\n";
}

// ---------- append + ricevuta ----------
export function validateSealInput(body) {
  const errs = [];
  const hexRe = /^(0x)?[0-9a-fA-F]{64}$/;
  const s = (x) => typeof x === "string" ? x.trim() : "";
  const action = s(body.action), agent = s(body.agent_id), tool = s(body.tool);
  if (!action || action.length > MAX_STR) errs.push("action: required, <=128 chars");
  if (agent.length > MAX_STR) errs.push("agent_id: <=128 chars");
  if (tool.length > MAX_STR) errs.push("tool: <=128 chars");
  if (!hexRe.test(s(body.input_hash) || "")) errs.push("input_hash: 32-byte hex (sha256 of your input) required");
  if (body.output_hash != null && !hexRe.test(s(body.output_hash))) errs.push("output_hash: 32-byte hex if present");
  let meta = null;
  if (body.meta != null) {
    const mj = typeof body.meta === "string" ? body.meta : JSON.stringify(body.meta);
    if (mj.length > MAX_META) errs.push("meta: <=512 chars JSON");
    else { try { meta = JSON.parse(mj); } catch { errs.push("meta: invalid JSON"); } }
  }
  return { errs, action, agent, tool, meta,
    input_hash: s(body.input_hash).replace(/^0x/, "").toLowerCase(),
    output_hash: body.output_hash != null ? s(body.output_hash).replace(/^0x/, "").toLowerCase() : null };
}

export async function sealAction(env, input, { demo = false } = {}) {
  if (!env.COHERENCE) return { status: 503, error: "log storage unavailable" };
  if (!env.RLOG_KEY) return { status: 503, error: "log key not armed" };
  const v = validateSealInput(input);
  if (v.errs.length) return { status: 400, error: v.errs.join("; ") };

  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  const payload = {
    v: 1, log: RLOG_ORIGIN, index: N, ts: new Date().toISOString(),
    action: v.action, agent_id: v.agent || null, tool: v.tool || null,
    input_hash: v.input_hash, output_hash: v.output_hash, meta: v.meta,
    demo: demo || undefined,
  };
  const canonical = canonicalize(payload);
  const leaf = await leafHash(te.encode(canonical));

  // append: entry + leaf(node 0) + congelamento dei genitori completati
  await env.COHERENCE.put(`rlog:entry:${N}`, canonical);
  await env.COHERENCE.put(nk(0, N), hex(leaf));
  let l = 0, i = N, cur = leaf;
  while (i % 2 === 1) {
    const sib = await getNode(env, l, i - 1);
    cur = await nodeHash(sib, cur);
    l += 1; i = (i - 1) / 2;
    await env.COHERENCE.put(nk(l, i), hex(cur));
  }
  const size = N + 1;
  await env.COHERENCE.put("rlog:size", String(size));

  const root = await treeRoot(env, size);
  const [checkpoint, proof] = await Promise.all([
    signedCheckpoint(env, size, root),
    proofFor(env, N, size),
  ]);
  const kp = parseKey(env.RLOG_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" }, await signer(kp), te.encode("gblin-receipt/v1\n" + canonical)));

  return {
    status: 200,
    receipt: {
      format: "gblin-receipt/v1",
      payload, canonical_sha256: hex(await sha256(te.encode(canonical))),
      leaf: b64(leaf), index: N, tree_size: size, root: b64(root),
      signature: b64(sig),
      verifier_key: await rlogVerifierKey(kp.pub),
      inclusion_proof: proof,
      checkpoint,
      verify: "offline: see verify-receipt.mjs in github.com/gblinproject/gblin-treasury-risk-regime (zero deps)",
      note: "Evidence of existence and time, independently witnessed — NOT a compliance certificate and NOT an endorsement of the content.",
    },
  };
}

export async function getReceipt(env, index) {
  if (!env.COHERENCE || !env.RLOG_KEY) return { status: 503, error: "log unavailable" };
  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  if (!(index >= 0 && index < N)) return { status: 404, error: "no such receipt" };
  const canonical = await env.COHERENCE.get(`rlog:entry:${index}`);
  if (!canonical) return { status: 404, error: "entry missing" };
  const root = await treeRoot(env, N);
  const [checkpoint, proof] = await Promise.all([signedCheckpoint(env, N, root), proofFor(env, index, N)]);
  const kp = parseKey(env.RLOG_KEY);
  return {
    status: 200,
    receipt: {
      format: "gblin-receipt/v1", payload: JSON.parse(canonical),
      leaf: b64(await leafHash(te.encode(canonical))), index, tree_size: N, root: b64(root),
      verifier_key: await rlogVerifierKey(kp.pub),
      inclusion_proof: proof, checkpoint,
    },
  };
}

export async function rlogStatus(env) {
  const N = Number((await env.COHERENCE?.get("rlog:size")) || 0);
  let root = null, checkpoint = null, vkey = null;
  if (N > 0 && env.RLOG_KEY) {
    const r = await treeRoot(env, N);
    root = b64(r); checkpoint = await signedCheckpoint(env, N, r);
    vkey = await rlogVerifierKey(parseKey(env.RLOG_KEY).pub);
  } else if (env.RLOG_KEY) {
    vkey = await rlogVerifierKey(parseKey(env.RLOG_KEY).pub);
  }
  return { origin: RLOG_ORIGIN, size: N, root, verifier_key: vkey, checkpoint };
}

// rate-limit demo per IP (KV, TTL 24h)
export async function demoAllowed(env, ip) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `rlog:demo:${ip}:${day}`;
  const n = Number((await env.COHERENCE.get(k)) || 0);
  if (n >= DEMO_PER_DAY) return false;
  await env.COHERENCE.put(k, String(n + 1), { expirationTtl: 90000 });
  return true;
}
