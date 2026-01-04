// ledger.ts - Redis-backed ledger with running totals optimization
// Supports both node-redis and ioredis clients

// ============================================================================
// Types
// ============================================================================

export interface LedgerEntry {
  id: string;
  context: string;
  currency: string;
  amount: string;
}

export interface BalanceResult {
  total: string;
  byContext: Record<string, string>;
  entryCount: number;
}

export interface PaginatedResult {
  entries: LedgerEntry[];
  nextCursor: string;
  hasMore: boolean;
}

export interface LedgerConfig {
  maxEntriesPerKey?: number;
  keyPrefix?: string;
}

interface RequiredLedgerConfig {
  maxEntriesPerKey: number;
  keyPrefix: string;
}

// ============================================================================
// Redis Adapter Types
// ============================================================================

interface HScanResult {
  cursor: string;
  entries: Array<{ field: string; value: string }>;
}

interface MultiAdapter {
  hSet(key: string, field: string, value: string): MultiAdapter;
  hDel(key: string, field: string): MultiAdapter;
  incrByFloat(key: string, increment: number): MultiAdapter;
  hIncrByFloat(key: string, field: string, increment: number): MultiAdapter;
  exec(): Promise<unknown[]>;
}

interface RedisAdapter {
  hSet(key: string, field: string, value: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null>;
  hExists(key: string, field: string): Promise<boolean>;
  hLen(key: string): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string): Promise<number>;
  hIncrByFloat(key: string, field: string, increment: number): Promise<string>;
  hScan(key: string, cursor: string, options: { COUNT: number }): Promise<HScanResult>;
  get(key: string): Promise<string | null>;
  incrByFloat(key: string, increment: number): Promise<string>;
  del(keys: string[]): Promise<number>;
  multi(): MultiAdapter;
}

// ============================================================================
// Redis Adapter Implementations
// ============================================================================

function createNodeRedisAdapter(client: any): RedisAdapter {
  return {
    hSet: (key, field, value) => client.hSet(key, field, value),
    hGet: (key, field) => client.hGet(key, field),
    hExists: (key, field) => client.hExists(key, field),
    hLen: (key) => client.hLen(key),
    hGetAll: (key) => client.hGetAll(key),
    hDel: (key, field) => client.hDel(key, field),
    hIncrByFloat: (key, field, increment) => client.hIncrByFloat(key, field, increment),
    hScan: (key, cursor, options) => client.hScan(key, cursor, options),
    get: (key) => client.get(key),
    incrByFloat: (key, increment) => client.incrByFloat(key, increment),
    del: (keys) => client.del(keys),
    multi: () => {
      const m = client.multi();
      const adapter: MultiAdapter = {
        hSet: (k, f, v) => { m.hSet(k, f, v); return adapter; },
        hDel: (k, f) => { m.hDel(k, f); return adapter; },
        incrByFloat: (k, inc) => { m.incrByFloat(k, inc); return adapter; },
        hIncrByFloat: (k, f, inc) => { m.hIncrByFloat(k, f, inc); return adapter; },
        exec: () => m.exec(),
      };
      return adapter;
    },
  };
}

function createIORedisAdapter(client: any): RedisAdapter {
  return {
    hSet: (key, field, value) => client.hset(key, field, value),
    hGet: (key, field) => client.hget(key, field),
    hExists: async (key, field) => (await client.hexists(key, field)) === 1,
    hLen: (key) => client.hlen(key),
    hGetAll: (key) => client.hgetall(key),
    hDel: (key, field) => client.hdel(key, field),
    hIncrByFloat: (key, field, increment) => client.hincrbyfloat(key, field, increment),
    hScan: async (key, cursor, options) => {
      const [nextCursor, items] = await client.hscan(key, cursor, "COUNT", options.COUNT);
      const entries: Array<{ field: string; value: string }> = [];
      for (let i = 0; i < items.length; i += 2) {
        entries.push({ field: items[i], value: items[i + 1] });
      }
      return { cursor: nextCursor, entries };
    },
    get: (key) => client.get(key),
    incrByFloat: (key, increment) => client.incrbyfloat(key, increment),
    del: (keys) => client.del(...keys),
    multi: () => {
      const pipeline = client.multi();
      const adapter: MultiAdapter = {
        hSet: (k, f, v) => { pipeline.hset(k, f, v); return adapter; },
        hDel: (k, f) => { pipeline.hdel(k, f); return adapter; },
        incrByFloat: (k, inc) => { pipeline.incrbyfloat(k, inc); return adapter; },
        hIncrByFloat: (k, f, inc) => { pipeline.hincrbyfloat(k, f, inc); return adapter; },
        exec: () => pipeline.exec(),
      };
      return adapter;
    },
  };
}

