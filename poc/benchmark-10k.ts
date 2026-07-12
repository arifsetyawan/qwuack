// benchmark-10k.ts - Open-loop benchmark: mixed hot/cold accounts, PASS/FAIL verdict.
// Target RPS counts individual ledger ops; pairs fire at targetRps / 2.
import {
  addEntry,
  removeEntry,
  getBalance,
  clearLedger,
  quitAll,
  POOL_SIZE,
} from "./ledger-10k";
import {
  pairsDue,
  pickAccount,
  calculateStats,
  computeVerdict,
  type AccountMix,
  type LatencyStats,
  type LevelVerdict,
} from "./benchmark-10k-helpers";

// ============================================================================
// Configuration
// ============================================================================

const RPS_LEVELS = (process.env.RPS_LEVELS ?? "1000,5000,10000")
  .split(",")
  .map(Number);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const COOLDOWN_S = Number(process.env.COOLDOWN_S ?? 5);
const HOT_ACCOUNTS = Number(process.env.HOT_ACCOUNTS ?? 5);
const COLD_ACCOUNTS = Number(process.env.COLD_ACCOUNTS ?? 500);
const HOT_TRAFFIC_SHARE = Number(process.env.HOT_TRAFFIC_SHARE ?? 0.5);
const READ_RATIO = Number(process.env.READ_RATIO ?? 0.05);
const TICK_MS = 10;
const CURRENCY = "vnd";

// ============================================================================
// Types
// ============================================================================

interface MemorySnapshot {
  heapUsed: number;
  rss: number;
}

interface LevelResult {
  targetRps: number;
  duration: number;
  achievedRps: number;
  attemptedOps: number;
  successCount: number;
  failureCount: number;
  addStats: LatencyStats;
  removeStats: LatencyStats;
  readStats: LatencyStats;
  inFlightPeak: number;
  memoryStart: MemorySnapshot;
  memoryPeak: MemorySnapshot;
  memoryEnd: MemorySnapshot;
  errorCounts: Map<string, number>;
  verdict: LevelVerdict;
}

// ============================================================================
// Utilities
// ============================================================================

