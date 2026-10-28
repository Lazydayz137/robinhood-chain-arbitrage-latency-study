// Read run.jsonl; for each accepted send, find its block via RPC_URL's receipt and the first feed arrival of
// that block (matched by blockHash when the feed carries it, else seq == block number). lag = rx - sequencer reply.
'use strict';
const fs = require('fs');
const RPC = process.env.RPC_URL;
if (!RPC) { console.error('analyze: set RPC_URL'); process.exit(2); }
const rows = fs.readFileSync(process.argv[2] || 'run.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const rx = rows.filter((r) => r.t === 'rx');
const sends = rows.filter((r) => r.t === 'send');
const bySeq = new Map(rx.map((r) => [r.seq, r]));
const byHash = new Map(rx.filter((r) => r.bh).map((r) => [r.bh.toLowerCase(), r]));
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
}
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
(async () => {
  const res = []; let pending = 0, noRx = 0, hashMatch = 0, seqMatch = 0, mismatch = 0;
  for (const s of sends) {
    if (!s.hash) continue;
    const rc = await rpc('eth_getTransactionReceipt', [s.hash]);
    if (!rc) { pending++; continue; }
    const b = parseInt(rc.blockNumber, 16);
    let r = byHash.get(rc.blockHash.toLowerCase());
    if (r) hashMatch++;
    else { r = bySeq.get(b); if (r) { seqMatch++; if (r.bh && r.bh.toLowerCase() !== rc.blockHash.toLowerCase()) mismatch++; } }
    const prev = r ? bySeq.get(r.seq - 1) : null;
    if (!r) { noRx++; continue; }
    res.push({ i: s.i, block: b, idx: parseInt(rc.transactionIndex, 16), status: rc.status,
      post_to_reply: s.reply - s.post, lag: r.rx - s.reply, prev_rx_minus_post: prev ? prev.rx - s.post : null });
  }
  const lags = res.map((x) => x.lag);
  const intervals = []; const seqs = rx.map((r) => r.seq).sort((a, b) => a - b);
  console.log(JSON.stringify({ sends: sends.length, accepted: sends.filter((s) => s.hash).length,
    errors: sends.filter((s) => s.err).map((s) => s.err).slice(0, 5), receipts_pending: pending, no_rx_for_block: noRx,
    matched_by_blockHash: hashMatch, matched_by_seq: seqMatch, seq_hash_mismatch: mismatch,
    rx_seq_range: [seqs[0], seqs[seqs.length - 1]], rx_unique: seqs.length,
    lag_ms: { n: lags.length, min: pct(lags, 0), p10: pct(lags, 0.1), p50: pct(lags, 0.5), p90: pct(lags, 0.9), max: pct(lags, 0.999) },
    post_to_reply_ms_p50: pct(res.map((x) => x.post_to_reply), 0.5),
    rows: res }, null, 0));
})();
