// flood.ts - Redis Key Flood Test
import { addEntry, getBalance, clearLedger, redis } from "./ledger";

// ============================================================================
// Types
// ============================================================================

interface LatencyStats {
  avg: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

interface DegradationPoint {
  hashSize: number;
  avgLatency: number;
}

interface FloodConfig {
  accountId: string;
  currency: string;
  targetOps: number;
  concurrency: number;
  includeReads: boolean;
  readInterval: number; // Read every N writes
  cleanupAfter: boolean;
}

interface FloodResult {
  config: FloodConfig;
  duration: number;
  totalAttempted: number;
  successCount: number;
  failureCount: number;
  hashSize: number;
  addLatencies: LatencyStats;
  readLatencies: LatencyStats;
  memoryStart: number;
  memoryPeak: number;
  memoryEnd: number;
  errorTypes: Map<string, number>;
  degradationCurve: DegradationPoint[];
  breakingPoints: {
    latency10ms: number | null;
    latency100ms: number | null;
    firstError: number | null;
  };
}

// ============================================================================
// Utilities
// ============================================================================

function getHeapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function calculateStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { avg: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Idx = Math.floor(sorted.length * 0.95);
  const p99Idx = Math.floor(sorted.length * 0.99);
  return {
    avg: sum / sorted.length,
    p95: sorted[p95Idx] ?? sorted[sorted.length - 1]!,
    p99: sorted[p99Idx] ?? sorted[sorted.length - 1]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

function formatNumber(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

// ============================================================================
// Semaphore for Concurrency Control
// ============================================================================

class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

// ============================================================================
// Flood Runner
// ============================================================================

async function runFlood(config: FloodConfig): Promise<FloodResult> {
  const addLatencies: number[] = [];
  const readLatencies: number[] = [];
  const errorTypes = new Map<string, number>();
  const degradationCurve: DegradationPoint[] = [];

  let successCount = 0;
  let failureCount = 0;
  let currentHashSize = 0;
  let memoryPeak = 0;

  const breakingPoints = {
    latency10ms: null as number | null,
    latency100ms: null as number | null,
    firstError: null as number | null,
  };

  // Memory tracking
  const memoryStart = getHeapMB();
  const memorySampler = setInterval(() => {
    const current = getHeapMB();
    if (current > memoryPeak) memoryPeak = current;
  }, 50);

  const semaphore = new Semaphore(config.concurrency);
  const startTime = performance.now();

  // Progress tracking
  let lastReportedSize = 0;
  const reportInterval = Math.max(1000, Math.floor(config.targetOps / 50));

  // Fire all operations
  const operations: Promise<void>[] = [];

  for (let i = 0; i < config.targetOps; i++) {
    const entryId = crypto.randomUUID();
    const opIndex = i;

    const op = (async () => {
      await semaphore.acquire();
      try {
        // Add entry
        const addStart = performance.now();
        await addEntry(config.accountId, config.currency, {
          id: entryId,
          context: "flood",
          currency: config.currency,
          amount: "1000",
        });
        const addLatency = performance.now() - addStart;
        addLatencies.push(addLatency);
        successCount++;
        currentHashSize++;

        // Check for degradation breakpoints
        if (breakingPoints.latency10ms === null && addLatency > 10) {
          breakingPoints.latency10ms = currentHashSize;
        }
        if (breakingPoints.latency100ms === null && addLatency > 100) {
          breakingPoints.latency100ms = currentHashSize;
        }

        // Concurrent read if enabled
        if (config.includeReads && opIndex % config.readInterval === 0) {
          const readStart = performance.now();
          await getBalance(config.accountId, config.currency);
          readLatencies.push(performance.now() - readStart);
        }

        // Track degradation curve
        if (currentHashSize - lastReportedSize >= reportInterval) {
          const recentLatencies = addLatencies.slice(-100);
          const avgRecent =
            recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length;
          degradationCurve.push({
            hashSize: currentHashSize,
            avgLatency: avgRecent,
          });
          lastReportedSize = currentHashSize;

          // Progress output
          const progress = ((opIndex / config.targetOps) * 100).toFixed(1);
          process.stdout.write(
            `\r  Progress: ${progress}% | Hash size: ${currentHashSize.toLocaleString()} | Avg latency: ${avgRecent.toFixed(2)}ms`
          );
        }
      } catch (error) {
        failureCount++;
        const errMsg = error instanceof Error ? error.message : String(error);
        const shortErr = errMsg.substring(0, 50);
        errorTypes.set(shortErr, (errorTypes.get(shortErr) || 0) + 1);

        if (breakingPoints.firstError === null) {
          breakingPoints.firstError = currentHashSize;
        }
      } finally {
        semaphore.release();
      }
    })();

    operations.push(op);
  }

  // Wait for all operations
  await Promise.allSettled(operations);

  const duration = (performance.now() - startTime) / 1000;
  clearInterval(memorySampler);

  // Get final hash size from Redis
  const key = `ledger:${config.accountId}:${config.currency}`;
  const finalHashSize = await redis.hLen(key);

  const memoryEnd = getHeapMB();

  // Cleanup if requested
  if (config.cleanupAfter) {
    console.log("\n  Cleaning up...");
    await clearLedger(config.accountId, config.currency);
  }

  return {
    config,
    duration,
    totalAttempted: config.targetOps,
    successCount,
    failureCount,
    hashSize: finalHashSize,
    addLatencies: calculateStats(addLatencies),
    readLatencies: calculateStats(readLatencies),
    memoryStart,
    memoryPeak,
    memoryEnd,
    errorTypes,
    degradationCurve,
    breakingPoints,
  };
}

// ============================================================================
// Results Reporting
// ============================================================================

function printResults(result: FloodResult): void {
  console.log(
    "\n\n═══════════════════════════════════════════════════════════════"
  );
  console.log("  FLOOD TEST RESULTS");
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );

  console.log("\nConfiguration:");
  console.log(
    `  Target Key:     ledger:${result.config.accountId}:${result.config.currency}`
  );
  console.log(`  Operations:     ${result.config.targetOps.toLocaleString()}`);
  console.log(`  Concurrency:    ${result.config.concurrency}`);
  console.log(`  Include Reads:  ${result.config.includeReads ? "Yes" : "No"}`);

  const successRate = (result.successCount / result.totalAttempted) * 100;
  const failRate = (result.failureCount / result.totalAttempted) * 100;

  console.log("\nResults:");
  console.log(`  Duration:       ${formatNumber(result.duration)}s`);
  console.log(
    `  Completed:      ${result.successCount.toLocaleString()} / ${result.totalAttempted.toLocaleString()} (${formatNumber(successRate)}%)`
  );
  console.log(
    `  Failed:         ${result.failureCount.toLocaleString()} (${formatNumber(failRate)}%)`
  );
  console.log(`  Final Hash Size: ${result.hashSize.toLocaleString()} entries`);

  console.log("\nAdd Latency (ms):");
  console.log(`  Average:        ${formatNumber(result.addLatencies.avg)}`);
  console.log(`  P95:            ${formatNumber(result.addLatencies.p95)}`);
  console.log(`  P99:            ${formatNumber(result.addLatencies.p99)}`);
  console.log(
    `  Min/Max:        ${formatNumber(result.addLatencies.min)} / ${formatNumber(result.addLatencies.max)}`
  );

  if (result.config.includeReads && result.readLatencies.avg > 0) {
    console.log("\nRead Latency (ms):");
    console.log(`  Average:        ${formatNumber(result.readLatencies.avg)}`);
    console.log(`  P95:            ${formatNumber(result.readLatencies.p95)}`);
    console.log(`  P99:            ${formatNumber(result.readLatencies.p99)}`);
    console.log(
      `  Min/Max:        ${formatNumber(result.readLatencies.min)} / ${formatNumber(result.readLatencies.max)}`
    );
  }

  console.log("\nMemory:");
  console.log(`  Start:          ${formatNumber(result.memoryStart)} MB`);
  console.log(`  Peak:           ${formatNumber(result.memoryPeak)} MB`);
  console.log(`  End:            ${formatNumber(result.memoryEnd)} MB`);
  console.log(
    `  Growth:         +${formatNumber(result.memoryEnd - result.memoryStart)} MB`
  );

  if (result.degradationCurve.length > 0) {
    console.log("\nLatency Degradation:");
    for (const point of result.degradationCurve) {
      let indicator = "";
      if (point.avgLatency > 100) indicator = " 🔴 SEVERE";
      else if (point.avgLatency > 50) indicator = " 🟠 HIGH";
      else if (point.avgLatency > 10) indicator = " 🟡 DEGRADED";

      console.log(
        `  @ ${point.hashSize.toLocaleString().padStart(8)} entries:  avg ${formatNumber(point.avgLatency).padStart(8)}ms${indicator}`
      );
    }
  }

  console.log("\nBreaking Points:");
  console.log(
    `  Latency > 10ms:   ${result.breakingPoints.latency10ms !== null ? `@ ${result.breakingPoints.latency10ms.toLocaleString()} entries` : "Not reached"}`
  );
  console.log(
    `  Latency > 100ms:  ${result.breakingPoints.latency100ms !== null ? `@ ${result.breakingPoints.latency100ms.toLocaleString()} entries` : "Not reached"}`
  );
  console.log(
    `  First Error:      ${result.breakingPoints.firstError !== null ? `@ ${result.breakingPoints.firstError.toLocaleString()} entries` : "No errors"}`
  );

  if (result.errorTypes.size > 0) {
    console.log("\nErrors:");
    const sortedErrors = [...result.errorTypes.entries()].sort(
      (a, b) => b[1] - a[1]
    );
    for (const [err, count] of sortedErrors.slice(0, 5)) {
      const pct = ((count / result.failureCount) * 100).toFixed(1);
      console.log(`  ${err}: ${count.toLocaleString()} (${pct}%)`);
    }
    if (sortedErrors.length > 5) {
      console.log(`  ... and ${sortedErrors.length - 5} more error types`);
    }
  }

  console.log(
    "\n═══════════════════════════════════════════════════════════════"
  );
  console.log("  RECOMMENDATIONS");
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );

  if (result.breakingPoints.latency10ms !== null) {
    console.log(
      `  1. Consider limiting hash size to ${Math.floor(result.breakingPoints.latency10ms * 0.8).toLocaleString()} entries`
    );
  }
  if (result.addLatencies.p99 > 50) {
    console.log("  2. Implement connection pooling for high concurrency");
  }
  if (result.memoryPeak > result.memoryStart * 2) {
    console.log("  3. Add memory pressure monitoring and backpressure");
  }
  if (result.failureCount > 0) {
    console.log("  4. Implement retry logic with exponential backoff");
  }
  if (result.readLatencies.avg > 10) {
    console.log("  5. Consider caching getBalance results or pagination");
  }
  console.log("  6. Add TTL-based expiration for old entries");
  console.log("  7. Consider sharding large accounts across multiple keys");

  console.log(
    "═══════════════════════════════════════════════════════════════\n"
  );
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const targetOps = parseInt(process.env.FLOOD_OPS || "50000", 10);
  const concurrency = parseInt(process.env.FLOOD_CONCURRENCY || "200", 10);
  const includeReads = process.env.FLOOD_NO_READS !== "1";
  const cleanupAfter = process.env.FLOOD_NO_CLEANUP !== "1";

  const config: FloodConfig = {
    accountId: `flood_${Date.now()}`,
    currency: "vnd",
    targetOps,
    concurrency,
    includeReads,
    readInterval: 10, // Read every 10 writes
    cleanupAfter,
  };

  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log("  FLOOD TEST - Redis Key Stress Test");
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log(`  Target:       ${targetOps.toLocaleString()} operations`);
  console.log(`  Concurrency:  ${concurrency} parallel ops`);
  console.log(`  Read Load:    ${includeReads ? "Enabled (every 10 writes)" : "Disabled"}`);
  console.log(`  Cleanup:      ${cleanupAfter ? "Yes" : "No"}`);
  console.log(
    "───────────────────────────────────────────────────────────────"
  );
  console.log("  Starting flood test...\n");

  const result = await runFlood(config);
  printResults(result);

  await redis.quit();
}

main().catch((error) => {
  console.error("\nFlood test failed:", error);
  process.exit(1);
});
