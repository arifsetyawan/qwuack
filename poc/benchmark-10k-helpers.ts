// benchmark-10k-helpers.ts - Pure helpers for the 10k RPS benchmark.
// Must stay free of Redis/ledger imports so unit tests run without a server.

// ============================================================================
// Open-loop scheduling
// ============================================================================

/**
 * How many add→remove pairs should fire now so that cumulative fired count
 * tracks elapsed × rate, regardless of timer jitter.
 */
export function pairsDue(
  elapsedMs: number,
  pairsPerSecond: number,
  alreadyFired: number
): number {
  return Math.max(0, Math.floor((elapsedMs / 1000) * pairsPerSecond) - alreadyFired);
}

// ============================================================================
// Workload mix
// ============================================================================

export interface AccountMix {
  hot: string[];
  cold: string[];
  hotShare: number;
}

/** Maps a uniform rand in [0,1) onto the hot/cold account mix. */
export function pickAccount(mix: AccountMix, rand: number): string {
  if (rand < mix.hotShare) {
    const idx = Math.floor((rand / mix.hotShare) * mix.hot.length);
    return mix.hot[Math.min(idx, mix.hot.length - 1)]!;
  }
  const scaled = (rand - mix.hotShare) / (1 - mix.hotShare);
  const idx = Math.floor(scaled * mix.cold.length);
  return mix.cold[Math.min(idx, mix.cold.length - 1)]!;
}

// ============================================================================
// Statistics
// ============================================================================

export interface LatencyStats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export function calculateStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return { avg: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return {
    avg: sum / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

// ============================================================================
// Verdict
// ============================================================================

export interface LevelVerdict {
  pass: boolean;
  reasons: string[];
}

/** Gates: achieved ≥ 99% target, success ≥ 99.9%, write p99 < 50ms. */
export function computeVerdict(input: {
  targetRps: number;
  achievedRps: number;
  successCount: number;
  attemptedOps: number;
  addP99: number;
  removeP99: number;
}): LevelVerdict {
  const reasons: string[] = [];
  if (input.achievedRps < 0.99 * input.targetRps) {
    reasons.push(
      `throughput ${input.achievedRps.toFixed(0)} ops/s < 99% of target ${input.targetRps}`
    );
  }
  const successRate =
    input.attemptedOps === 0 ? 0 : input.successCount / input.attemptedOps;
  if (successRate < 0.999) {
    reasons.push(`success rate ${(successRate * 100).toFixed(3)}% < 99.9%`);
  }
  if (input.addP99 >= 50) {
    reasons.push(`add p99 ${input.addP99.toFixed(2)}ms >= 50ms`);
  }
  if (input.removeP99 >= 50) {
    reasons.push(`remove p99 ${input.removeP99.toFixed(2)}ms >= 50ms`);
  }
  return { pass: reasons.length === 0, reasons };
}
