// ledger.integration.test.ts — Lua behaviour against real Redis. Run: REDIS_URL=redis://localhost:6379 bun test
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Ledger, type LedgerEntry } from "./ledger";

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)("two-phase ledger (real redis)", () => {
  let redis: any;
  let ledger: Ledger;
  const acc = `it-${process.pid}`;
  const ccy = "usd";
  const entry = (id: string, amount: string): LedgerEntry => ({ id, context: "test", currency: ccy, amount });

  beforeEach(async () => {
    const IORedis = (await import("ioredis")).default;
    redis = redis ?? new IORedis(REDIS_URL!);
    ledger = new Ledger(redis, { keyPrefix: "qwuack-it" });
    await ledger.clearLedger(acc, ccy);
  });

  afterAll(async () => {
    if (redis) { await ledger.clearLedger(acc, ccy); redis.disconnect(); }
  });

  test("pending debit reserves hold and floors on total+hold", async () => {
    const r1 = await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d1", "-60"), -100);
    expect(r1.success).toBe(true);
    expect(await ledger.getSum(acc, ccy)).toBe("-60"); // hold counts
    const r2 = await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d2", "-60"), -100);
    expect(r2.success).toBe(false); // -60 + -60 < -100
    expect(r2.reason).toBe("INSUFFICIENT_BALANCE");
  });

  test("pending credit is NOT spendable until confirmed", async () => {
    await ledger.addPendingEntry(acc, ccy, entry("c1", "50"));
    expect(await ledger.getSum(acc, ccy)).toBe("0"); // no total, no hold
    const r = await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d1", "-50"), 0);
    expect(r.success).toBe(false); // cannot spend uncommitted credit
    await ledger.confirmEntry(acc, ccy, "c1");
    expect(await ledger.getSum(acc, ccy)).toBe("50");
    const r2 = await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d2", "-50"), 0);
    expect(r2.success).toBe(true);
  });

  test("confirm moves debit hold to total; remove clears it", async () => {
    await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d1", "-30"), -100);
    await ledger.confirmEntry(acc, ccy, "d1");
    const bal = await ledger.getBalance(acc, ccy);
    expect(bal.total).toBe("-30");
    expect(await ledger.getSum(acc, ccy)).toBe("-30"); // hold back to 0
    expect(await ledger.removeEntry(acc, ccy, "d1")).toBe(true);
    expect(await ledger.getSum(acc, ccy)).toBe("0");
  });

  test("cancel releases hold and deletes entry; total untouched", async () => {
    await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d1", "-30"), -100);
    expect(await ledger.cancelEntry(acc, ccy, "d1")).toEqual({ status: "cancelled" });
    expect(await ledger.getSum(acc, ccy)).toBe("0");
    expect(await ledger.getEntry(acc, ccy, "d1")).toBeNull();
  });

  test("removeEntry refuses pending; confirm/cancel are idempotent-safe", async () => {
    await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d1", "-10"), -100);
    expect(await ledger.removeEntry(acc, ccy, "d1")).toBe(false); // guarded
    await ledger.confirmEntry(acc, ccy, "d1");
    expect(await ledger.confirmEntry(acc, ccy, "d1")).toEqual({ status: "already_confirmed" });
    expect(await ledger.cancelEntry(acc, ccy, "d1")).toEqual({ status: "not_pending" });
    expect(await ledger.confirmEntry(acc, ccy, "gone")).toEqual({ status: "not_found" });
  });

  test("IfSufficient credit confirm releases its hold (no double count)", async () => {
    // The exact bug the held flag fixed: a credit reserved via IfSufficient must not inflate avail at confirm.
    const r = await ledger.addPendingEntryIfSufficient(acc, ccy, entry("cx", "25"), -100);
    expect(r.success).toBe(true);
    expect(await ledger.getSum(acc, ccy)).toBe("25"); // reserved in hold
    await ledger.confirmEntry(acc, ccy, "cx");
    const bal = await ledger.getBalance(acc, ccy);
    expect(bal.total).toBe("25");
    expect(await ledger.getSum(acc, ccy)).toBe("25"); // NOT 50 — hold released
  });

  test("legacy stateless entry confirm is already_confirmed", async () => {
    await ledger.addEntry(acc, ccy, entry("legacy1", "30")); // 0.1.4-style: no state, straight to total
    expect(await ledger.confirmEntry(acc, ccy, "legacy1")).toEqual({ status: "already_confirmed" });
    expect(await ledger.getSum(acc, ccy)).toBe("30"); // unchanged
  });

  test("hold release follows the held flag, not amount sign", async () => {
    // A debit added via addPendingEntry (no reservation) must not corrupt :hold at confirm.
    await ledger.addPendingEntry(acc, ccy, entry("dx", "-15"));
    expect(await ledger.getSum(acc, ccy)).toBe("0"); // no hold was reserved
    await ledger.confirmEntry(acc, ccy, "dx");
    const bal = await ledger.getBalance(acc, ccy);
    expect(bal.total).toBe("-15");
    expect(await ledger.getSum(acc, ccy)).toBe("-15"); // hold still 0 — no spurious release
  });

  test("duplicate pending add is idempotent", async () => {
    const r1 = await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d1", "-10"), -100);
    const r2 = await ledger.addPendingEntryIfSufficient(acc, ccy, entry("d1", "-10"), -100);
    expect(r1.duplicate).toBeUndefined();
    expect(r2.duplicate).toBe(true);
    expect(await ledger.getSum(acc, ccy)).toBe("-10"); // applied once
  });
});
