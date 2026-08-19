// GBLIN witness — cosigns third-party transparency-log checkpoints.
//
// Why: a certifier that asks others to be checkable should submit to the same
// discipline. Witnessing a log we already appear in (as a paid input of a
// third-party agent) makes the dependency inspectable from both sides.
//
// What it does, every scheduled tick, per configured log:
//   1. GET <log>/checkpoint  (C2SP tlog-checkpoint: signed note)
//   2. verify the LOG's own Ed25519 note signature against a PINNED key
//   3. if we have a previous checkpoint: GET <log>/consistency?old=&new= and
//      verify the RFC 6962 consistency proof (the tree only ever grows)
//   4. cosign (c2sp.org/tlog-cosignature v1, Ed25519) and store the cosigned note
// Anything that fails → nothing is signed, the failure is recorded, next tick retries.
// No chain, no gas, no tokens: one HTTP read + one signature per tick.
//
// Formats (all C2SP, https://c2sp.org):
//   signed note        = text ("\n"-terminated lines) + "\n" + ("— <name> <b64>\n")*
//   verifier key       = <name>+<hex keyhash[:4]>+<b64(alg || pubkey)>
//   alg 0x01           = Ed25519 note signature       (message = text)
//   alg 0x04           = Ed25519 cosignature/v1        (message = "cosignature/v1\ntime <t>\n" + text)
//   keyhash            = SHA-256(name + "\n" + alg || pubkey)
//   cosig line payload = keyhash[:4] || uint64be(t) || sig(64)
//
// Secret: WITNESS_KEY = "<hex ed25519 seed 32B>:<hex ed25519 pubkey 32B>" (Workers' WebCrypto
// needs both for JWK import). Missing → witness is silently disabled (fail-safe, like ATTESTER_KEY).

export const WITNESS_NAME = "gblin.digital/witness";

export const WITNESSED_LOGS = [
  {
    id: "markovian",
    origin: "markovianprotocol.com/log",
    base: "https://log.markovianprotocol.com",
    // Pinned 2026-08-18 from two independent places: the log's root page and its
    // /policy file. If the log ever rotates its key this witness stops signing —
    // which is the correct behaviour — until a human re-pins on purpose.
    vkey: "markovianprotocol.com/log+0302c6c8+ATkpOWo95UuEiW2EhNZAol4f0CS8hMluJfPcTSzrr03v",
    note: "Log operated by Markovian Protocol (ERC-8004 agent #59895), whose Agent 2 buys GBLIN's risk attestation and records each purchase as a leaf.",
  },
];

// ---------- small codecs ----------
const te = new TextEncoder();
const td = new TextDecoder();
export const b64 = (u8) => btoa(String.fromCharCode(...u8));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/.{2}/g).map((x) => parseInt(x, 16)));
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------- signed notes ----------
export function parseNote(text) {
  // text may end with "\n" after signature lines; the split point is the first blank line
  const i = text.indexOf("\n\n");
  if (i < 0) throw new Error("note: no blank line");
  const body = text.slice(0, i + 1); // includes trailing "\n"
  const sigLines = text.slice(i + 2).split("\n").filter((l) => l.length > 0);
  const lines = body.split("\n");
  if (lines.length < 3) throw new Error("note: short body");
  const size = Number(lines[1]);
  if (!Number.isInteger(size) || size < 0) throw new Error("note: bad size");
  return { body, origin: lines[0], size, root: unb64(lines[2]), sigLines };
}

export function parseVkey(vkey) {
  const m = /^([^+]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/=]+)$/.exec(vkey);
  if (!m) throw new Error("bad verifier key");
  const raw = unb64(m[3]);
  return { name: m[1], hash: unhex(m[2]), alg: raw[0], pub: raw.slice(1) };
}

async function keyHash(name, alg, pub) {
  return (await sha256(cat(te.encode(name + "\n"), Uint8Array.of(alg), pub))).slice(0, 4);
}

// Verify the LOG's own signature (alg 0x01) on a note body. Returns true/false.
export async function verifyLogSignature(note, vkey) {
  const k = parseVkey(vkey);
  if (k.alg !== 0x01) throw new Error("pinned key is not an Ed25519 note key");
  const expectHash = await keyHash(k.name, 0x01, k.pub);
  if (!eq(expectHash, k.hash)) throw new Error("pinned key hash mismatch (typo in vkey?)");
  const key = await crypto.subtle.importKey("raw", k.pub, { name: "Ed25519" }, false, ["verify"]);
  for (const line of note.sigLines) {
    const m = /^— (\S+) (\S+)$/.exec(line);
    if (!m || m[1] !== k.name) continue;
    const payload = unb64(m[2]);
    if (payload.length !== 4 + 64) continue; // e.g. ML-DSA line under the same name: skip
    if (!eq(payload.slice(0, 4), k.hash)) continue;
    if (await crypto.subtle.verify({ name: "Ed25519" }, key, payload.slice(4), te.encode(note.body))) return true;
  }
  return false;
}

