// Hybrid: S1 "pyramid the flyer" as the primary strategy, plus two filler tiers that use the position
// slots S1 leaves idle, so the final 4-hour window cannot fall under the 80-fill / 10-coin guardrail.
//
//   tier 1  S1  reserve +150 %/30 slots + >= 20 buyers  -> pyramid 8 adds, 15 % reserve trail
//   tier 2  S5  reserve +250 %/30 slots, buyers < 20    -> same pyramid and trail (the buyer filter's
//                                                          rejects: still a burst, still pyramided)
//   tier 3  rot freshly created coins, hold ROTATION_HOLD_SLOTS, 0.05 SOL, once per coin — only while
//               at least two position slots are free, so S1 always has room.
//
// Every tier shares the hard rules: strip-only TypeScript, no clock and no randomness, stdout carries
// the protocol only (diagnostics go to stderr via console.error), at most caps.max_orders_per_batch
// orders per reply, buys sized at 90 % of the 1 %-of-real-reserve cap, transaction fees charged against
// free cash as each order is appended, and the harness's own `_complete_` / `_flatten_` / `_writeoff_`
// closes are never mistaken for this bot's sells.
import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/agentfun-bot.ts';

const BPS = 10_000n;

const WINDOW_SLOTS = 30;
/** tier 1 — S1's thresholds. */
const S1_GROWTH_PCT = 150n;
const S1_MIN_BUYERS = 20;
/** tier 2 — S5's looser burst, for the coins the buyer filter throws away. */
const S5_GROWTH_PCT = 250n;
/** tier 3 — rotation filler. Set ROTATION_HOLD_SLOTS to 0 to switch the rotation tier off. */
const ROTATION_HOLD_SLOTS = 15;

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
const MAX_ENTRIES_PER_MINT = 20;
const MIN_SLOTS_BETWEEN_ENTRIES = 10;
/** Pyramid: at most 8 adds, each 1 % of rq, on +500 bps over the last buy. */
const MAX_ADDS = 8;
const ADD_RISE_BPS = 500n;
const ADD_SHARE_BPS = 100n;
/** Exit: sell when rq <= 85 % of the peak since entry, or after 6,000 slots. */
const TRAIL_PCT = 15n;
const SAFETY_HOLD_SLOTS = 6_000;
/** 90 % of the reported cap: it is read from recorded reserves and can be stale. */
const SIZE_NUM = 9n;
const SIZE_DEN = 10n;
const MAX_SLIPPAGE_BPS = 10_000;
/** Curve fees, from the kit's fallback (and the dataset's usual schedule): 95 bps protocol, 30 creator. */
const PROTOCOL_FEE_BPS = 95n;
const CREATOR_FEE_BPS = 30n;
/** The rotation tier keeps this many slots free for S1 entries that arrive later. */
const ROTATION_MIN_FREE_SLOTS = 2;

type Kind = 'burst' | 'rotate';

interface Holding {
  kind: Kind;
  entrySlot: number;
  /** Best real SOL reserve since entry; 0n until the first exit evaluation. */
  peakRq: bigint;
  /** Price at the last buy — the pyramid's baseline. */
  lastBuyPrice: bigint;
  adds: number;
  /** Slot hold for the rotation tier. */
  holdSlots: number;
}

interface Tick {
  slot: number;
  rq: bigint;
}

const reservePath = new Map<string, Tick[]>();
const buyerSet = new Map<string, Set<string>>();
const entryCount = new Map<string, number>();
const lastEntrySlot = new Map<string, number>();
const holding = new Map<string, Holding>();
/** Fresh curves seen through a CreateEvent and not bought yet (the rotation tier's queue). */
const freshCoins = new Set<string>();
const stats = { orders: 0, s1: 0, s5: 0, rotate: 0, adds: 0, sells: 0, slices: 0 };
/** Diagnostics: why the market refused an order (no cash is spent on a rejection, but the slot is lost). */
const rejects = new Map<string, number>();

function priceOf(vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (vq * LAMPORTS_PER_SOL) / vt;
}

/**
 * The largest slice of `tokens` the market will take in one sell order.
 *
 * A sell is rejected `max_order_size` when its curve output exceeds the curve's real SOL reserve
 * (vq - rq is the curve's fixed virtual headroom, 30 SOL on pump.fun). Selling t tokens outputs
 * t * vq / (vt + t), so the largest safe t solves t * (vq - rq) <= rq * vt. Using the recorded
 * reserves (not the exit-shifted ones) keeps the slice on the safe side.
 */
