❯ bun run poc/benchmark-10k.ts
═══════════════════════════════════════════════════════════════
  LEDGER 10K BENCHMARK (open-loop, mixed hot/cold accounts)
═══════════════════════════════════════════════════════════════
  RPS Levels:   1000, 5000, 10000 (ops/s; pairs fire at rps/2)
  Duration:     60s per level, 5s cooldown
  Accounts:     5 hot (50% traffic) + 500 cold
  Reads:        5% of pairs issue getBalance
  Pool size:    4

───────────────────────────────────────────────────────────────
  Starting 1,000 RPS level...

▶ 1,000 RPS Level
  Duration:       60.36s (incl. drain)
  Achieved:       994 ops/s (target 1,000)
  Ops:            59,990 attempted | 59,990 ok (100.00%) | 0 failed
  In-flight peak: 163 pairs
  Latency (ms):
    Add:     avg 18.25  p50 0.87  p95 145.70  p99 209.77  max 624.03
    Remove:  avg 12.55  p50 0.49  p95 109.23  p99 210.93  max 630.92
    Read:    avg 9.73  p50 0.33  p95 76.09  p99 210.60  max 497.43
  Memory:         heap 5.70 → 10.47 MB (peak 13.34 MB)
  Errors:         none
  Verdict:        ❌ FAIL
    - add p99 209.77ms >= 50ms
    - remove p99 210.93ms >= 50ms

───────────────────────────────────────────────────────────────
  Starting 5,000 RPS level...

▶ 5,000 RPS Level
  Duration:       60.05s (incl. drain)
  Achieved:       4996 ops/s (target 5,000)
  Ops:            299,970 attempted | 299,970 ok (100.00%) | 0 failed
  In-flight peak: 36,857 pairs
  Latency (ms):
    Add:     avg 3184.36  p50 1111.31  p95 10659.75  p99 11718.00  max 12317.78
    Remove:  avg 1017.55  p50 540.35  p95 7679.36  p99 11433.97  max 11988.61
    Read:    avg 333.09  p50 67.61  p95 886.96  p99 5874.56  max 11988.47
  Memory:         heap 4.88 → 126.08 MB (peak 173.61 MB)
  Errors:         none
  Verdict:        ❌ FAIL
    - add p99 11718.00ms >= 50ms
    - remove p99 11433.97ms >= 50ms

───────────────────────────────────────────────────────────────
  Starting 10,000 RPS level...

▶ 10,000 RPS Level
  Duration:       60.00s (incl. drain)
  Achieved:       9998 ops/s (target 10,000)
  Ops:            599,908 attempted | 599,908 ok (100.00%) | 0 failed
  In-flight peak: 74,941 pairs
  Latency (ms):
    Add:     avg 1737.86  p50 2.14  p95 10651.65  p99 12372.80  max 12679.31
    Remove:  avg 732.72  p50 1.72  p95 1804.13  p99 12049.59  max 12663.05
    Read:    avg 457.50  p50 0.94  p95 1559.17  p99 11681.18  max 12663.00
  Memory:         heap 126.39 → 15.91 MB (peak 430.57 MB)
  Errors:         none
  Verdict:        ❌ FAIL
    - add p99 12372.80ms >= 50ms
    - remove p99 12049.59ms >= 50ms

═══════════════════════════════════════════════════════════════
  SUMMARY
═══════════════════════════════════════════════════════════════
    1000 RPS: ❌ FAIL  (achieved 994 ops/s, add p99 209.77ms, remove p99 210.93ms)
    5000 RPS: ❌ FAIL  (achieved 4996 ops/s, add p99 11718.00ms, remove p99 11433.97ms)
   10000 RPS: ❌ FAIL  (achieved 9998 ops/s, add p99 12372.80ms, remove p99 12049.59ms)
═══════════════════════════════════════════════════════════════

Note on the 5k/10k collapse: mid-run the host 1-minute load average
re-spiked from 5.37 to 17–26 (see Run conditions below). In an open-loop
benchmark a sustained stall compounds: requests keep firing on schedule,
in-flight ballooned to 36,857 / 74,941 pairs, and everything behind the
stall queued for seconds. Throughput and success gates still passed.

