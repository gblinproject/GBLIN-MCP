// Sfida x402 ANONIMA servita dal bordo, per non far partire una funzione Vercel.
//
// Perche': misurato il 22/08/2026, il 91 per cento della CPU fatturata su Vercel (7h10m su
// 7h53m, contro 4h incluse) e' il middleware x402 che risponde 402 a crawler e sonde —
// ~7.400 volte al giorno. Il middleware gira PRIMA della cache CDN, quindi nessuna cache lo
// riduce, e su Vercel il 402 non e' uno stato cacheabile.
//
// Come ci arriva il traffico: una Project Routing Rule di Vercel riscrive verso qui le
// richieste a /api/x402/attestation CHE NON PORTANO un header di pagamento. Chi paga non
// matcha la regola e prosegue sul percorso normale su Vercel, dove la verifica del pagamento
// resta l'unica autorita' che muove denaro.
//
// VINCOLO: questi byte sono indicizzati dal Bazaar di Coinbase e sono la fixture golden in
// GBLIN_WEBAPP/test/x402-golden/. Se cambia la sfida sulla webapp va rigenerata anche qui,
// altrimenti pubblichiamo due termini diversi. `node verify.mjs` in quella cartella se ne accorge.
// Generato da GBLIN_WEBAPP/test/x402-golden/attestation.json.json il 2026-08-22.