// ---------- RFC 6962 consistency proof (tlog / CT algorithm) ----------
const nodeHash = async (l, r) => sha256(cat(Uint8Array.of(0x01), l, r));
export async function verifyConsistency(n, m, oldRoot, newRoot, proof) {
  if (n === m) return proof.length === 0 && eq(oldRoot, newRoot);
  if (n === 0) return proof.length === 0; // any newRoot is consistent with the empty tree
  if (n > m || proof.length === 0) return false;
  let fn = n - 1, sn = m - 1;
  while (fn & 1) { fn >>= 1; sn >>= 1; }
  let i = 0, fr, sr;
  if ((n & (n - 1)) === 0) { fr = oldRoot; sr = oldRoot; } // n is a power of two
  else { fr = proof[0]; sr = proof[0]; i = 1; }
  for (; i < proof.length; i++) {
    if (sn === 0) return false;
    const c = proof[i];
    if ((fn & 1) || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      while (!(fn & 1) && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && eq(fr, oldRoot) && eq(sr, newRoot);
}

// ---------- our key ----------
export function parseWitnessSecret(secret) {
  const m = /^([0-9a-fA-F]{64}):([0-9a-fA-F]{64})$/.exec((secret || "").trim());
  if (!m) throw new Error("WITNESS_KEY must be <hex seed>:<hex pub>");
  return { seed: unhex(m[1]), pub: unhex(m[2]) };
}
async function importSigner({ seed, pub }) {
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) };
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}
export async function witnessVerifierKey(pub) {
  const h = await keyHash(WITNESS_NAME, 0x04, pub);
  return `${WITNESS_NAME}+${hex(h)}+${b64(cat(Uint8Array.of(0x04), pub))}`;
}

// Cosign a verified note. Returns { line, ts }.
export async function cosign(note, keyPair, ts = Math.floor(Date.now() / 1000)) {
  const signer = await importSigner(keyPair);
  const msg = te.encode(`cosignature/v1\ntime ${ts}\n` + note.body);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signer, msg));
  const h = await keyHash(WITNESS_NAME, 0x04, keyPair.pub);
  const tsb = new Uint8Array(8);
  new DataView(tsb.buffer).setBigUint64(0, BigInt(ts));
  return { line: `— ${WITNESS_NAME} ${b64(cat(h, tsb, sig))}`, ts };
}

// Verify one of OUR cosignature lines (used by tests and by /witness/verify).
export async function verifyCosignature(noteBody, line, pub) {
  const m = /^— (\S+) (\S+)$/.exec(line);
  if (!m || m[1] !== WITNESS_NAME) return false;
  const p = unb64(m[2]);
  if (p.length !== 4 + 8 + 64) return false;
  if (!eq(p.slice(0, 4), await keyHash(WITNESS_NAME, 0x04, pub))) return false;
  const ts = Number(new DataView(p.buffer, p.byteOffset + 4, 8).getBigUint64(0));
  const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  const msg = te.encode(`cosignature/v1\ntime ${ts}\n` + noteBody);
  return crypto.subtle.verify({ name: "Ed25519" }, key, p.slice(12), msg);
}


// Storia delle cofirme (richiesta Markovian 19/08: "if you keep the earlier ones anywhere fetchable I will check those too").
// Una lista per log in KV: [{size, root, ts, via, note}], cap 400 voci (le più vecchie escono), una scrittura per cofirma.
async function appendHistory(env, id, entry) {
  const k = `witness:${id}:history`;
  let h = [];
  try { h = JSON.parse((await env.COHERENCE.get(k)) || "[]"); } catch { h = []; }
  h.push(entry); if (h.length > 400) h = h.slice(h.length - 400);
  await env.COHERENCE.put(k, JSON.stringify(h));
}
export async function witnessHistory(env, id) {
  if (!env.COHERENCE) return [];
  try { return JSON.parse((await env.COHERENCE.get(`witness:${id}:history`)) || "[]"); } catch { return []; }
}