function maxSellable(tokens: bigint, rq: bigint, vq: bigint, vt: bigint): bigint {
  const headroom = vq - rq;
  if (headroom <= 0n) return 0n;
  const limit = (rq * vt) / headroom;
  return tokens < limit ? tokens : limit;
}

/**
 * What a sell of `tokens` would return, curve fees included, on the recorded reserves. A slice that
 * estimates to nothing is not sent at all: the order would come back rejected `zero_amount` and the
 * position would be re-tried on every batch of a dead coin.
 */
function estimateProceeds(tokens: bigint, rq: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  if (q <= 0n) return 0n;
  const protocol = (q * PROTOCOL_FEE_BPS + BPS - 1n) / BPS;
  const creator = (q * CREATOR_FEE_BPS + BPS - 1n) / BPS;
  return q - protocol - creator;
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const maxOrders = caps.max_orders_per_batch;
    const orders: OrderInput[] = [];
    /** The size of a first buy on `mint`: min(0.05 SOL, 90 % of the 1 %-of-real-reserve cap), or 0n. */
    const entryAmount = (mint: string): bigint => {
      let amount = (state.maxBuyLamports(mint) * SIZE_NUM) / SIZE_DEN;
      if (amount > STAKE_LAMPORTS) amount = STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) return 0n;
      return amount;
    };
    for (const f of batch.fills) {
      if (f.status === 'rejected') {
        const key = `${f.side}:${f.reason ?? 'unknown'}`;
        rejects.set(key, (rejects.get(key) ?? 0) + 1);
      }
    }

    // ---- 0. fold this batch's events in: the reserve path (for the bursts), the buyer set, the queue
    // of fresh coins (for the rotation tier).
    const mintsThisBatch = new Set<string>();
    const eventMints: string[] = [];
    const windowStart = batch.slot - WINDOW_SLOTS;
    for (const e of batch.events) {
      if (!mintsThisBatch.has(e.mint)) {
        mintsThisBatch.add(e.mint);
        eventMints.push(e.mint);
      }
      if (e.event === 'CreateEvent') {
        freshCoins.add(e.mint);
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const rq = BigInt(e.real_quote_reserves);
      let path = reservePath.get(e.mint);
      if (path === undefined) reservePath.set(e.mint, (path = []));
      path.push({ slot: batch.slot, rq });
      let drop = 0;
      while (path.length - drop > 1 && path[drop]!.slot < windowStart) drop++;
      if (drop > 0) path.splice(0, drop);
      if (e.is_buy) {
        let buyers = buyerSet.get(e.mint);
        if (buyers === undefined) buyerSet.set(e.mint, (buyers = new Set()));
        buyers.add(e.user);
      }
    }

    // ---- 1. exits. The burst tiers use the 15 % reserve trail, the rotation tier a plain slot hold.
    const pendingSell = new Set<string>();
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      else pendingBuy.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pos.token_amount === 0n || pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let h = holding.get(mint);
      if (h === undefined) {
        h = {
          kind: 'burst',
          entrySlot: batch.slot,
          peakRq: 0n,
          lastBuyPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
          adds: 0,
          holdSlots: SAFETY_HOLD_SLOTS,
        };
        holding.set(mint, h);
      }
      const held = batch.slot - h.entrySlot;
      let exit = held >= h.holdSlots;
      if (!exit && h.kind === 'burst') {
        const rq = curve.real_quote_reserves;
        if (h.peakRq === 0n || rq > h.peakRq) h.peakRq = rq;
        exit = h.peakRq > 0n && rq * 100n <= h.peakRq * (100n - TRAIL_PCT);
      }
      if (!exit) continue;
      const slice = maxSellable(pos.token_amount, curve.real_quote_reserves, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (slice <= 0n) continue;
      const proceeds = estimateProceeds(slice, curve.real_quote_reserves, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (proceeds <= 0n) continue;
      orders.push({ side: 'sell', mint, token_amount: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      if (slice < pos.token_amount) stats.slices++;
      pendingSell.add(mint);
      stats.sells++;
    }

    let free = state.freeCashLamports() - BigInt(orders.length) * tx;

    // ---- 2. pyramid the burst positions: +1 % of rq every +500 bps over the last buy, at most 8.
    for (const [mint, pos] of state.positions) {
      if (pos.token_amount === 0n || pendingSell.has(mint)) continue;
      const h = holding.get(mint);
      if (h === undefined || h.kind !== 'burst' || h.adds >= MAX_ADDS) continue;
      if (!mintsThisBatch.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (px * BPS < h.lastBuyPrice * (BPS + ADD_RISE_BPS)) continue;
      let amount = (curve.real_quote_reserves * ADD_SHARE_BPS) / BPS;
      const capAmount = (state.maxBuyLamports(mint) * SIZE_NUM) / SIZE_DEN;
      if (amount > capAmount) amount = capAmount;
      if (amount <= 0n) continue;
      if (free < amount + tx) continue;
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      h.lastBuyPrice = px;
      h.adds += 1;
      free -= amount + tx;
      stats.adds++;
    }

    // ---- 3. entries. Slots are shared; tier 1 fills them first, then tier 2, then the rotation tier.
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const tier of ['s1', 's5'] as const) {
      if (slots <= 0) break;
      for (const mint of eventMints) {
        if (orders.length >= maxOrders || slots <= 0) break;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const made = entryCount.get(mint) ?? 0;
        if (made >= MAX_ENTRIES_PER_MINT) continue;
        const at = lastEntrySlot.get(mint);
        if (made > 0 && at !== undefined && batch.slot - at < MIN_SLOTS_BETWEEN_ENTRIES) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const path = reservePath.get(mint);
        if (path === undefined || path.length === 0) continue;
        const rq0 = path[0]!.rq;
        const rq = curve.real_quote_reserves;
        if (rq0 <= 0n) continue;
        const buyers = buyerSet.get(mint);
        const nBuyers = buyers === undefined ? 0 : buyers.size;
        if (tier === 's1') {
          if (rq * 100n < rq0 * (100n + S1_GROWTH_PCT)) continue;
          if (nBuyers < S1_MIN_BUYERS) continue;
        } else {
          // The buyer filter's rejects: a wider burst on a coin S1 would not touch.
          if (nBuyers >= S1_MIN_BUYERS) continue;
          if (rq * 100n < rq0 * (100n + S5_GROWTH_PCT)) continue;
        }
        const amount = entryAmount(mint);
        if (amount === 0n) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryCount.set(mint, made + 1);
        lastEntrySlot.set(mint, batch.slot);
        holding.set(mint, {
          kind: 'burst',
          entrySlot: batch.slot,
          peakRq: 0n,
          lastBuyPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
          adds: 0,
          holdSlots: SAFETY_HOLD_SLOTS,
        });
        free -= amount + tx;
        slots -= 1;
        if (tier === 's1') stats.s1++;
        else stats.s5++;
      }
    }

    // ---- tier 3: rotation on newly created coins, only while at least two slots stay free.
    if (ROTATION_HOLD_SLOTS > 0 && slots >= ROTATION_MIN_FREE_SLOTS) {
      for (const mint of eventMints) {
        if (orders.length >= maxOrders || slots < ROTATION_MIN_FREE_SLOTS) break;
        if (!freshCoins.has(mint)) continue;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        if (curve.complete) {
          freshCoins.delete(mint);
          continue;
        }
        const amount = entryAmount(mint);
        if (amount === 0n) continue;
        if (free < amount + tx) continue;
        freshCoins.delete(mint);
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryCount.set(mint, (entryCount.get(mint) ?? 0) + 1);
        lastEntrySlot.set(mint, batch.slot);
        holding.set(mint, {
          kind: 'rotate',
          entrySlot: batch.slot,
          peakRq: 0n,
          lastBuyPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
          adds: 0,
          holdSlots: ROTATION_HOLD_SLOTS,
        });
        free -= amount + tx;
        slots -= 1;
        stats.rotate++;
      }
    }

    stats.orders += orders.length;
    return orders;
  },
  onDone(state, done) {
    console.error(
      `hybrid done: orders=${stats.orders} s1=${stats.s1} s5=${stats.s5} rotate=${stats.rotate} adds=${stats.adds} sells=${stats.sells} slices=${stats.slices} cash=${state.cash} reason=${done.reason} rejects=${JSON.stringify([...rejects])}`,
    );
  },
});
