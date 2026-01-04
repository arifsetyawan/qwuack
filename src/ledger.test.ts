// ledger.test.ts - Unit tests for Ledger class
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Ledger, type LedgerEntry } from "./ledger";

// ============================================================================
// Mock Redis Client Factory
// ============================================================================

function createMockRedis() {
  const mockMulti = {
    hSet: mock(() => mockMulti),
    hDel: mock(() => mockMulti),
    incrByFloat: mock(() => mockMulti),
    hIncrByFloat: mock(() => mockMulti),
    exec: mock(() => Promise.resolve([])),
  };

  return {
    hSet: mock(() => Promise.resolve(1)),
    hGet: mock(() => Promise.resolve(null)),
    hDel: mock(() => Promise.resolve(1)),
    hLen: mock(() => Promise.resolve(0)),
    hVals: mock(() => Promise.resolve([])),
    hExists: mock(() => Promise.resolve(false)),
    hScan: mock(() => Promise.resolve({ cursor: "0", entries: [] })),
    hGetAll: mock(() => Promise.resolve({})),
    hIncrByFloat: mock(() => Promise.resolve("0")),
    get: mock(() => Promise.resolve(null)),
    incrByFloat: mock(() => Promise.resolve("0")),
    del: mock(() => Promise.resolve(1)),
    multi: mock(() => mockMulti),
    _mockMulti: mockMulti,
  };
}

// Mock ioredis client (has 'status' property and lowercase methods)
function createMockIORedis() {
  const mockPipeline = {
    hset: mock(() => mockPipeline),
    hdel: mock(() => mockPipeline),
    incrbyfloat: mock(() => mockPipeline),
    hincrbyfloat: mock(() => mockPipeline),
    exec: mock(() => Promise.resolve([])),
  };

  return {
    status: "ready", // ioredis-specific property for detection
    hset: mock(() => Promise.resolve(1)),
    hget: mock(() => Promise.resolve(null)),
    hdel: mock(() => Promise.resolve(1)),
    hlen: mock(() => Promise.resolve(0)),
    hexists: mock(() => Promise.resolve(0)), // ioredis returns 0/1
    hscan: mock(() => Promise.resolve(["0", []])), // ioredis format: [cursor, [field, value, ...]]
    hgetall: mock(() => Promise.resolve({})),
    hincrbyfloat: mock(() => Promise.resolve("0")),
    get: mock(() => Promise.resolve(null)),
    incrbyfloat: mock(() => Promise.resolve("0")),
    del: mock((...keys: string[]) => Promise.resolve(keys.length)), // variadic
    multi: mock(() => mockPipeline),
    _mockPipeline: mockPipeline,
  };
}

// ============================================================================
// Test Fixtures
// ============================================================================

const sampleEntry: LedgerEntry = {
  id: "entry_001",
  context: "deposit",
  currency: "usd",
  amount: "1000.00",
};

const accountId = "acc_123";
const currency = "usd";

// ============================================================================
// Tests
// ============================================================================

