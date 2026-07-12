// ledger.pending.test.ts - two-phase (pending/confirmed) op wiring tests
import { describe, test, expect, mock } from "bun:test";
import { Ledger, type LedgerEntry } from "./ledger";

function createMockIORedisEval(evalResult: unknown) {
  return {
    status: "ready",
    eval: mock(() => Promise.resolve(evalResult)),
    get: mock(() => Promise.resolve(null)),
    mget: mock(() => Promise.resolve([null, null])),
    hget: mock(() => Promise.resolve(null)),
    hscan: mock(() => Promise.resolve(["0", []])),
  } as any;
}

const entry: LedgerEntry = { id: "e1", context: "credit", currency: "usd", amount: "100" };

describe("addPendingEntry", () => {
  test("evals with entries+ctx keys and pending-stamped JSON", async () => {
    const client = createMockIORedisEval(JSON.stringify({ duplicate: false }));
    const ledger = new Ledger(client, { keyPrefix: "led" });
    const before = Date.now();
    const result = await ledger.addPendingEntry("acc", "usd", entry, { pendingTtlMs: 60000 });

    expect(result).toEqual({ duplicate: false });
    const [script, keys, args] = client.eval.mock.calls[0] as any;
    // ioredis adapter call shape: (script, numKeys, ...keys, ...args)
    expect(client.eval.mock.calls[0][1]).toBe(2);
    expect(client.eval.mock.calls[0][2]).toBe("led:acc:usd");
    expect(client.eval.mock.calls[0][3]).toBe("led:acc:usd:ctx");
    expect(client.eval.mock.calls[0][4]).toBe("e1");
    const storedJson = JSON.parse(client.eval.mock.calls[0][5]);
    expect(storedJson.state).toBe("pending");
    expect(storedJson.pendingExpiresAt).toBeGreaterThanOrEqual(before + 60000);
    expect(client.eval.mock.calls[0][6]).toBe("100");     // amount
    expect(client.eval.mock.calls[0][7]).toBe("credit");  // context
  });

  test("returns duplicate:true on redelivery", async () => {
    const client = createMockIORedisEval(JSON.stringify({ duplicate: true }));
    const ledger = new Ledger(client);
    const result = await ledger.addPendingEntry("acc", "usd", entry);
    expect(result).toEqual({ duplicate: true });
  });
});

describe("addPendingEntryIfSufficient", () => {
  const debit: LedgerEntry = { id: "d1", context: "transaction/conversion", currency: "usd", amount: "-40" };

  test("evals with entries/total/ctx/hold keys and floor", async () => {
    const client = createMockIORedisEval(JSON.stringify({ success: true, currentSum: "-40" }));
    const ledger = new Ledger(client, { keyPrefix: "led", maxEntriesPerKey: 500 });
    const result = await ledger.addPendingEntryIfSufficient("acc", "usd", debit, "-100");

    expect(result.success).toBe(true);
    expect(client.eval.mock.calls[0][1]).toBe(4); // numKeys
    expect(client.eval.mock.calls[0].slice(2, 6)).toEqual([
      "led:acc:usd", "led:acc:usd:total", "led:acc:usd:ctx", "led:acc:usd:hold",
    ]);
    expect(client.eval.mock.calls[0][6]).toBe("d1");
    const storedJson = JSON.parse(client.eval.mock.calls[0][7]);
    expect(storedJson.state).toBe("pending");
    expect(client.eval.mock.calls[0][8]).toBe("-40");   // amount
    expect(client.eval.mock.calls[0][9]).toBe("transaction/conversion");
    expect(client.eval.mock.calls[0][10]).toBe("-100"); // floor
    expect(client.eval.mock.calls[0][11]).toBe("500");  // maxEntries
  });

  test("parses insufficient result", async () => {
    const client = createMockIORedisEval(
      JSON.stringify({ success: false, reason: "INSUFFICIENT_BALANCE", currentSum: "-90" })
    );
    const ledger = new Ledger(client);
    const result = await ledger.addPendingEntryIfSufficient("acc", "usd", debit, "-100");
    expect(result).toEqual({ success: false, reason: "INSUFFICIENT_BALANCE", currentSum: "-90" });
  });
});
