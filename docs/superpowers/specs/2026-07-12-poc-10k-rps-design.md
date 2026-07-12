# POC: Ledger at 10,000 RPS — Design

**Date:** 2026-07-12
**Status:** Approved
**Scope:** `poc/` only (proof of concept; not the published library under `src/`)

## Goal

Prove the Redis-backed ledger design can sustain **10,000 ledger operations per second for 60 seconds** from a single Bun process against a single Redis instance, with:

- Achieved throughput ≥ 99% of target
- Success rate ≥ 99.9%
- p99 latency < 50ms per operation
- A mixed workload: a few hot accounts plus many cold accounts

## Why the current POC cannot do this

1. **`addEntry` costs 3 sequential Redis round-trips** (`HEXISTS` → `HLEN` → `MULTI`). At 10k ops/sec that is 30k+ serialized round-trips/sec through one call path.
2. **The dedup and limit checks are racy.** Two concurrent adds with the same id can both pass `hExists` before either writes; `removeEntry` can decrement totals for an entry another caller already deleted.
3. **`benchmark.ts` cannot generate 10k RPS.** Its pacing loop awaits `Bun.sleep(1000/rps)` per op; timer resolution (~1ms) caps the driver near 1k ops/sec regardless of ledger speed.

## Approach (chosen: atomic Lua scripts)

Considered and rejected:

- **Plain commands with relaxed checks** (HSETNX dedup + MULTI totals, lazy limit check): fewer moving parts, but totals can drift on crash and the limit becomes approximate — weaker guarantees on the component whose guarantees are the point.
- **Client-side micro-batching** (queue ops per tick, flush as one pipeline): highest ceiling but changes API semantics and adds complexity 10k RPS does not need.

Chosen: move each write into **one atomic Lua script call** — 1 round-trip per op, races eliminated, public API unchanged.

## Files

Follow the existing one-file-per-iteration convention (`ledger.ts` → `ledger-optimized.ts` → …). Existing files stay untouched so prior results remain comparable.

- `poc/ledger-10k.ts` — new ledger implementation; same public API and exported types as `ledger-optimized.ts`
- `poc/benchmark-10k.ts` — high-rate benchmark importing from `ledger-10k.ts`
- `poc/result.benchmark-10k.<date>.md` — saved benchmark output (per existing convention)

## Ledger design (`poc/ledger-10k.ts`)

### Keys (unchanged)

- `ledger:{accountId}:{currency}` — hash of entryId → entry JSON
- `ledger:{accountId}:{currency}:total` — running total (string number)
- `ledger:{accountId}:{currency}:ctx` — hash of context → running subtotal

### Lua scripts

Loaded once at startup via `SCRIPT LOAD`, invoked per call with `EVALSHA`, falling back to `EVAL` on `NOSCRIPT` (the script cache is server-global, so one load covers the whole pool). Both scripts operate only on keys derived from one `{accountId, currency}` pair, so they are single-node safe.

**ADD** — KEYS: hash, total, ctx; ARGV: entryId, entryJson, amount, context, maxEntries

1. `HEXISTS hash entryId` → if 1, return `"DUP"`
2. `HLEN hash` → if ≥ maxEntries, return `"LIMIT"`
3. `HSET hash entryId entryJson`
4. `INCRBYFLOAT total amount`
5. `HINCRBYFLOAT ctx context amount`
6. return `"OK"`

**REMOVE** — KEYS: hash, total, ctx; ARGV: entryId

1. `HGET hash entryId` → if nil, return `0`
2. `cjson.decode` the stored JSON to read `amount` and `context`
3. `HDEL hash entryId`
4. `INCRBYFLOAT total -amount`
5. `HINCRBYFLOAT ctx context -amount`
6. return `1`

### TypeScript wrappers

- `addEntry` maps `"DUP"` → `Error("Duplicate entry: entry with id '<id>' already exists")` and `"LIMIT"` → `Error("Ledger limit reached: maximum <n> entries per account/currency")` — identical messages to `ledger-optimized.ts`.
- `removeEntry` returns `boolean` as today.
- Reads are unchanged in design (already O(1)): `getEntry`, `getSum`, `getBalance`, `getEntriesPaginated`, `getAllEntries`, `clearLedger`.

### Connections

A round-robin pool of plain node-redis clients, size `LEDGER_POOL_SIZE` (default 4). Auto-pipelining on a single connection likely satisfies raw throughput; the pool exists to smooth p99 tail latency. Scripts are defined on every client. `redis` export remains (first pool client) for compatibility with existing import patterns; a `quit()`/`disconnectAll` helper closes the whole pool.

### Inherited caveat (out of scope)

`INCRBYFLOAT`/`HINCRBYFLOAT` use floating point for money amounts. This precision trade-off exists in `ledger-optimized.ts` today and is unchanged here. A production version would use integer minor units; not part of this POC.

## Benchmark design (`poc/benchmark-10k.ts`)

### Load generation

Open-loop, self-correcting scheduler:

- Tick every ~10ms.
- Each tick fires `floor(elapsedSeconds × targetRps) − alreadyFired` operations without awaiting them.
- This hits the target rate regardless of timer jitter and keeps firing when Redis lags (open-loop), so the benchmark measures the ledger rather than adapting to it.

### Workload mix (env-configurable, defaults shown)

- **Operation accounting:** the target RPS counts individual ledger operations (an add and a remove each count as one). The scheduler fires add→remove **pairs** at `targetRps / 2` pairs per second, so a 10,000 RPS level completes 10,000 ledger operations per second.
- `HOT_ACCOUNTS=5` hot accounts receive `HOT_TRAFFIC_SHARE=50%` of operations
- `COLD_ACCOUNTS=500` cold accounts share the remainder uniformly
- Each pair adds then removes the same entry (keeps hash sizes bounded across a 60s run)
- `READ_RATIO=5%` of operations additionally issue a `getBalance` on the chosen account
- RPS levels ramp `1000 → 5000 → 10000` (`RPS_LEVELS` env), 60s each (`DURATION_S`), 5s cooldown between levels

### Metrics

Per level: per-op-type (add / remove / read) p50, p95, p99, max, min, avg; achieved RPS vs target; success and failure counts; unique error messages with counts; in-flight high-water mark (backpressure signal); heap/RSS start, peak, end.

### Verdict

Each level ends with an explicit **PASS/FAIL** line evaluated against:

- achieved RPS ≥ 99% of target
- success rate ≥ 99.9%
- p99 < 50ms (add and remove; reads reported but not gated)

The run's summary repeats the verdict per level. The POC is "proven" when the 10,000 RPS level passes.

## Error handling

- The benchmark never crashes on an operation failure: errors are caught per op, counted by message, and reported.
- The ledger throws typed `Error`s with the same messages as `ledger-optimized.ts`; connection-level failures propagate to the caller (benchmark counts them).

## Verification

1. **Correctness demo** (`import.meta.main` block in `ledger-10k.ts`):
   - Basic add/sum/balance/paginate/clear flow (as in `ledger-optimized.ts`).
   - **Atomicity check:** fire N concurrent `addEntry` calls with the *same id* — exactly one must succeed, the rest must throw `Duplicate entry`.
   - **Consistency check:** a concurrent storm of equal adds and removes must leave `getSum` exactly `"0"` and the entry hash empty.
2. **Benchmark run** against local Redis (`REDIS_URL`), output saved to `poc/result.benchmark-10k.<date>.md`.

## Out of scope

- Changes to `src/` (the published library)
- Redis Cluster / sharding across instances
- Integer minor-unit amounts (precision fix)
- HTTP service layer in front of the ledger
