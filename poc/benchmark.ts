// benchmark.ts - Concurrent Ledger Benchmark Test
import { addEntry, removeEntry, clearLedger, redis } from "./ledger-optimized";

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

interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

interface BenchmarkResult {
  rps: number;
  duration: number;
  totalOps: number;
  addOps: number;
  removeOps: number;
  successCount: number;
  failureCount: number;
  addLatency: LatencyStats;
  removeLatency: LatencyStats;
  memoryStart: MemorySnapshot;
  memoryEnd: MemorySnapshot;
  peakMemory: MemorySnapshot;
  errors: string[];
}

// ============================================================================
// Utilities
// ============================================================================

function getMemoryMB(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed / 1024 / 1024,
    heapTotal: mem.heapTotal / 1024 / 1024,
    external: mem.external / 1024 / 1024,
    rss: mem.rss / 1024 / 1024,
  };
}

function calculateStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { avg: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Index = Math.floor(sorted.length * 0.95);
  const p99Index = Math.floor(sorted.length * 0.99);

  return {
    avg: sum / sorted.length,
    p95: sorted[p95Index] ?? sorted[sorted.length - 1]!,
    p99: sorted[p99Index] ?? sorted[sorted.length - 1]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

function formatNumber(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function formatMemoryDelta(start: number, end: number): string {
  const delta = end - start;
  const sign = delta >= 0 ? "+" : "";
  return `${formatNumber(start)} MB → ${formatNumber(end)} MB (${sign}${formatNumber(delta)} MB)`;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

async function runBenchmark(
  rps: number,
  durationSeconds: number
): Promise<BenchmarkResult> {
  const accountId = `bench_${Date.now()}`;
  const currency = "vnd";
  const intervalMs = 1000 / rps;

  const addLatencies: number[] = [];
  const removeLatencies: number[] = [];
  const errors: string[] = [];
  let successCount = 0;
  let failureCount = 0;

  // Memory tracking
  const memoryStart = getMemoryMB();
  let peakMemory = { ...memoryStart };
  const memorySnapshots: MemorySnapshot[] = [];

  // Start memory sampling
  const memorySampler = setInterval(() => {
    const current = getMemoryMB();
    memorySnapshots.push(current);
    if (current.heapUsed > peakMemory.heapUsed) {
      peakMemory = current;
    }
  }, 100);

  // Track in-flight operations
  const inFlightOps: Promise<void>[] = [];

  const startTime = performance.now();
  const endTime = startTime + durationSeconds * 1000;

  // Fire requests at target RPS
  while (performance.now() < endTime) {
    const entryId = crypto.randomUUID();

    // Fire add operation (don't await)
    const opPromise = (async () => {
      try {
        // Add entry
        const addStart = performance.now();
        await addEntry(accountId, currency, {
          id: entryId,
          context: "benchmark",
          currency,
          amount: "1000",
        });
        const addEnd = performance.now();
        addLatencies.push(addEnd - addStart);

        // Remove entry after add completes
        const removeStart = performance.now();
        await removeEntry(accountId, currency, entryId);
        const removeEnd = performance.now();
        removeLatencies.push(removeEnd - removeStart);

        successCount += 2; // Both add and remove succeeded
      } catch (error) {
        failureCount++;
        const errMsg = error instanceof Error ? error.message : String(error);
        if (!errors.includes(errMsg)) {
          errors.push(errMsg);
        }
      }
    })();

    inFlightOps.push(opPromise);

    // Wait for next interval
    await Bun.sleep(intervalMs);
  }

  // Wait for all in-flight operations to complete
  await Promise.allSettled(inFlightOps);

  const actualDuration = (performance.now() - startTime) / 1000;

  // Stop memory sampling
  clearInterval(memorySampler);
  const memoryEnd = getMemoryMB();

  // Cleanup test data
  await clearLedger(accountId, currency);

  return {
    rps,
    duration: actualDuration,
    totalOps: addLatencies.length + removeLatencies.length,
    addOps: addLatencies.length,
    removeOps: removeLatencies.length,
    successCount,
    failureCount,
    addLatency: calculateStats(addLatencies),
    removeLatency: calculateStats(removeLatencies),
    memoryStart,
    memoryEnd,
    peakMemory,
    errors,
  };
}

// ============================================================================
// Results Reporting
// ============================================================================

function printResult(result: BenchmarkResult): void {
  const successRate = (result.successCount / result.totalOps) * 100;
  const failureRate = (result.failureCount / result.totalOps) * 100;

  console.log(`\n▶ ${result.rps} RPS Test`);
  console.log(`  Duration:       ${formatNumber(result.duration)}s`);
  console.log(
    `  Total Ops:      ${result.totalOps.toLocaleString()} (${result.addOps} add + ${result.removeOps} remove)`
  );
  console.log(
    `  Success:        ${result.successCount.toLocaleString()} (${formatNumber(successRate)}%)`
  );
  console.log(
    `  Failed:         ${result.failureCount.toLocaleString()} (${formatNumber(failureRate)}%)`
  );

  console.log(`\n  Latency (ms):`);
  console.log(
    `    Add Avg:      ${formatNumber(result.addLatency.avg)}    |  Remove Avg:   ${formatNumber(result.removeLatency.avg)}`
  );
  console.log(
    `    Add P95:      ${formatNumber(result.addLatency.p95)}    |  Remove P95:   ${formatNumber(result.removeLatency.p95)}`
  );
  console.log(
    `    Add P99:      ${formatNumber(result.addLatency.p99)}    |  Remove P99:   ${formatNumber(result.removeLatency.p99)}`
  );
  console.log(
    `    Add Min:      ${formatNumber(result.addLatency.min)}    |  Remove Min:   ${formatNumber(result.removeLatency.min)}`
  );
  console.log(
    `    Add Max:      ${formatNumber(result.addLatency.max)}    |  Remove Max:   ${formatNumber(result.removeLatency.max)}`
  );

  console.log(`\n  Memory:`);
  console.log(
    `    Heap Used:    ${formatMemoryDelta(result.memoryStart.heapUsed, result.memoryEnd.heapUsed)}`
  );
  console.log(`    Peak Heap:    ${formatNumber(result.peakMemory.heapUsed)} MB`);
  console.log(
    `    RSS:          ${formatMemoryDelta(result.memoryStart.rss, result.memoryEnd.rss)}`
  );

  if (result.errors.length > 0) {
    console.log(`\n  Errors (${result.errors.length} unique):`);
    result.errors.slice(0, 5).forEach((err) => {
      console.log(`    - ${err}`);
    });
    if (result.errors.length > 5) {
      console.log(`    ... and ${result.errors.length - 5} more`);
    }
  } else {
    console.log(`\n  Errors: None`);
  }
}

function printSummary(results: BenchmarkResult[]): void {
  const totalOps = results.reduce((sum, r) => sum + r.totalOps, 0);
  const totalSuccess = results.reduce((sum, r) => sum + r.successCount, 0);
  const totalFailure = results.reduce((sum, r) => sum + r.failureCount, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const peakMemory = Math.max(...results.map((r) => r.peakMemory.heapUsed));
  const peakRps = results.find((r) => r.peakMemory.heapUsed === peakMemory)?.rps;

  console.log(
    "\n═══════════════════════════════════════════════════════════════"
  );
  console.log("  SUMMARY");
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log(`  Total Duration:   ${formatNumber(totalDuration)}s`);
  console.log(`  Total Operations: ${totalOps.toLocaleString()}`);
  console.log(
    `  Overall Success:  ${formatNumber((totalSuccess / totalOps) * 100)}%`
  );
  console.log(`  Overall Failure:  ${totalFailure.toLocaleString()}`);
  console.log(`  Peak Memory:      ${formatNumber(peakMemory)} MB (at ${peakRps} RPS)`);
  console.log(
    "═══════════════════════════════════════════════════════════════\n"
  );
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const rpsLevels = [10, 50, 100];
  const durationSeconds = 60;
  const cooldownSeconds = 5;

  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log("  LEDGER BENCHMARK RESULTS (Concurrent Mode)");
  console.log(
    "═══════════════════════════════════════════════════════════════"
  );
  console.log(`  Test Duration: ${durationSeconds}s per RPS level`);
  console.log(`  RPS Levels: ${rpsLevels.join(", ")}`);
  console.log(`  Cooldown: ${cooldownSeconds}s between tests`);

  const results: BenchmarkResult[] = [];

  for (const rps of rpsLevels) {
    console.log(
      "\n───────────────────────────────────────────────────────────────"
    );
    console.log(`  Starting ${rps} RPS test...`);

    const result = await runBenchmark(rps, durationSeconds);
    results.push(result);
    printResult(result);

    // Cooldown before next test
    if (rps !== rpsLevels[rpsLevels.length - 1]) {
      console.log(`\n  Cooling down for ${cooldownSeconds}s...`);
      await Bun.sleep(cooldownSeconds * 1000);
    }
  }

  printSummary(results);

  // Cleanup
  await redis.quit();
}

// Run benchmark
main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