function createRedisAdapter(client: unknown): RedisAdapter {
  // Detect ioredis by checking for 'status' property (ioredis-specific)
  const isIORedis = typeof (client as any).status === "string";

  if (isIORedis) {
    return createIORedisAdapter(client);
  }
  return createNodeRedisAdapter(client);
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: RequiredLedgerConfig = {
  maxEntriesPerKey: 1_000_000,
  keyPrefix: "ledger",
};

// ============================================================================
// Ledger Class
// ============================================================================

export class Ledger {
  private adapter: RedisAdapter;
  private config: RequiredLedgerConfig;

  constructor(redis: unknown, config?: LedgerConfig) {
    this.adapter = createRedisAdapter(redis);
    this.config = {
      maxEntriesPerKey: config?.maxEntriesPerKey ?? DEFAULT_CONFIG.maxEntriesPerKey,
      keyPrefix: config?.keyPrefix ?? DEFAULT_CONFIG.keyPrefix,
    };
  }

  // --------------------------------------------------------------------------
  // Key Helpers
  // --------------------------------------------------------------------------

  private getLedgerKey(accountId: string, currency: string): string {
    return `${this.config.keyPrefix}:${accountId}:${currency}`;
  }

  private getTotalKey(accountId: string, currency: string): string {
    return `${this.config.keyPrefix}:${accountId}:${currency}:total`;
  }

  private getContextKey(accountId: string, currency: string): string {
    return `${this.config.keyPrefix}:${accountId}:${currency}:ctx`;
  }

  // --------------------------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------------------------

  async addEntry(
    accountId: string,
    currency: string,
    entry: LedgerEntry
  ): Promise<void> {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);

    // Check for duplicate entry (deduplication)
    const exists = await this.adapter.hExists(key, entry.id);
    if (exists) {
      throw new Error(`Duplicate entry: entry with id '${entry.id}' already exists`);
    }

    // Check entry limit
    const count = await this.adapter.hLen(key);
    if (count >= this.config.maxEntriesPerKey) {
      throw new Error(
        `Ledger limit reached: maximum ${this.config.maxEntriesPerKey} entries per account/currency`
      );
    }

    // Atomic transaction: add entry + update running totals
    await this.adapter
      .multi()
      .hSet(key, entry.id, JSON.stringify(entry))
      .incrByFloat(totalKey, parseFloat(entry.amount))
      .hIncrByFloat(ctxKey, entry.context, parseFloat(entry.amount))
      .exec();
  }

  async removeEntry(
    accountId: string,
    currency: string,
    entryId: string
  ): Promise<boolean> {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);

    // Get entry first to know amount and context
    const raw = await this.adapter.hGet(key, entryId);
    if (!raw) {
      return false;
    }

    const entry: LedgerEntry = JSON.parse(raw);
    const amount = parseFloat(entry.amount);

    // Atomic transaction: remove entry + update running totals
    await this.adapter
      .multi()
      .hDel(key, entryId)
      .incrByFloat(totalKey, -amount)
      .hIncrByFloat(ctxKey, entry.context, -amount)
      .exec();

    return true;
  }

  // --------------------------------------------------------------------------
  // Read Operations (O(1) using running totals)
  // --------------------------------------------------------------------------

  async getEntry(
    accountId: string,
    currency: string,
    entryId: string
  ): Promise<LedgerEntry | null> {
    const key = this.getLedgerKey(accountId, currency);
    const raw = await this.adapter.hGet(key, entryId);
    return raw ? JSON.parse(raw) : null;
  }

  async getSum(accountId: string, currency: string): Promise<string> {
    const totalKey = this.getTotalKey(accountId, currency);
    const total = await this.adapter.get(totalKey);
    return total ?? "0";
  }

  async getBalance(accountId: string, currency: string): Promise<BalanceResult> {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);

    // Parallel fetch - O(1) operations
    const [total, entryCount, byContext] = await Promise.all([
      this.adapter.get(totalKey),
      this.adapter.hLen(key),
      this.adapter.hGetAll(ctxKey),
    ]);

    return {
      total: total ?? "0",
      byContext: byContext as Record<string, string>,
      entryCount,
    };
  }

  // --------------------------------------------------------------------------
  // Pagination
  // --------------------------------------------------------------------------

  async getEntriesPaginated(
    accountId: string,
    currency: string,
    cursor: string = "0",
    count: number = 100
  ): Promise<PaginatedResult> {
    const key = this.getLedgerKey(accountId, currency);
    const result = await this.adapter.hScan(key, cursor, { COUNT: count });

    const entries: LedgerEntry[] = [];
    for (const item of result.entries) {
      entries.push(JSON.parse(item.value));
    }

    return {
      entries,
      nextCursor: result.cursor,
      hasMore: result.cursor !== "0",
    };
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  async clearLedger(accountId: string, currency: string): Promise<void> {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);

    // Delete all related keys atomically
    await this.adapter.del([key, totalKey, ctxKey]);
  }

  // --------------------------------------------------------------------------
  // Getters for testing/debugging
  // --------------------------------------------------------------------------

  getConfig(): RequiredLedgerConfig {
    return { ...this.config };
  }
}
