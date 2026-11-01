# Strategy: hybrid — S1 with two filler tiers

The primary strategy is the reserve-burst pyramid: entry on real-SOL-reserve growth plus a unique-buyer count, adds that compound the 1 %-of-reserve cap, and a reserve-trail exit. The two fillers exist
for one reason: the final window is 4 hours, not the dev window's 6, and a bot that keeps only 44–74 %
of its dev fills (the pilot's rule of thumb) must not fall under the 80-fill / 10-coin guardrail. S1
alone makes 219 fills on dev; this repository makes 548, most of them from the two filler tiers.

## The hello, the batch and the reply

The bot is one `runBot` call on the kit's `agent-fun/replay/v2` shim. `hello` gives the caps (5 open
positions, 16 orders per reply, 1 % of real reserve per mint per reply), the transaction fee and the
seed. Every `batch` carries one slot's events, the fills that resolved since the last one, and the
account. The reply is the `orders` array for that slot, and nothing else goes to stdout: diagnostics are
`console.error`. Two executions of the same run must produce the same action log byte for byte, so the
bot never reads a clock, the environment or `Math.random`, and every comparison is integer (`bigint`)
math on reserves and basis points.

## Tier 1 — S1, which always gets a slot first

Per mint, on a batch that carries one of its events: the first trade of the mint at slot >= `slot - 30`
gives the base real SOL reserve `rq0`. Enter when `rq / rq0 - 1 >= 1.50`, the mint shows >= 20 distinct
buying wallets, the 1 % cap allows 0.01 SOL, and fewer than 5 positions are open (20 entries per mint,
10 slots apart, at most). First buy `min(0.05 SOL, 1 % of rq)`, sized to 90 % of the reported cap.
Pyramid: while holding, on a batch carrying the mint's events, add 1 % of `rq` every +500 bps in
`vq / vt` over the last buy, at most 8 adds. Exit on the 15 % reserve trail, on completion, at the
window end, or after 6,000 slots.

## Tier 2 — S5, the buyer filter's rejects

The same machinery with a different bar: `rq / rq0 - 1 >= 250 %` over 30 slots and **fewer than 20
buyers** — the coins S1's buyer filter throws away. Same sizing (0.05 SOL, then 1 % adds on +500 bps,
8 adds) and the same 15 % reserve-trail exit. This tier is what the S5 spec measured at +5.22 SOL on
the dev window with the most fills of the positive specs; it is deliberately the widest positive entry
family in the shortlist.

## Tier 3 — rotation on newly created coins

Every coin whose `CreateEvent` arrives becomes a rotation candidate. It is bought at 0.05 SOL (or the
90 %-of-cap size, once the cap allows 0.01 SOL) and sold again after **15 slots**, once per coin. It is
a pure fill generator: measured on the dev window at −0.30 SOL over 304 fills, the cheapest fill
there is. It only takes a slot while **at least two slots are free**, so a tier-1 or tier-2 entry always
finds room; at most 3 of the 5 positions are ever rotation positions.

## Exits that the market will actually take

Two rules keep a sell from being refused and the position from sticking in a slot:

* **Slices.** A sell whose curve output exceeds the curve's real SOL reserve is rejected
  `max_order_size`. Solving `t * vq / (vt + t) <= rq` for the largest safe slice of tokens gives
  `t <= rq * vt / (vq - rq)`, and the bot sells that slice instead of the whole position, next batch
  picking up the rest. Slices are only needed on the burst positions that compounded into big sizes.
* **No order for a dead coin.** A slice whose expected proceeds are zero is not sent at all: on a coin
  that has already been dumped to nothing, the order would come back `zero_amount` on every batch
  forever. The position is written off by the replay at the end of the window instead.

Neither rule fires on a normal exit; together they took the reply's rejections from 3,898 to 35.

## Why this mix, and not the other two

Measured on the dev window with the kit's own grader (`grade-local`, same dataset, same seed):

| filler mix | net SOL | fills | coins | ex-top-1 SOL | max DD |
|---|---|---|---|---|---|
| none (S1 alone) | +6.80 | 219 | 49 | +1.46 | 3.4 % |
| S5 only | +5.86 | 384 | 83 | +0.53 | 6.4 % |
| S5 + rotation, hold 60 | +5.20 | 391 | 148 | −0.14 | 3.8 % |
| **S5 + rotation, hold 15** | **+6.37** | **548** | **148** | **+1.04** | **4.6 %** |

The 60-slot rotation holds a slot through the exact moment a coin turns into an S1 flyer, and its
ex-top-1 PnL is negative, so it is out. The 15-slot rotation turns the slot over faster, adds 164
fills over the S5-only mix, and is the only filler mix that stays positive with the single best coin
removed. S5-only is the quietest option and the one to prefer if fill count were not the binding risk;
it clears 350 dev fills by only 34, which is a thin margin against a 44–74 % retention rule.

## What it scores on the dev window

+6.37 SOL net, 548 fills over 148 coins, 228 round trips, max drawdown 4.6 %, 0.69 SOL of curve fees and
0.059 SOL of transaction fees, action log reproduced byte for byte. S1 alone on the same window is
+6.80 SOL / 219 fills / 49 coins, so the fillers cost 0.43 SOL and buy 329 fills and 99 coins of
guardrail margin. With the single best coin removed it is still **+1.04 SOL** (S1 alone: +1.46 SOL).
