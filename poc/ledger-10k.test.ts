// ledger-10k.test.ts - Integration tests (requires Redis at REDIS_URL; Bun loads .env)
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  addEntry,
  removeEntry,
  getEntry,
  getSum,
  getBalance,
  getEntriesPaginated,
  clearLedger,
  quitAll,
} from "./ledger-10k";

const ACC = "test_10k";
const CUR = "usd";

function entry(id: string, amount: string, context = "test") {
  return { id, context, currency: CUR, amount };
}

beforeEach(async () => {
  await clearLedger(ACC, CUR);
});

afterAll(async () => {
  await clearLedger(ACC, CUR);
  await quitAll();
});

describe("core operations", () => {
  test("addEntry then getEntry round-trips", async () => {
    await addEntry(ACC, CUR, entry("e1", "1000", "funding"));
    const got = await getEntry(ACC, CUR, "e1");
    expect(got).toEqual({ id: "e1", context: "funding", currency: CUR, amount: "1000" });
  });

  test("duplicate id is rejected and total unchanged", async () => {
    await addEntry(ACC, CUR, entry("dup", "5"));
    await expect(addEntry(ACC, CUR, entry("dup", "5"))).rejects.toThrow("Duplicate entry");
    expect(await getSum(ACC, CUR)).toBe("5");
  });

  test("running total tracks adds and negative-amount removal", async () => {
    await addEntry(ACC, CUR, entry("a", "1000"));
    await addEntry(ACC, CUR, entry("b", "-250"));
    expect(await getSum(ACC, CUR)).toBe("750");
    expect(await removeEntry(ACC, CUR, "b")).toBe(true);
    expect(await getSum(ACC, CUR)).toBe("1000");
  });

  test("removeEntry returns false for missing id", async () => {
    expect(await removeEntry(ACC, CUR, "nope")).toBe(false);
  });

  test("getBalance aggregates by context", async () => {
    await addEntry(ACC, CUR, entry("f1", "1000", "funding"));
    await addEntry(ACC, CUR, entry("f2", "500", "funding"));
    await addEntry(ACC, CUR, entry("p1", "-250", "payout"));
    const bal = await getBalance(ACC, CUR);
    expect(bal.total).toBe("1250");
    expect(bal.entryCount).toBe(3);
    expect(bal.byContext.funding).toBe("1500");
    expect(bal.byContext.payout).toBe("-250");
  });

  test("pagination walks all entries", async () => {
    for (let i = 0; i < 25; i++) {
      await addEntry(ACC, CUR, entry(`p-${i}`, "1"));
    }
    const seen: string[] = [];
    let cursor = "0";
    do {
      const page = await getEntriesPaginated(ACC, CUR, cursor, 10);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== "0");
    expect(new Set(seen).size).toBe(25);
  });

  test("entry limit is enforced via LEDGER_MAX_ENTRIES", async () => {
    process.env.LEDGER_MAX_ENTRIES = "3";
    try {
      for (let i = 0; i < 3; i++) {
        await addEntry(ACC, CUR, entry(`lim-${i}`, "1"));
      }
      await expect(addEntry(ACC, CUR, entry("lim-3", "1"))).rejects.toThrow(
        "Ledger limit reached"
      );
    } finally {
      delete process.env.LEDGER_MAX_ENTRIES;
    }
  });
});