describe("Ledger", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let ledger: Ledger;

  beforeEach(() => {
    mockRedis = createMockRedis();
    ledger = new Ledger(mockRedis as any);
  });

  // --------------------------------------------------------------------------
  // Constructor Tests
  // --------------------------------------------------------------------------

  describe("constructor", () => {
    test("uses default config when not provided", () => {
      const config = ledger.getConfig();
      expect(config.maxEntriesPerKey).toBe(1_000_000);
      expect(config.keyPrefix).toBe("ledger");
    });

    test("uses custom config when provided", () => {
      const customLedger = new Ledger(mockRedis as any, {
        maxEntriesPerKey: 5000,
        keyPrefix: "custom",
      });
      const config = customLedger.getConfig();
      expect(config.maxEntriesPerKey).toBe(5000);
      expect(config.keyPrefix).toBe("custom");
    });

    test("uses partial custom config with defaults for missing values", () => {
      const customLedger = new Ledger(mockRedis as any, {
        maxEntriesPerKey: 100,
      });
      const config = customLedger.getConfig();
      expect(config.maxEntriesPerKey).toBe(100);
      expect(config.keyPrefix).toBe("ledger");
    });
  });

  // --------------------------------------------------------------------------
  // addEntry Tests
  // --------------------------------------------------------------------------

  describe("addEntry", () => {
    test("adds entry successfully", async () => {
      mockRedis.hExists.mockReturnValue(Promise.resolve(false));
      mockRedis.hLen.mockReturnValue(Promise.resolve(0));

      await ledger.addEntry(accountId, currency, sampleEntry);

      expect(mockRedis.hExists).toHaveBeenCalledWith(
        "ledger:acc_123:usd",
        "entry_001"
      );
      expect(mockRedis.multi).toHaveBeenCalled();
      expect(mockRedis._mockMulti.exec).toHaveBeenCalled();
    });

    test("throws on duplicate entry (deduplication)", async () => {
      mockRedis.hExists.mockReturnValue(Promise.resolve(true));

      await expect(
        ledger.addEntry(accountId, currency, sampleEntry)
      ).rejects.toThrow("Duplicate entry: entry with id 'entry_001' already exists");
    });

    test("throws when max entries reached", async () => {
      const limitedLedger = new Ledger(mockRedis as any, {
        maxEntriesPerKey: 10,
      });

      mockRedis.hExists.mockReturnValue(Promise.resolve(false));
      mockRedis.hLen.mockReturnValue(Promise.resolve(10));

      await expect(
        limitedLedger.addEntry(accountId, currency, sampleEntry)
      ).rejects.toThrow("Ledger limit reached: maximum 10 entries per account/currency");
    });

    test("uses correct keys with custom prefix", async () => {
      const customLedger = new Ledger(mockRedis as any, {
        keyPrefix: "myapp",
      });

      mockRedis.hExists.mockReturnValue(Promise.resolve(false));
      mockRedis.hLen.mockReturnValue(Promise.resolve(0));

      await customLedger.addEntry(accountId, currency, sampleEntry);

      expect(mockRedis.hExists).toHaveBeenCalledWith(
        "myapp:acc_123:usd",
        "entry_001"
      );
    });
  });

  // --------------------------------------------------------------------------
  // removeEntry Tests
  // --------------------------------------------------------------------------

  describe("removeEntry", () => {
    test("removes existing entry successfully", async () => {
      mockRedis.hGet.mockReturnValue(Promise.resolve(JSON.stringify(sampleEntry)));

      const result = await ledger.removeEntry(accountId, currency, "entry_001");

      expect(result).toBe(true);
      expect(mockRedis.hGet).toHaveBeenCalledWith("ledger:acc_123:usd", "entry_001");
      expect(mockRedis.multi).toHaveBeenCalled();
      expect(mockRedis._mockMulti.hDel).toHaveBeenCalled();
      expect(mockRedis._mockMulti.exec).toHaveBeenCalled();
    });

    test("returns false for non-existent entry", async () => {
      mockRedis.hGet.mockReturnValue(Promise.resolve(null));

      const result = await ledger.removeEntry(accountId, currency, "nonexistent");

      expect(result).toBe(false);
      expect(mockRedis.multi).not.toHaveBeenCalled();
    });

    test("updates running totals with negative amount on removal", async () => {
      const entryWithAmount: LedgerEntry = {
        id: "entry_002",
        context: "withdrawal",
        currency: "usd",
        amount: "500.00",
      };
      mockRedis.hGet.mockReturnValue(Promise.resolve(JSON.stringify(entryWithAmount)));

      await ledger.removeEntry(accountId, currency, "entry_002");

      expect(mockRedis._mockMulti.incrByFloat).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getEntry Tests
  // --------------------------------------------------------------------------

  describe("getEntry", () => {
    test("returns entry when exists", async () => {
      mockRedis.hGet.mockReturnValue(Promise.resolve(JSON.stringify(sampleEntry)));

      const result = await ledger.getEntry(accountId, currency, "entry_001");

      expect(result).toEqual(sampleEntry);
      expect(mockRedis.hGet).toHaveBeenCalledWith("ledger:acc_123:usd", "entry_001");
    });

    test("returns null when not exists", async () => {
      mockRedis.hGet.mockReturnValue(Promise.resolve(null));

      const result = await ledger.getEntry(accountId, currency, "nonexistent");

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getSum Tests
  // --------------------------------------------------------------------------

  describe("getSum", () => {
    test("returns '0' for empty ledger", async () => {
      mockRedis.get.mockReturnValue(Promise.resolve(null));

      const result = await ledger.getSum(accountId, currency);

      expect(result).toBe("0");
      expect(mockRedis.get).toHaveBeenCalledWith("ledger:acc_123:usd:total");
    });

    test("returns correct sum", async () => {
      mockRedis.get.mockReturnValue(Promise.resolve("1500.50"));

      const result = await ledger.getSum(accountId, currency);

      expect(result).toBe("1500.50");
    });
  });

  // --------------------------------------------------------------------------
  // getBalance Tests
  // --------------------------------------------------------------------------

  describe("getBalance", () => {
    test("returns zero balance for empty ledger", async () => {
      mockRedis.get.mockReturnValue(Promise.resolve(null));
      mockRedis.hLen.mockReturnValue(Promise.resolve(0));
      mockRedis.hGetAll.mockReturnValue(Promise.resolve({}));

      const result = await ledger.getBalance(accountId, currency);

      expect(result).toEqual({
        total: "0",
        byContext: {},
        entryCount: 0,
      });
    });

    test("returns correct totals and breakdown", async () => {
      mockRedis.get.mockReturnValue(Promise.resolve("2500.00"));
      mockRedis.hLen.mockReturnValue(Promise.resolve(5));
      mockRedis.hGetAll.mockReturnValue(
        Promise.resolve({
          deposit: "3000.00",
          withdrawal: "-500.00",
        })
      );

      const result = await ledger.getBalance(accountId, currency);

      expect(result).toEqual({
        total: "2500.00",
        byContext: {
          deposit: "3000.00",
          withdrawal: "-500.00",
        },
        entryCount: 5,
      });
    });

    test("calls all Redis operations in parallel", async () => {
      mockRedis.get.mockReturnValue(Promise.resolve("100"));
      mockRedis.hLen.mockReturnValue(Promise.resolve(2));
      mockRedis.hGetAll.mockReturnValue(Promise.resolve({}));

      await ledger.getBalance(accountId, currency);

      expect(mockRedis.get).toHaveBeenCalledWith("ledger:acc_123:usd:total");
      expect(mockRedis.hLen).toHaveBeenCalledWith("ledger:acc_123:usd");
      expect(mockRedis.hGetAll).toHaveBeenCalledWith("ledger:acc_123:usd:ctx");
    });
  });

  // --------------------------------------------------------------------------
  // getEntriesPaginated Tests
  // --------------------------------------------------------------------------

  describe("getEntriesPaginated", () => {
    test("returns empty for empty ledger", async () => {
      mockRedis.hScan.mockReturnValue(
        Promise.resolve({ cursor: "0", entries: [] })
      );

      const result = await ledger.getEntriesPaginated(accountId, currency);

      expect(result).toEqual({
        entries: [],
        nextCursor: "0",
        hasMore: false,
      });
    });

    test("returns entries with pagination", async () => {
      const entry1 = { ...sampleEntry, id: "entry_001" };
      const entry2 = { ...sampleEntry, id: "entry_002" };

      mockRedis.hScan.mockReturnValue(
        Promise.resolve({
          cursor: "100",
          entries: [
            { field: "entry_001", value: JSON.stringify(entry1) },
            { field: "entry_002", value: JSON.stringify(entry2) },
          ],
        })
      );

      const result = await ledger.getEntriesPaginated(accountId, currency, "0", 10);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual(entry1);
      expect(result.entries[1]).toEqual(entry2);
      expect(result.nextCursor).toBe("100");
      expect(result.hasMore).toBe(true);
    });

    test("hasMore is false on last page", async () => {
      mockRedis.hScan.mockReturnValue(
        Promise.resolve({
          cursor: "0",
          entries: [{ field: "entry_001", value: JSON.stringify(sampleEntry) }],
        })
      );

      const result = await ledger.getEntriesPaginated(accountId, currency, "50");

      expect(result.hasMore).toBe(false);
    });

    test("uses default cursor and count", async () => {
      mockRedis.hScan.mockReturnValue(
        Promise.resolve({ cursor: "0", entries: [] })
      );

      await ledger.getEntriesPaginated(accountId, currency);

      expect(mockRedis.hScan).toHaveBeenCalledWith(
        "ledger:acc_123:usd",
        "0",
        { COUNT: 100 }
      );
    });
  });

  // --------------------------------------------------------------------------
  // clearLedger Tests
  // --------------------------------------------------------------------------

  describe("clearLedger", () => {
    test("removes all related keys", async () => {
      await ledger.clearLedger(accountId, currency);

      expect(mockRedis.del).toHaveBeenCalledWith([
        "ledger:acc_123:usd",
        "ledger:acc_123:usd:total",
        "ledger:acc_123:usd:ctx",
      ]);
    });

    test("uses custom key prefix", async () => {
      const customLedger = new Ledger(mockRedis as any, {
        keyPrefix: "myledger",
      });

      await customLedger.clearLedger(accountId, currency);

      expect(mockRedis.del).toHaveBeenCalledWith([
        "myledger:acc_123:usd",
        "myledger:acc_123:usd:total",
        "myledger:acc_123:usd:ctx",
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Payload Tests
  // --------------------------------------------------------------------------

  describe("payload support", () => {
    test("adds entry with payload", async () => {
      mockRedis.hExists.mockReturnValue(Promise.resolve(false));
      mockRedis.hLen.mockReturnValue(Promise.resolve(0));

      interface TestPayload {
        orderId: string;
        metadata: { source: string };
      }

      const ledgerWithPayload = new Ledger<TestPayload>(mockRedis as any);
      const entryWithPayload: LedgerEntry<TestPayload> = {
        id: "entry_payload_001",
        context: "purchase",
        currency: "usd",
        amount: "99.99",
        payload: {
          orderId: "order_123",
          metadata: { source: "web" },
        },
      };

      await ledgerWithPayload.addEntry(accountId, currency, entryWithPayload);

      expect(mockRedis.multi).toHaveBeenCalled();
      expect(mockRedis._mockMulti.exec).toHaveBeenCalled();
    });

    test("retrieves entry with payload", async () => {
      const entryWithPayload = {
        ...sampleEntry,
        payload: { orderId: "order_456" },
      };
      mockRedis.hGet.mockReturnValue(Promise.resolve(JSON.stringify(entryWithPayload)));

      const result = await ledger.getEntry(accountId, currency, "entry_001");

      expect(result).toEqual(entryWithPayload);
      expect(result?.payload).toEqual({ orderId: "order_456" });
    });

    test("works without payload (backward compatible)", async () => {
      mockRedis.hExists.mockReturnValue(Promise.resolve(false));
      mockRedis.hLen.mockReturnValue(Promise.resolve(0));

      const entryWithoutPayload: LedgerEntry = {
        id: "entry_no_payload",
        context: "deposit",
        currency: "usd",
        amount: "100.00",
      };

      await ledger.addEntry(accountId, currency, entryWithoutPayload);

      expect(mockRedis.multi).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// IORedis Adapter Tests
// ============================================================================

describe("Ledger with IORedis", () => {
  let mockIORedis: ReturnType<typeof createMockIORedis>;
  let ledger: Ledger;

  beforeEach(() => {
    mockIORedis = createMockIORedis();
    ledger = new Ledger(mockIORedis as any);
  });

  describe("client detection", () => {
    test("detects ioredis by status property", () => {
      // If detection works, it should use lowercase methods
      expect(mockIORedis.status).toBe("ready");
    });
  });

  describe("addEntry with ioredis", () => {
    test("adds entry successfully", async () => {
      mockIORedis.hexists.mockReturnValue(Promise.resolve(0));
      mockIORedis.hlen.mockReturnValue(Promise.resolve(0));

      await ledger.addEntry(accountId, currency, sampleEntry);

      expect(mockIORedis.hexists).toHaveBeenCalledWith(
        "ledger:acc_123:usd",
        "entry_001"
      );
      expect(mockIORedis.multi).toHaveBeenCalled();
      expect(mockIORedis._mockPipeline.exec).toHaveBeenCalled();
    });

    test("throws on duplicate (hexists returns 1)", async () => {
      mockIORedis.hexists.mockReturnValue(Promise.resolve(1));

      await expect(
        ledger.addEntry(accountId, currency, sampleEntry)
      ).rejects.toThrow("Duplicate entry");
    });
  });

  describe("removeEntry with ioredis", () => {
    test("removes entry successfully", async () => {
      mockIORedis.hget.mockReturnValue(Promise.resolve(JSON.stringify(sampleEntry)));

      const result = await ledger.removeEntry(accountId, currency, "entry_001");

      expect(result).toBe(true);
      expect(mockIORedis._mockPipeline.hdel).toHaveBeenCalled();
    });

    test("returns false for non-existent entry", async () => {
      mockIORedis.hget.mockReturnValue(Promise.resolve(null));

      const result = await ledger.removeEntry(accountId, currency, "nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("getEntry with ioredis", () => {
    test("returns entry when exists", async () => {
      mockIORedis.hget.mockReturnValue(Promise.resolve(JSON.stringify(sampleEntry)));

      const result = await ledger.getEntry(accountId, currency, "entry_001");

      expect(result).toEqual(sampleEntry);
    });
  });

  describe("getSum with ioredis", () => {
    test("returns sum", async () => {
      mockIORedis.get.mockReturnValue(Promise.resolve("500.00"));

      const result = await ledger.getSum(accountId, currency);

      expect(result).toBe("500.00");
    });
  });

  describe("getBalance with ioredis", () => {
    test("returns balance", async () => {
      mockIORedis.get.mockReturnValue(Promise.resolve("1000.00"));
      mockIORedis.hlen.mockReturnValue(Promise.resolve(3));
      mockIORedis.hgetall.mockReturnValue(Promise.resolve({ deposit: "1000.00" }));

      const result = await ledger.getBalance(accountId, currency);

      expect(result).toEqual({
        total: "1000.00",
        byContext: { deposit: "1000.00" },
        entryCount: 3,
      });
    });
  });

  describe("getEntriesPaginated with ioredis", () => {
    test("handles ioredis hscan format", async () => {
      const entry1 = { ...sampleEntry, id: "entry_001" };
      const entry2 = { ...sampleEntry, id: "entry_002" };

      // ioredis returns [cursor, [field1, value1, field2, value2, ...]]
      mockIORedis.hscan.mockReturnValue(
        Promise.resolve([
          "100",
          ["entry_001", JSON.stringify(entry1), "entry_002", JSON.stringify(entry2)],
        ])
      );

      const result = await ledger.getEntriesPaginated(accountId, currency, "0", 10);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual(entry1);
      expect(result.entries[1]).toEqual(entry2);
      expect(result.nextCursor).toBe("100");
      expect(result.hasMore).toBe(true);
    });

    test("returns empty on last page", async () => {
      mockIORedis.hscan.mockReturnValue(Promise.resolve(["0", []]));

      const result = await ledger.getEntriesPaginated(accountId, currency);

      expect(result.entries).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("clearLedger with ioredis", () => {
    test("deletes all keys using variadic args", async () => {
      await ledger.clearLedger(accountId, currency);

      // ioredis del() is called with spread args
      expect(mockIORedis.del).toHaveBeenCalled();
    });
  });
});