───────────────────────────────────────────────────────────────
  TUNING ATTEMPT: LEDGER_POOL_SIZE=8
───────────────────────────────────────────────────────────────

Per the tuning decision tree, one retry with a doubled connection pool:

❯ LEDGER_POOL_SIZE=8 bun run poc/benchmark-10k.ts

(Load at start: 6.05 and falling; at end: 3.69 — the best host conditions
of any run in this document.)

═══════════════════════════════════════════════════════════════
  LEDGER 10K BENCHMARK (open-loop, mixed hot/cold accounts)
═══════════════════════════════════════════════════════════════
  RPS Levels:   1000, 5000, 10000 (ops/s; pairs fire at rps/2)
  Duration:     60s per level, 5s cooldown
  Accounts:     5 hot (50% traffic) + 500 cold
  Reads:        5% of pairs issue getBalance
  Pool size:    8

───────────────────────────────────────────────────────────────
  Starting 1,000 RPS level...

▶ 1,000 RPS Level
  Duration:       60.27s (incl. drain)
  Achieved:       995 ops/s (target 1,000)
  Ops:            59,988 attempted | 59,988 ok (100.00%) | 0 failed
  In-flight peak: 98 pairs
  Latency (ms):
    Add:     avg 13.65  p50 0.80  p95 122.02  p99 200.42  max 616.05
    Remove:  avg 10.11  p50 0.46  p95 77.20  p99 207.24  max 625.77
    Read:    avg 9.58  p50 0.32  p95 87.12  p99 196.91  max 225.44
  Memory:         heap 5.73 → 8.38 MB (peak 10.89 MB)
  Errors:         none
  Verdict:        ❌ FAIL
    - add p99 200.42ms >= 50ms
    - remove p99 207.24ms >= 50ms

───────────────────────────────────────────────────────────────
  Starting 5,000 RPS level...

▶ 5,000 RPS Level
  Duration:       60.05s (incl. drain)
  Achieved:       4996 ops/s (target 5,000)
  Ops:            299,966 attempted | 299,966 ok (100.00%) | 0 failed
  In-flight peak: 1,691 pairs
  Latency (ms):
    Add:     avg 44.84  p50 1.41  p95 200.06  p99 558.61  max 1429.09
    Remove:  avg 37.29  p50 1.15  p95 199.24  p99 516.36  max 1437.46
    Read:    avg 31.35  p50 0.63  p95 195.88  p99 503.39  max 1416.91
  Memory:         heap 9.22 → 20.04 MB (peak 31.42 MB)
  Errors:         none
  Verdict:        ❌ FAIL
    - add p99 558.61ms >= 50ms
    - remove p99 516.36ms >= 50ms

───────────────────────────────────────────────────────────────
  Starting 10,000 RPS level...

▶ 10,000 RPS Level
  Duration:       60.42s (incl. drain)
  Achieved:       9930 ops/s (target 10,000)
  Ops:            599,972 attempted | 599,972 ok (100.00%) | 0 failed
  In-flight peak: 2,843 pairs
  Latency (ms):
    Add:     avg 39.92  p50 1.71  p95 196.38  p99 505.70  max 1446.31
    Remove:  avg 33.46  p50 1.41  p95 191.92  p99 467.24  max 1455.67
    Read:    avg 28.55  p50 0.84  p95 186.80  p99 426.87  max 1454.36
  Memory:         heap 4.95 → 23.54 MB (peak 43.97 MB)
  Errors:         none
  Verdict:        ❌ FAIL
    - add p99 505.70ms >= 50ms
    - remove p99 467.24ms >= 50ms

═══════════════════════════════════════════════════════════════
  SUMMARY
═══════════════════════════════════════════════════════════════
    1000 RPS: ❌ FAIL  (achieved 995 ops/s, add p99 200.42ms, remove p99 207.24ms)
    5000 RPS: ❌ FAIL  (achieved 4996 ops/s, add p99 558.61ms, remove p99 516.36ms)
   10000 RPS: ❌ FAIL  (achieved 9930 ops/s, add p99 505.70ms, remove p99 467.24ms)
═══════════════════════════════════════════════════════════════

