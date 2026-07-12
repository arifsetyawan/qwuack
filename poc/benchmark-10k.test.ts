// benchmark-10k.test.ts - Unit tests for pure benchmark helpers (no Redis needed)
import { describe, test, expect } from "bun:test";
import {
  pairsDue,
  pickAccount,
  computeVerdict,
  calculateStats,
} from "./benchmark-10k-helpers";

describe("pairsDue", () => {
  test("fires cumulative target minus already fired", () => {
    expect(pairsDue(1000, 5000, 0)).toBe(5000);
    expect(pairsDue(1000, 5000, 4990)).toBe(10);
    expect(pairsDue(10, 5000, 0)).toBe(50);
  });

  test("self-corrects after a late tick", () => {
    expect(pairsDue(35, 5000, 100)).toBe(75);
  });

  test("never returns negative", () => {
    expect(pairsDue(100, 5000, 9999)).toBe(0);
  });
});

describe("pickAccount", () => {
  const mix = { hot: ["h0", "h1"], cold: ["c0", "c1", "c2", "c3"], hotShare: 0.5 };

  test("rand below hotShare maps across hot accounts", () => {
    expect(pickAccount(mix, 0)).toBe("h0");
    expect(pickAccount(mix, 0.49)).toBe("h1");
  });

  test("rand at/above hotShare maps across cold accounts", () => {
    expect(pickAccount(mix, 0.5)).toBe("c0");
    expect(pickAccount(mix, 0.99)).toBe("c3");
  });
});

describe("computeVerdict", () => {
  const passing = {
    targetRps: 10000,
    achievedRps: 9950,
    successCount: 599400,
    attemptedOps: 599500,
    addP99: 12,
    removeP99: 8,
  };

  test("passes when all gates met", () => {
    const v = computeVerdict(passing);
    expect(v.pass).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  test("fails when achieved < 99% of target", () => {
    const v = computeVerdict({ ...passing, achievedRps: 9800 });
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain("throughput");
  });

  test("fails when success rate < 99.9%", () => {
    const v = computeVerdict({ ...passing, successCount: 590000 });
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain("success rate");
  });

  test("fails when write p99 >= 50ms", () => {
    expect(computeVerdict({ ...passing, addP99: 50 }).pass).toBe(false);
    expect(computeVerdict({ ...passing, removeP99: 55 }).pass).toBe(false);
  });
});

describe("calculateStats", () => {
  test("computes percentiles from unsorted input", () => {
    const lats = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
    const s = calculateStats(lats);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(51);
    expect(s.p95).toBe(96);
    expect(s.p99).toBe(100);
    expect(s.avg).toBe(50.5);
  });

  test("handles empty input", () => {
    const s = calculateStats([]);
    expect(s).toEqual({ avg: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 });
  });
});
