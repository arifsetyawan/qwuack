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