// ---------- the tick ----------
// State in KV (binding COHERENCE, same namespace as the coherence automaton):
//   witness:<id>:last   {size, root(b64), ts, cosignedNote, logSigOk:true}
//   witness:<id>:err    {at, error}   (cleared on success)
//   witness:<id>:count  number of cosignatures ever produced
export async function witnessTick(env, fetchImpl = fetch) {
  if (!env.COHERENCE || !env.WITNESS_KEY) return { skipped: "not armed" };
  let keyPair;
  try { keyPair = parseWitnessSecret(env.WITNESS_KEY); } catch (e) { return { skipped: e.message }; }
  const out = {};
  for (const log of WITNESSED_LOGS) {
    const kLast = `witness:${log.id}:last`, kErr = `witness:${log.id}:err`, kCount = `witness:${log.id}:count`;
    try {
      const res = await fetchImpl(`${log.base}/checkpoint`, { headers: { "user-agent": "gblin-witness/1 (+https://gblin.digital)" } });
      if (!res.ok) throw new Error(`checkpoint HTTP ${res.status}`);
      const text = await res.text();
      const note = parseNote(text);
      if (note.origin !== log.origin) throw new Error(`origin mismatch: ${note.origin}`);
      if (!(await verifyLogSignature(note, log.vkey))) throw new Error("log signature invalid");

      let prev = null;
      try { prev = JSON.parse((await env.COHERENCE.get(kLast)) || "null"); } catch { prev = null; }
      if (prev) {
        if (note.size < prev.size) throw new Error(`tree shrank ${prev.size} -> ${note.size}`);
        if (note.size === prev.size) {
          if (b64(note.root) !== prev.root) throw new Error("same size, different root (fork!)");
          out[log.id] = { unchanged: true, size: note.size };
          continue; // nothing new to cosign
        }
        const pr = await fetchImpl(`${log.base}/consistency?old=${prev.size}&new=${note.size}`);
        if (!pr.ok) throw new Error(`consistency HTTP ${pr.status}`);
        const proof = (await pr.text()).split("\n").filter((l) => l.length > 0).map(unb64);
        if (!(await verifyConsistency(prev.size, note.size, unb64(prev.root), note.root, proof))) {
          throw new Error(`consistency proof FAILED ${prev.size} -> ${note.size}`);
        }
      }

      const { line, ts } = await cosign(note, keyPair);
      const cosignedNote = text.endsWith("\n") ? text + line + "\n" : text + "\n" + line + "\n";
      await env.COHERENCE.put(kLast, JSON.stringify({ size: note.size, root: b64(note.root), ts, cosignedNote, firstSeen: prev?.firstSeen || ts }));
      await appendHistory(env, log.id, { size: note.size, root: b64(note.root), ts, via: "fetch", note: cosignedNote });
      const count = Number((await env.COHERENCE.get(kCount)) || 0) + 1;
      await env.COHERENCE.put(kCount, String(count));
      await env.COHERENCE.delete(kErr);
      out[log.id] = { cosigned: true, size: note.size, ts, count };
    } catch (e) {
      const error = String(e && e.message || e);
      await env.COHERENCE.put(kErr, JSON.stringify({ at: Math.floor(Date.now() / 1000), error }), { expirationTtl: 30 * 86400 });
      out[log.id] = { error };
      console.error(`witness ${log.id}:`, error);
    }
  }
  return out;
}


// ---------- push side: c2sp.org/tlog-witness (the LOG calls us) ----------
// POST /witness/add-checkpoint   body = "old <size>\n" + proof lines (b64, one per line) + "\n" + <signed checkpoint note>
// 200 → our cosignature line(s); 400 malformed; 403 unknown log / not signed by the pinned key;
// 409 `old` ≠ the size we hold (body = our size, decimal + "\n"); 422 consistency proof invalid / tree shrank / fork.
// Same KV state as the passive tick, so pushed and fetched checkpoints can never disagree.
export async function witnessAddCheckpoint(env, bodyText) {
  if (!env.COHERENCE || !env.WITNESS_KEY) return { status: 503, body: "witness not armed\n" };
  let keyPair;
  try { keyPair = parseWitnessSecret(env.WITNESS_KEY); } catch { return { status: 503, body: "witness not armed\n" }; }
  const sep = bodyText.indexOf("\n\n");
  if (sep < 0) return { status: 400, body: "malformed: no blank line between proof and checkpoint\n" };
  const head = bodyText.slice(0, sep).split("\n");
  const m = /^old (\d+)$/.exec(head[0] || "");
  if (!m) return { status: 400, body: "malformed: first line must be 'old <size>'\n" };
  const old = Number(m[1]);
  let proof;
  try { proof = head.slice(1).filter((l) => l.length > 0).map(unb64); } catch { return { status: 400, body: "malformed: proof lines must be base64\n" }; }
  let note;
  try { note = parseNote(bodyText.slice(sep + 2)); } catch (e) { return { status: 400, body: `malformed checkpoint: ${e.message}\n` }; }
  const log = WITNESSED_LOGS.find((l) => l.origin === note.origin);
  if (!log) return { status: 403, body: "unknown log\n" };
  let sigOk = false;
  try { sigOk = await verifyLogSignature(note, log.vkey); } catch { sigOk = false; }
  if (!sigOk) return { status: 403, body: "checkpoint not signed by the pinned log key\n" };

  const kLast = `witness:${log.id}:last`, kCount = `witness:${log.id}:count`, kErr = `witness:${log.id}:err`;
  let prev = null;
  try { prev = JSON.parse((await env.COHERENCE.get(kLast)) || "null"); } catch { prev = null; }
  const held = prev ? prev.size : 0;
  if (old !== held) return { status: 409, body: `${held}\n` };
  if (prev) {
    if (note.size < prev.size) return { status: 422, body: "tree shrank\n" };
    if (note.size === prev.size) {
      if (b64(note.root) !== prev.root) return { status: 422, body: "same size, different root\n" };
      // nothing new: re-cosign the head we already hold (fresh timestamp)
    } else if (!(await verifyConsistency(prev.size, note.size, unb64(prev.root), note.root, proof))) {
      return { status: 422, body: "consistency proof invalid\n" };
    }
  } else if (proof.length !== 0) {
    return { status: 400, body: "no proof expected for old 0\n" };
  }
  const { line, ts } = await cosign(note, keyPair);
  if (!prev || note.size > prev.size) {
    const text = bodyText.slice(sep + 2);
    const cosignedNote = text.endsWith("\n") ? text + line + "\n" : text + "\n" + line + "\n";
    await env.COHERENCE.put(kLast, JSON.stringify({ size: note.size, root: b64(note.root), ts, cosignedNote, firstSeen: prev?.firstSeen || ts, via: "push" }));
    await appendHistory(env, log.id, { size: note.size, root: b64(note.root), ts, via: "push", note: cosignedNote });
    const count = Number((await env.COHERENCE.get(kCount)) || 0) + 1;
    await env.COHERENCE.put(kCount, String(count));
    await env.COHERENCE.delete(kErr);
  }
  return { status: 200, body: line + "\n" };
}