const BODY = "{\"x402Version\":2,\"error\":\"Payment required\",\"resource\":{\"url\":\"https://gblin.digital/api/x402/attestation\",\"description\":\"EIP-712-signed risk attestation, verifiable OFFLINE in one step \u2014 no trust in this server required. Perishable (10-min) proof of the BTC/ETH risk regime (calm | elevated | crash) from GBLIN's on-chain Crash Shield on Base. Bought daily by a third-party ERC-8004 agent as a pinned input of its decision rule until 16 Aug 2026 (see /receipts). FREE sample: GET /api/x402/attestation-sample. Free verifier: verify_risk_attestation in @gblin-protocol/mcp-server.\",\"mimeType\":\"application/json\"},\"accepts\":[{\"scheme\":\"exact\",\"network\":\"eip155:8453\",\"amount\":\"3000\",\"asset\":\"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\",\"payTo\":\"0x0ebA5d314F4f5Dcb7A094953Fa9311a45172dd1B\",\"maxTimeoutSeconds\":300,\"extra\":{\"name\":\"USD Coin\",\"version\":\"2\"}}],\"extensions\":{\"bazaar\":{\"info\":{\"input\":{\"type\":\"http\",\"queryParams\":{},\"method\":\"GET\"},\"output\":{\"type\":\"json\",\"example\":{\"attestation\":{\"regime\":\"calm\",\"regime_code\":0,\"risk_posture\":\"risk_on\",\"severity_pct\":0,\"severity_bps\":0,\"defensive_cash_pct\":10,\"shield_active\":false,\"block_number\":34567890,\"issued_at\":1747600000,\"expires_at\":1747600600,\"ttl_seconds\":600,\"basket_hash\":\"0xabcd\u2026\",\"chain_id\":8453,\"contract\":\"0x36C81d7E1966310F305eA637e761Cf77F90852f0\"},\"attestation_id\":\"0x9f1c\u2026\",\"signature\":\"0x\u2026 (present when attestor key configured, else null)\",\"attestor\":\"0x\u2026 (published GBLIN attestor, else null)\",\"signed\":false,\"verify\":{\"free_mcp_tool\":\"npx @gblin-protocol/mcp-server \u2192 verify_risk_attestation\"}}}},\"schema\":{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"properties\":{\"input\":{\"type\":\"object\",\"properties\":{\"type\":{\"type\":\"string\",\"const\":\"http\"},\"method\":{\"type\":\"string\",\"enum\":[\"GET\"]},\"queryParams\":{\"type\":\"object\",\"properties\":{},\"required\":[]}},\"required\":[\"type\",\"method\"],\"additionalProperties\":false},\"output\":{\"type\":\"object\",\"properties\":{\"type\":{\"type\":\"string\"},\"example\":{\"type\":\"object\"}},\"required\":[\"type\"]}},\"required\":[\"input\"]}}},\"gblin_info\":{\"docs\":\"https://gblin.digital/api/x402/llms.txt\",\"free_market_risk_regime\":\"https://gblin-mcp.gblin-mcp-worker.workers.dev/regime\",\"x402_uptime_observatory\":\"https://gblin-mcp.gblin-mcp-worker.workers.dev/observatory\",\"note\":\"Reading is free; only the paid resource above requires payment.\"}}";
const PAYMENT_REQUIRED = "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9nYmxpbi5kaWdpdGFsL2FwaS94NDAyL2F0dGVzdGF0aW9uIiwiZGVzY3JpcHRpb24iOiJFSVAtNzEyLXNpZ25lZCByaXNrIGF0dGVzdGF0aW9uLCB2ZXJpZmlhYmxlIE9GRkxJTkUgaW4gb25lIHN0ZXAg4oCUIG5vIHRydXN0IGluIHRoaXMgc2VydmVyIHJlcXVpcmVkLiBQZXJpc2hhYmxlICgxMC1taW4pIHByb29mIG9mIHRoZSBCVEMvRVRIIHJpc2sgcmVnaW1lIChjYWxtIHwgZWxldmF0ZWQgfCBjcmFzaCkgZnJvbSBHQkxJTidzIG9uLWNoYWluIENyYXNoIFNoaWVsZCBvbiBCYXNlLiBCb3VnaHQgZGFpbHkgYnkgYSB0aGlyZC1wYXJ0eSBFUkMtODAwNCBhZ2VudCBhcyBhIHBpbm5lZCBpbnB1dCBvZiBpdHMgZGVjaXNpb24gcnVsZSB1bnRpbCAxNiBBdWcgMjAyNiAoc2VlIC9yZWNlaXB0cykuIEZSRUUgc2FtcGxlOiBHRVQgL2FwaS94NDAyL2F0dGVzdGF0aW9uLXNhbXBsZS4gRnJlZSB2ZXJpZmllcjogdmVyaWZ5X3Jpc2tfYXR0ZXN0YXRpb24gaW4gQGdibGluLXByb3RvY29sL21jcC1zZXJ2ZXIuIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzIiwiYW1vdW50IjoiMzAwMCIsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwicGF5VG8iOiIweDBlYkE1ZDMxNEY0ZjVEY2I3QTA5NDk1M0ZhOTMxMWE0NTE3MmRkMUIiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAwLCJleHRyYSI6eyJuYW1lIjoiVVNEIENvaW4iLCJ2ZXJzaW9uIjoiMiJ9fV0sImV4dGVuc2lvbnMiOnsiYmF6YWFyIjp7ImluZm8iOnsiaW5wdXQiOnsidHlwZSI6Imh0dHAiLCJxdWVyeVBhcmFtcyI6e30sIm1ldGhvZCI6IkdFVCJ9LCJvdXRwdXQiOnsidHlwZSI6Impzb24iLCJleGFtcGxlIjp7ImF0dGVzdGF0aW9uIjp7InJlZ2ltZSI6ImNhbG0iLCJyZWdpbWVfY29kZSI6MCwicmlza19wb3N0dXJlIjoicmlza19vbiIsInNldmVyaXR5X3BjdCI6MCwic2V2ZXJpdHlfYnBzIjowLCJkZWZlbnNpdmVfY2FzaF9wY3QiOjEwLCJzaGllbGRfYWN0aXZlIjpmYWxzZSwiYmxvY2tfbnVtYmVyIjozNDU2Nzg5MCwiaXNzdWVkX2F0IjoxNzQ3NjAwMDAwLCJleHBpcmVzX2F0IjoxNzQ3NjAwNjAwLCJ0dGxfc2Vjb25kcyI6NjAwLCJiYXNrZXRfaGFzaCI6IjB4YWJjZOKApiIsImNoYWluX2lkIjo4NDUzLCJjb250cmFjdCI6IjB4MzZDODFkN0UxOTY2MzEwRjMwNWVBNjM3ZTc2MUNmNzdGOTA4NTJmMCJ9LCJhdHRlc3RhdGlvbl9pZCI6IjB4OWYxY+KApiIsInNpZ25hdHVyZSI6IjB44oCmIChwcmVzZW50IHdoZW4gYXR0ZXN0b3Iga2V5IGNvbmZpZ3VyZWQsIGVsc2UgbnVsbCkiLCJhdHRlc3RvciI6IjB44oCmIChwdWJsaXNoZWQgR0JMSU4gYXR0ZXN0b3IsIGVsc2UgbnVsbCkiLCJzaWduZWQiOmZhbHNlLCJ2ZXJpZnkiOnsiZnJlZV9tY3BfdG9vbCI6Im5weCBAZ2JsaW4tcHJvdG9jb2wvbWNwLXNlcnZlciDihpIgdmVyaWZ5X3Jpc2tfYXR0ZXN0YXRpb24ifX19fSwic2NoZW1hIjp7IiRzY2hlbWEiOiJodHRwczovL2pzb24tc2NoZW1hLm9yZy9kcmFmdC8yMDIwLTEyL3NjaGVtYSIsInR5cGUiOiJvYmplY3QiLCJwcm9wZXJ0aWVzIjp7ImlucHV0Ijp7InR5cGUiOiJvYmplY3QiLCJwcm9wZXJ0aWVzIjp7InR5cGUiOnsidHlwZSI6InN0cmluZyIsImNvbnN0IjoiaHR0cCJ9LCJtZXRob2QiOnsidHlwZSI6InN0cmluZyIsImVudW0iOlsiR0VUIl19LCJxdWVyeVBhcmFtcyI6eyJ0eXBlIjoib2JqZWN0IiwicHJvcGVydGllcyI6e30sInJlcXVpcmVkIjpbXX19LCJyZXF1aXJlZCI6WyJ0eXBlIiwibWV0aG9kIl0sImFkZGl0aW9uYWxQcm9wZXJ0aWVzIjpmYWxzZX0sIm91dHB1dCI6eyJ0eXBlIjoib2JqZWN0IiwicHJvcGVydGllcyI6eyJ0eXBlIjp7InR5cGUiOiJzdHJpbmcifSwiZXhhbXBsZSI6eyJ0eXBlIjoib2JqZWN0In19LCJyZXF1aXJlZCI6WyJ0eXBlIl19fSwicmVxdWlyZWQiOlsiaW5wdXQiXX19fX0=";

export function x402StaticChallenge(request) {
  // Rete di sicurezza: se per qualunque motivo qui arrivasse una richiesta CON pagamento,
  // NON rispondiamo la sfida — sarebbe un pagante respinto. Meglio dirlo chiaramente.
  const paid = request.headers.get("x-payment") || request.headers.get("payment-signature");
  if (paid) {
    return new Response(JSON.stringify({
      error: "this edge path serves the unpaid challenge only; a request carrying payment must reach the origin",
    }), { status: 421, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return new Response(BODY, {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": PAYMENT_REQUIRED,
      // La sfida e' deterministica: si puo' cachare al bordo. TTL corto per poterla
      // cambiare in fretta se cambiano prezzo o payTo.
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-gblin-edge-challenge": "1",
      "access-control-allow-origin": "*",
    },
  });
}
