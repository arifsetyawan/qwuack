❯ REDIS_URL=redis://redis.orb.local FLOOD_OPS=100000 FLOOD_CONCURRENCY=500 bun run poc/flood.ts
═══════════════════════════════════════════════════════════════
  FLOOD TEST - Redis Key Stress Test
═══════════════════════════════════════════════════════════════
  Target:       100,000 operations
  Concurrency:  500 parallel ops
  Read Load:    Enabled (every 10 writes)
  Cleanup:      Yes
───────────────────────────────────────────────────────────────
  Starting flood test...

  Progress: 100.0% | Hash size: 100,000 | Avg latency: 4551.67ms
  Cleaning up...


═══════════════════════════════════════════════════════════════
  FLOOD TEST RESULTS
═══════════════════════════════════════════════════════════════

Configuration:
  Target Key:     ledger:flood_1767351997380:vnd
  Operations:     100,000
  Concurrency:    500
  Include Reads:  Yes

Results:
  Duration:       507.63s
  Completed:      100,000 / 100,000 (100.00%)
  Failed:         0 (0.00%)
  Final Hash Size: 100,000 entries

Add Latency (ms):
  Average:        2285.43
  P95:            4661.95
  P99:            5188.74
  Min/Max:        14.58 / 6526.17

Read Latency (ms):
  Average:        2244.29
  P95:            4571.45
  P99:            5047.71
  Min/Max:        9.32 / 6526.20

Memory:
  Start:          5.57 MB
  Peak:           282.43 MB
  End:            43.31 MB
  Growth:         +37.75 MB

Latency Degradation:
  @    2,000 entries:  avg    80.06ms 🟠 HIGH
  @    4,000 entries:  avg   165.42ms 🔴 SEVERE
  @    6,000 entries:  avg   262.05ms 🔴 SEVERE
  @    8,000 entries:  avg   321.08ms 🔴 SEVERE
  @   10,000 entries:  avg   393.86ms 🔴 SEVERE
  @   12,000 entries:  avg   479.10ms 🔴 SEVERE
  @   14,000 entries:  avg   543.54ms 🔴 SEVERE
  @   16,000 entries:  avg   786.44ms 🔴 SEVERE
  @   18,000 entries:  avg   791.17ms 🔴 SEVERE
  @   20,000 entries:  avg   830.50ms 🔴 SEVERE
  @   22,000 entries:  avg   882.31ms 🔴 SEVERE
  @   24,000 entries:  avg   934.99ms 🔴 SEVERE
  @   26,000 entries:  avg  1035.65ms 🔴 SEVERE
  @   28,000 entries:  avg  1082.90ms 🔴 SEVERE
  @   30,000 entries:  avg  1227.76ms 🔴 SEVERE
  @   32,000 entries:  avg  1291.12ms 🔴 SEVERE
  @   34,000 entries:  avg  1494.23ms 🔴 SEVERE
  @   36,000 entries:  avg  1613.13ms 🔴 SEVERE
  @   38,000 entries:  avg  1755.40ms 🔴 SEVERE
  @   40,000 entries:  avg  1684.81ms 🔴 SEVERE
  @   42,000 entries:  avg  1812.01ms 🔴 SEVERE
  @   44,000 entries:  avg  1993.65ms 🔴 SEVERE
  @   46,000 entries:  avg  2236.12ms 🔴 SEVERE
  @   48,000 entries:  avg  1958.65ms 🔴 SEVERE
  @   50,000 entries:  avg  2147.50ms 🔴 SEVERE
  @   52,000 entries:  avg  2046.07ms 🔴 SEVERE
  @   54,000 entries:  avg  2226.42ms 🔴 SEVERE
  @   56,000 entries:  avg  2398.30ms 🔴 SEVERE
  @   58,000 entries:  avg  2320.55ms 🔴 SEVERE
  @   60,000 entries:  avg  3158.34ms 🔴 SEVERE
  @   62,000 entries:  avg  2715.76ms 🔴 SEVERE
  @   64,000 entries:  avg  2652.95ms 🔴 SEVERE
  @   66,000 entries:  avg  3046.23ms 🔴 SEVERE
  @   68,000 entries:  avg  3990.06ms 🔴 SEVERE
  @   70,000 entries:  avg  2819.62ms 🔴 SEVERE
  @   72,000 entries:  avg  3222.20ms 🔴 SEVERE
  @   74,000 entries:  avg  3582.37ms 🔴 SEVERE
  @   76,000 entries:  avg  3479.65ms 🔴 SEVERE
  @   78,000 entries:  avg  3607.87ms 🔴 SEVERE
  @   80,000 entries:  avg  3647.10ms 🔴 SEVERE
  @   82,000 entries:  avg  3538.80ms 🔴 SEVERE
  @   84,000 entries:  avg  5377.85ms 🔴 SEVERE
  @   86,000 entries:  avg  3816.37ms 🔴 SEVERE
  @   88,000 entries:  avg  4008.88ms 🔴 SEVERE
  @   90,000 entries:  avg  4645.96ms 🔴 SEVERE
  @   92,000 entries:  avg  4048.20ms 🔴 SEVERE
  @   94,000 entries:  avg  4918.95ms 🔴 SEVERE
  @   96,000 entries:  avg  4089.63ms 🔴 SEVERE
  @   98,000 entries:  avg  4524.80ms 🔴 SEVERE
  @  100,000 entries:  avg  4551.67ms 🔴 SEVERE

Breaking Points:
  Latency > 10ms:   @ 1 entries
  Latency > 100ms:  @ 2,325 entries
  First Error:      No errors

═══════════════════════════════════════════════════════════════
  RECOMMENDATIONS
═══════════════════════════════════════════════════════════════
  1. Consider limiting hash size to 0 entries
  2. Implement connection pooling for high concurrency
  3. Add memory pressure monitoring and backpressure
  5. Consider caching getBalance results or pagination
  6. Add TTL-based expiration for old entries
  7. Consider sharding large accounts across multiple keys
═══════════════════════════════════════════════════════════════