// ---------- public read side ----------
export async function witnessIndex(env) {
  let verifierKey = null;
  if (env.WITNESS_KEY) { try { verifierKey = await witnessVerifierKey(parseWitnessSecret(env.WITNESS_KEY).pub); } catch { /* unset */ } }
  const logs = [];
  for (const log of WITNESSED_LOGS) {
    let last = null, err = null, count = 0;
    if (env.COHERENCE) {
      try { last = JSON.parse((await env.COHERENCE.get(`witness:${log.id}:last`)) || "null"); } catch { /* none */ }
      try { err = JSON.parse((await env.COHERENCE.get(`witness:${log.id}:err`)) || "null"); } catch { /* none */ }
      count = Number((await env.COHERENCE.get(`witness:${log.id}:count`)) || 0);
    }
    logs.push({
      id: log.id, origin: log.origin, log: log.base, pinnedLogKey: log.vkey, note: log.note,
      latest: last ? { size: last.size, root: last.root, cosignedAt: last.ts, cosignedAtIso: new Date(last.ts * 1000).toISOString(), url: `/witness/${log.id}` } : null,
      cosignatures: count,
      lastError: err,
      firstCosignedAt: last?.firstSeen ? new Date(last.firstSeen * 1000).toISOString() : null,
    });
  }
  return {
    witness: WITNESS_NAME,
    verifierKey,
    format: "c2sp.org/tlog-cosignature (v1, Ed25519); checkpoints re-verified against the pinned log key and a consistency proof before every cosignature",
    cadence: "every 10 minutes (same heartbeat as the coherence automaton); unchanged tree size → no new signature",
    armed: !!verifierKey,
    logs,
    roster_status: "markovian: cosigning, no policy weight — the log operator verified our key and push endpoint (2026-08-19); our line appears on their checkpoint once their push runs from the log host; counting toward their 4-of-7 quorum requires their next trust-root manifest rotation. Stated here so the roster does not imply more than it is.",
    history: "GET /witness/<log>/history (JSON list of every cosigned note we still hold, newest last, max 400) and /witness/<log>/<size> (one cosigned note as plain text)",
    push_endpoint: "POST /witness/add-checkpoint — c2sp.org/tlog-witness (body: 'old <size>', consistency proof lines, blank line, signed checkpoint; 200 = cosignature line, 409 = size we hold, 422 = proof invalid)",
    honest_note: "A cosignature says only: 'at this time we saw this tree head and it was consistent with the previous one we saw'. It is not an endorsement of the log's contents.",
  };
}

export async function witnessLatestNote(env, id) {
  const log = WITNESSED_LOGS.find((l) => l.id === id);
  if (!log || !env.COHERENCE) return null;
  try {
    const last = JSON.parse((await env.COHERENCE.get(`witness:${id}:last`)) || "null");
    return last ? last.cosignedNote : null;
  } catch { return null; }
}
