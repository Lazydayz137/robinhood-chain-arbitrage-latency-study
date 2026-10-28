// Feed lag test (read: one feed connection; write: N zero-value self-transfers from your own EOA).
// Seal-time reference = sequencer's eth_sendRawTransaction reply (Nitro replies after the tx's block is executed).
// Never prints the feed URL or the key. No reconnect: any close/error ends the run.
// Config (env): FEED_URL (required), RPC_URL (required), PRIVATE_KEY (required unless DRY=1),
// SEQUENCER_URL, CHAIN_ID, OUT, N_SENDS, GAP_MS, WARMUP_MS, HARD_STOP_MS, DRY, KEYCHECK.
'use strict';
const fs = require('fs');
const WebSocket = require('ws');
const { privateKeyToAccount } = require('viem/accounts');

const RPC = process.env.RPC_URL;
const SEQ = process.env.SEQUENCER_URL || 'https://sequencer.mainnet.chain.robinhood.com';
const CHAIN_ID = +(process.env.CHAIN_ID || 4663);
const N_SENDS = +(process.env.N_SENDS || 40);
const GAP_MS = +(process.env.GAP_MS || 15000);
const WARMUP_MS = +(process.env.WARMUP_MS || 20000);
const HARD_STOP_MS = +(process.env.HARD_STOP_MS || 12 * 60 * 1000);
const DRY = process.env.DRY === '1';
const OUT = process.env.OUT || 'run.jsonl';

const out = fs.createWriteStream(OUT, { flags: 'a' });
const log = (o) => out.write(JSON.stringify(o) + '\n');
const say = (s) => console.log(`lagtest: ${s}`);

function unitEnv() {
  const feed = process.env.FEED_URL || null;
  const pk = process.env.PRIVATE_KEY;
  const key = pk ? privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk) : null;
  return { feed, key };
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}

(async () => {
  const { feed, key } = unitEnv();
  if (!feed) { say('ABORT no FEED_URL'); process.exit(2); }
  if (!RPC) { say('ABORT no RPC_URL'); process.exit(2); }
  if (!key && !DRY) { say('ABORT no PRIVATE_KEY'); process.exit(2); }
  const SELF = key ? key.address : '0x0000000000000000000000000000000000000000';
  say(`feed host=${new URL(feed).host} key=${key ? 'loaded' : 'none (dry)'} sends=${DRY ? 0 : N_SENDS}`);
  if (process.env.KEYCHECK === '1') process.exit(0);

  const chainId = parseInt((await rpc(RPC, 'eth_chainId', [])).result, 16);
  let nonce = parseInt((await rpc(RPC, 'eth_getTransactionCount', [SELF, 'latest'])).result, 16);
  const blk = (await rpc(RPC, 'eth_getBlockByNumber', ['latest', false])).result;
  const maxFee = BigInt(blk.baseFeePerGas) * 3n;
  say(`chainId=${chainId} nonce=${nonce} maxFee=${maxFee}`);
  if (chainId !== CHAIN_ID) { say('ABORT wrong chain'); process.exit(2); }
  await rpc(SEQ, 'eth_chainId', []).catch(() => {}); // warm TLS to the sequencer

  const seen = new Set();
  let frames = 0, msgs = 0, done = false;
  const t0 = Date.now();
  const ws = new WebSocket(feed, { perMessageDeflate: true, maxPayload: 64 * 1024 * 1024, handshakeTimeout: 15000 });
  const finish = (why) => {
    if (done) return; done = true;
    say(`end: ${why} frames=${frames} msgs=${msgs} uniqueSeq=${seen.size} secs=${((Date.now() - t0) / 1000).toFixed(0)}`);
    log({ t: 'end', why, frames, msgs, uniq: seen.size, ms: Date.now() });
    try { ws.terminate(); } catch {}
    out.end(() => process.exit(0));
  };
  setTimeout(() => finish('hard stop'), HARD_STOP_MS);
  ws.on('open', () => { say('connected'); log({ t: 'open', ms: Date.now() }); });
  ws.on('error', (e) => { say(`ws error ${String(e.message).replace(/wss?:\/\/\S+/g, '<url>')}`); finish('error'); });
  ws.on('close', (c) => finish(`close ${c}`));
  ws.on('message', (data) => {
    const rx = Date.now();
    frames++;
    let j; try { j = JSON.parse(data.toString()); } catch { return; }
    for (const m of j.messages || []) {
      msgs++;
      const s = m.sequenceNumber;
      if (s === undefined || seen.has(s)) continue;
      seen.add(s);
      log({ t: 'rx', seq: s, rx, bh: m.blockHash || null, n: (j.messages || []).length });
    }
  });

  await new Promise((r) => setTimeout(r, WARMUP_MS));
  for (let i = 0; i < (DRY ? 0 : N_SENDS) && !done; i++) {
    const raw = await key.signTransaction({ chainId, type: 'eip1559', to: SELF, value: 0n, gas: 21000n,
      maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n, nonce });
    const post = Date.now();
    let res; try { res = await rpc(SEQ, 'eth_sendRawTransaction', [raw]); } catch (e) { res = { error: { message: String(e.message) } }; }
    const reply = Date.now();
    const err = res.error ? String(res.error.message).slice(0, 160) : null;
    log({ t: 'send', i, nonce, post, reply, hash: res.result || null, err });
    if (res.result) nonce++;
    else {
      const st = err && err.match(/state:?\s*(\d+)/);
      if (st) nonce = +st[1];
      say(`send ${i} err ${err}`);
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  await new Promise((r) => setTimeout(r, 5000));
  finish('sends complete');
})().catch((e) => { say(`fatal ${String(e.message).replace(/wss?:\/\/\S+/g, '<url>')}`); process.exit(1); });