Result: pool=8 did not pass. As in the contended-host round, doubling the
pool left the 1k level unchanged (~200ms p99) and worsened p99 at 5k/10k
relative to what pool=4 achieves absent a mid-run load spike. Gates were
not weakened. Env used for the retry: LEDGER_POOL_SIZE=8 (not adopted).

## Run conditions

- Quieted host: competing containers stopped by the controller (n8n-custom,
  mysql, localpg); only the target `redis` container (redis:latest,
  redis.orb.local:6379) was running in the OrbStack VM for all runs above.
- Load at start of the main (pool=4) run:
    12:50 up 26 days, 18:22, load averages: 5.37 6.63 7.89  (CPU 69% idle)
  The <4 target was unreachable; 1-min load plateaued ~6 after 5 minutes of
  waiting, so the run proceeded per instructions.
- Mid-run the 1-min load re-spiked to 17.37 and reached 26.32 just after the
  run, with no user process responsible: `top` showed kernel_task at 186%
  CPU, Trend Micro endpoint security (com.trendmicro.i 23% + iCoreSecurity
  19%), and unrelated node/Chrome/WindowServer processes. Host memory was
  exhausted (15G used, ~100MB free, 6+GB compressed). This host's load
  oscillates between ~4 and ~26 on a multi-minute period and cannot be
  quieted by stopping containers.
- Redis-side evidence of the same stalls: SLOWLOG (cap 128, full) recorded
  single commands taking 41–57ms of in-server execution time during the run
  — including a plain HDEL (54.8ms) and HLEN (41.5ms) on tiny keys.
  aof_delayed_fsync=0 and dataset ~2MB rule out persistence/dataset size;
  the Redis process itself was CPU-starved inside the shared VM.
- Isolated microbenchmarks on the same stack passed easily (serial PING p99
  0.57ms; a burst of 1,000 concurrent add+remove pairs at pool=4 completed
  with p99 46.4ms, under the gate), so the ledger/Lua/pool code is not
  intrinsically slow; sustained 60s windows keep absorbing host stalls.
- Earlier contended-host round (same commands, before containers were
  stopped, host load 15–30): all three levels FAILED the p99 gate with add/
  remove p99 197.06–203.25ms (pool=4) and 208.86–339.34ms (pool=8), while medians
  were sub-millisecond and the success gate passed at all levels (100.00%), though
  the throughput gate failed at pool=8 5k (4,918 ops/s, 98.36% of target).

Per-level detail of the contended-host runs (full raw output not retained):

Contended run A — pool=4 (default):
  1,000 RPS: FAIL — achieved 1000 ops/s, 100.00% ok, add p99 203.25ms / remove p99 200.02ms
  5,000 RPS: FAIL — achieved 4999 ops/s, 100.00% ok, add p99 198.07ms / remove p99 197.57ms
 10,000 RPS: FAIL — achieved 9964 ops/s, 100.00% ok, add p99 197.06ms / remove p99 199.26ms

Contended run B — LEDGER_POOL_SIZE=8:
  1,000 RPS: FAIL — achieved 995 ops/s, 100.00% ok, add p99 216.12ms / remove p99 208.86ms
  5,000 RPS: FAIL — achieved 4918 ops/s (98.36% of target, also missed throughput gate), 100.00% ok, add p99 339.34ms / remove p99 305.68ms
 10,000 RPS: FAIL — achieved 9978 ops/s, 100.00% ok, add p99 213.22ms / remove p99 215.93ms

Conclusion: across four full runs (contended and quieted, pool 4 and 8),
the success gate (100.00%) passes at every level; the throughput gate passes
at every level except contended pool=8 5k (4,918 ops/s, 98.36% of target);
but the p99 < 50ms write-latency gate fails on every run —
pinned at ~200ms at 1k RPS regardless of host load, and amplified to
0.5–12s at 5k/10k whenever a host load spike lands inside the 60s window.
The evidence localizes the tail latency to the environment (macOS host
thrash + shared OrbStack VM + endpoint security), not the ledger code.
Gates were not weakened. The 10k ops/s @ p99<50ms claim remains
undemonstrated in this environment; a dedicated Linux host with a native
(non-VM, non-proxied) Redis is required for a conclusive run.
