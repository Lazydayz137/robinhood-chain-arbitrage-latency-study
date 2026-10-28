# Robinhood Chain feed lag test

A small, self-contained tool that answers one question: **when a block is sealed on Robinhood Chain, how long does your feed take to deliver it to you?**

It comes out of a study by Longstreet Labs. We built a cross-venue arbitrage bot for Robinhood Chain, ran it live, and shelved it after this test showed the bottleneck was feed delivery, not our code. The bot stays private. The measurement is public so anyone can rerun it against a feed of their own.

## The chain, in one paragraph

Robinhood Chain (chain ID 4663) is an Arbitrum Nitro chain with ~0.1 s blocks, first-come-first-served ordering, a priority fee of 0, and no Timeboost, Fast Feed or public pending-transaction feed. The sequencer feed broadcasts **sealed blocks only**, and each block's queue is drained before it executes. `eth_sendRawTransaction` to the sequencer replies **after the transaction's block has executed**, which is what makes the measurement below possible.

## Method

1. Open one WebSocket connection to the feed under test and log every message with a local receive timestamp.
2. After a warm-up, send N zero-value self-transfers (default 40, one every 15 s) straight to the sequencer and record when each `eth_sendRawTransaction` call was posted and when it replied.
3. Afterwards, look up each transaction's receipt and match its block to the feed message carrying it (by `blockHash`, falling back to sequence number).

Two numbers fall out per send:

- **lag** = time the feed delivered *our* block − time the sequencer replied. The sequencer's reply is the seal-time reference.
- **prev_rx_minus_post** = time the feed delivered the block *before* ours − time we posted. If this is usually **negative**, the feed tells you about block T before block T+1 is sealed, so you can react to T and land in T+1. If it is positive, you were blind to T when T+1 closed.

**Pass criterion:** the block before ours arrives before we post, most of the time.

## Our result (2026-10-08, one third-party feed, us-east-2)

| | |
|---|---|
| sends | 40, all matched to a feed message by blockHash (40/40) |
| feed delivers our block after the sequencer's reply | p10 83 ms / **p50 94 ms** / p90 138 ms / max 630 ms |
| feed delivers the *previous* block after we posted | 24 to 534 ms late, p50 89 ms |
| previous block delivered **before** we posted | **0 of 40** |
| cost | 0.0000194 ETH gas |

So reacting to block T through that feed lands in T+2 at best. Our own reaction (feed message in → transaction posted) was ~10-30 ms; it did not matter. To compete for next-block opportunities you need a feed within a few tens of ms of seal. Same-block opportunities need access before sequencing.

## Run it against your feed

You need Node 20+, an RPC endpoint for Robinhood Chain (nonce, base fee, receipts), the feed URL you want to test, and a funded key for a throwaway account (40 sends cost well under 0.0001 ETH).

```bash
npm install
# check config without connecting or sending
FEED_URL=wss://... RPC_URL=https://... PRIVATE_KEY=0x... KEYCHECK=1 npm run lagtest
# real run: ~10 min, writes run.jsonl
FEED_URL=wss://... RPC_URL=https://... PRIVATE_KEY=0x... npm run lagtest
# results
RPC_URL=https://... npm run analyze -- run.jsonl
```

Optional env: `SEQUENCER_URL` (default: Robinhood Chain's public sequencer), `CHAIN_ID` (default 4663), `OUT`, `N_SENDS`, `GAP_MS`, `WARMUP_MS`, `HARD_STOP_MS`, `DRY=1` (feed only, no sends).

Please be a good citizen: the test opens a single feed connection and sends one transaction every 15 s. Don't scale it up against public infrastructure.

## Share your numbers

If you have a feed that might pass (your own node, a co-located relay, a vendor), run it and open an issue with:

- the `lag_ms` block from `analyze` output, plus the `lag` and `prev_rx_minus_post` value of each entry in `rows`
- where you ran from (region / provider) and what kind of feed it is (you don't have to name a vendor)

`rows` also carries block numbers that point to your sending address. Drop the `block` field if you'd rather not share that.

## License

MIT