function getMemoryMB(): MemorySnapshot {
  const mem = process.memoryUsage();
  return { heapUsed: mem.heapUsed / 1024 / 1024, rss: mem.rss / 1024 / 1024 };
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function buildMix(): AccountMix {
  const runId = Date.now().toString(36);
  return {
    hot: Array.from({ length: HOT_ACCOUNTS }, (_, i) => `bench10k_${runId}_hot_${i}`),
    cold: Array.from({ length: COLD_ACCOUNTS }, (_, i) => `bench10k_${runId}_cold_${i}`),
    hotShare: HOT_TRAFFIC_SHARE,
  };
}

// ============================================================================
// Level Runner
// ============================================================================

async function runLevel(targetRps: number, durationSeconds: number): Promise<LevelResult> {
  const pairsPerSecond = targetRps / 2;
  const mix = buildMix();

  const addLatencies: number[] = [];
  const removeLatencies: number[] = [];
  const readLatencies: number[] = [];
  const errorCounts = new Map<string, number>();
  let attemptedOps = 0;
  let successCount = 0;
  let failureCount = 0;
  let inFlight = 0;
  let inFlightPeak = 0;
  let fired = 0;

  const memoryStart = getMemoryMB();
  let memoryPeak = { ...memoryStart };
  const memorySampler = setInterval(() => {
    const current = getMemoryMB();
    if (current.heapUsed > memoryPeak.heapUsed) {
      memoryPeak = current;
    }
  }, 100);

  function firePair(): void {
    inFlight++;
    if (inFlight > inFlightPeak) {
      inFlightPeak = inFlight;
    }
    attemptedOps += 2;
    const accountId = pickAccount(mix, Math.random());
    const entryId = crypto.randomUUID();
    const doRead = Math.random() < READ_RATIO;

    void (async () => {
      let completed = 0;
      try {
        const t0 = performance.now();
        await addEntry(accountId, CURRENCY, {
          id: entryId,
          context: "bench",
          currency: CURRENCY,
          amount: "1000",
        });
        addLatencies.push(performance.now() - t0);
        completed++;

        const t1 = performance.now();
        await removeEntry(accountId, CURRENCY, entryId);
        removeLatencies.push(performance.now() - t1);
        completed++;

        if (doRead) {
          const t2 = performance.now();
          await getBalance(accountId, CURRENCY);
          readLatencies.push(performance.now() - t2);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errorCounts.set(msg, (errorCounts.get(msg) ?? 0) + 1);
      } finally {
        successCount += completed;
        failureCount += 2 - completed;
        inFlight--;
      }
    })();
  }

  const start = performance.now();
  const endAt = start + durationSeconds * 1000;

  while (performance.now() < endAt) {
    const due = pairsDue(performance.now() - start, pairsPerSecond, fired);
    for (let i = 0; i < due; i++) {
      firePair();
    }
    fired += due;
    await Bun.sleep(TICK_MS);
  }

  // Drain in-flight ops (open loop: these were fired inside the window).
  while (inFlight > 0) {
    await Bun.sleep(20);
  }

  const duration = (performance.now() - start) / 1000;
  clearInterval(memorySampler);
  const memoryEnd = getMemoryMB();

  const addStats = calculateStats(addLatencies);
  const removeStats = calculateStats(removeLatencies);
  const readStats = calculateStats(readLatencies);
  const achievedRps = (addLatencies.length + removeLatencies.length) / duration;

  // Cleanup all benchmark accounts.
  await Promise.all(
    [...mix.hot, ...mix.cold].map((account) => clearLedger(account, CURRENCY))
  );

  return {
    targetRps,
    duration,
    achievedRps,
    attemptedOps,
    successCount,
    failureCount,
    addStats,
    removeStats,
    readStats,
    inFlightPeak,
    memoryStart,
    memoryPeak,
    memoryEnd,
    errorCounts,
    verdict: computeVerdict({
      targetRps,
      achievedRps,
      successCount,
      attemptedOps,
      addP99: addStats.p99,
      removeP99: removeStats.p99,
    }),
  };
}

// ============================================================================
// Reporting
// ============================================================================

function printLatencyLine(label: string, s: LatencyStats): void {
  console.log(
    `    ${label}  avg ${fmt(s.avg)}  p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  p99 ${fmt(s.p99)}  max ${fmt(s.max)}`
  );
}

function printResult(r: LevelResult): void {
  const successRate = r.attemptedOps === 0 ? 0 : (r.successCount / r.attemptedOps) * 100;
  console.log(`\n▶ ${r.targetRps.toLocaleString()} RPS Level`);
  console.log(`  Duration:       ${fmt(r.duration)}s (incl. drain)`);
  console.log(
    `  Achieved:       ${fmt(r.achievedRps, 0)} ops/s (target ${r.targetRps.toLocaleString()})`
  );
  console.log(
    `  Ops:            ${r.attemptedOps.toLocaleString()} attempted | ${r.successCount.toLocaleString()} ok (${fmt(successRate)}%) | ${r.failureCount.toLocaleString()} failed`
  );
  console.log(`  In-flight peak: ${r.inFlightPeak.toLocaleString()} pairs`);
  console.log(`  Latency (ms):`);
  printLatencyLine("Add:   ", r.addStats);
  printLatencyLine("Remove:", r.removeStats);
  printLatencyLine("Read:  ", r.readStats);
  console.log(
    `  Memory:         heap ${fmt(r.memoryStart.heapUsed)} → ${fmt(r.memoryEnd.heapUsed)} MB (peak ${fmt(r.memoryPeak.heapUsed)} MB)`
  );

  if (r.errorCounts.size > 0) {
    console.log(`  Errors:`);
    for (const [msg, count] of [...r.errorCounts.entries()].slice(0, 5)) {
      console.log(`    ${count}x ${msg}`);
    }
  } else {
    console.log(`  Errors:         none`);
  }

  if (r.verdict.pass) {
    console.log(`  Verdict:        ✅ PASS`);
  } else {
    console.log(`  Verdict:        ❌ FAIL`);
    for (const reason of r.verdict.reasons) {
      console.log(`    - ${reason}`);
    }
  }
}

// ============================================================================
// Main
// ============================================================================

if (import.meta.main) {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LEDGER 10K BENCHMARK (open-loop, mixed hot/cold accounts)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  RPS Levels:   ${RPS_LEVELS.join(", ")} (ops/s; pairs fire at rps/2)`);
  console.log(`  Duration:     ${DURATION_S}s per level, ${COOLDOWN_S}s cooldown`);
  console.log(
    `  Accounts:     ${HOT_ACCOUNTS} hot (${HOT_TRAFFIC_SHARE * 100}% traffic) + ${COLD_ACCOUNTS} cold`
  );
  console.log(`  Reads:        ${READ_RATIO * 100}% of pairs issue getBalance`);
  console.log(`  Pool size:    ${POOL_SIZE}`);

  const results: LevelResult[] = [];
  for (const rps of RPS_LEVELS) {
    console.log("\n───────────────────────────────────────────────────────────────");
    console.log(`  Starting ${rps.toLocaleString()} RPS level...`);
    const result = await runLevel(rps, DURATION_S);
    results.push(result);
    printResult(result);
    if (rps !== RPS_LEVELS[RPS_LEVELS.length - 1]) {
      await Bun.sleep(COOLDOWN_S * 1000);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  for (const r of results) {
    const status = r.verdict.pass ? "✅ PASS" : "❌ FAIL";
    console.log(
      `  ${String(r.targetRps).padStart(6)} RPS: ${status}  (achieved ${fmt(r.achievedRps, 0)} ops/s, add p99 ${fmt(r.addStats.p99)}ms, remove p99 ${fmt(r.removeStats.p99)}ms)`
    );
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  await quitAll();
  const allPassed = results.every((r) => r.verdict.pass);
  process.exit(allPassed ? 0 : 1);
}
