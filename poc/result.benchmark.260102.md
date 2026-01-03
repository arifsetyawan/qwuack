❯ REDIS_URL=redis://redis.orb.local bun run poc/benchmark.ts 
═══════════════════════════════════════════════════════════════
  LEDGER BENCHMARK RESULTS (Concurrent Mode)
═══════════════════════════════════════════════════════════════
  Test Duration: 60s per RPS level
  RPS Levels: 10, 50, 100
  Cooldown: 5s between tests

───────────────────────────────────────────────────────────────
  Starting 10 RPS test...

▶ 10 RPS Test
  Duration:       60.01s
  Total Ops:      1,182 (591 add + 591 remove)
  Success:        1,182 (100.00%)
  Failed:         0 (0.00%)

  Latency (ms):
    Add Avg:      2.71    |  Remove Avg:   1.12
    Add P95:      6.29    |  Remove P95:   3.45
    Add P99:      11.63    |  Remove P99:   10.62
    Add Min:      0.54    |  Remove Min:   0.19
    Add Max:      54.16    |  Remove Max:   29.53

  Memory:
    Heap Used:    5.57 MB → 6.03 MB (+0.46 MB)
    Peak Heap:    6.03 MB
    RSS:          58.41 MB → 46.39 MB (-12.02 MB)

  Errors: None

  Cooling down for 5s...

───────────────────────────────────────────────────────────────
  Starting 50 RPS test...

▶ 50 RPS Test
  Duration:       60.01s
  Total Ops:      5,400 (2700 add + 2700 remove)
  Success:        5,400 (100.00%)
  Failed:         0 (0.00%)

  Latency (ms):
    Add Avg:      2.14    |  Remove Avg:   0.83
    Add P95:      5.93    |  Remove P95:   2.27
    Add P99:      14.46    |  Remove P99:   6.08
    Add Min:      0.21    |  Remove Min:   0.12
    Add Max:      92.30    |  Remove Max:   101.41

  Memory:
    Heap Used:    6.09 MB → 7.88 MB (+1.80 MB)
    Peak Heap:    7.88 MB
    RSS:          31.22 MB → 47.36 MB (+16.14 MB)

  Errors: None

  Cooling down for 5s...

───────────────────────────────────────────────────────────────
  Starting 100 RPS test...

▶ 100 RPS Test
  Duration:       60.01s
  Total Ops:      10,274 (5137 add + 5137 remove)
  Success:        10,274 (100.00%)
  Failed:         0 (0.00%)

  Latency (ms):
    Add Avg:      1.62    |  Remove Avg:   0.76
    Add P95:      4.87    |  Remove P95:   2.35
    Add P99:      11.14    |  Remove P99:   6.65
    Add Min:      0.19    |  Remove Min:   0.10
    Add Max:      46.21    |  Remove Max:   54.55

  Memory:
    Heap Used:    7.89 MB → 10.36 MB (+2.47 MB)
    Peak Heap:    10.36 MB
    RSS:          41.78 MB → 40.72 MB (-1.06 MB)

  Errors: None

═══════════════════════════════════════════════════════════════
  SUMMARY
═══════════════════════════════════════════════════════════════
  Total Duration:   180.03s
  Total Operations: 16,856
  Overall Success:  100.00%
  Overall Failure:  0
  Peak Memory:      10.36 MB (at 100 RPS)
═══════════════════════════════════════════════════════════════