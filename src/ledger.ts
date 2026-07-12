// ledger.ts - Redis-backed ledger with running totals optimization
// Supports both node-redis and ioredis clients

// ============================================================================
// Types
// ============================================================================

export type EntryState = "pending" | "confirmed";

export interface LedgerEntry<TPayload = Record<string, unknown>> {
  id: string;
  context: string;
  currency: string;
  amount: string;
  payload?: TPayload;
  state?: EntryState;
  pendingExpiresAt?: number;
  confirmedAt?: number;
  held?: boolean;
}

export interface BalanceResult {
  total: string;
  byContext: Record<string, string>;
  entryCount: number;
}

export interface PaginatedResult<TPayload = Record<string, unknown>> {
  entries: LedgerEntry<TPayload>[];
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
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
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
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
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
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
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

export const DEFAULT_PENDING_TTL_MS = 600_000;

// KEYS[1]=entries KEYS[2]=:ctx
// ARGV[1]=entryId ARGV[2]=entryJSON ARGV[3]=amount ARGV[4]=context ARGV[5]=maxEntries
const ADD_PENDING_ENTRY_LUA = `
local maxEntries = tonumber(ARGV[5])
if maxEntries and maxEntries > 0 and redis.call('HLEN', KEYS[1]) >= maxEntries then
  return redis.error_reply('LEDGER_LIMIT_REACHED')
end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return cjson.encode({ duplicate = true })
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HINCRBYFLOAT', KEYS[2], ARGV[4], ARGV[3])
return cjson.encode({ duplicate = false })
`;

// KEYS[1]=entries KEYS[2]=:total KEYS[3]=:ctx KEYS[4]=:hold
// ARGV[1]=entryId ARGV[2]=entryJSON ARGV[3]=amount ARGV[4]=context ARGV[5]=floor ARGV[6]=maxEntries
const ADD_PENDING_IF_SUFFICIENT_LUA = `
local maxEntries = tonumber(ARGV[6])
if maxEntries and maxEntries > 0 and redis.call('HLEN', KEYS[1]) >= maxEntries then
  return redis.error_reply('LEDGER_LIMIT_REACHED')
end
local total = tonumber(redis.call('GET', KEYS[2]) or '0')
local hold = tonumber(redis.call('GET', KEYS[4]) or '0')
local avail = total + hold
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return cjson.encode({ success = true, duplicate = true, currentSum = tostring(avail) })
end
local amount = tonumber(ARGV[3])
local floor = tonumber(ARGV[5])
if (avail + amount) < floor then
  return cjson.encode({ success = false, reason = 'INSUFFICIENT_BALANCE', currentSum = tostring(avail) })
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('INCRBYFLOAT', KEYS[4], ARGV[3])
redis.call('HINCRBYFLOAT', KEYS[3], ARGV[4], ARGV[3])
return cjson.encode({ success = true, currentSum = tostring(avail + amount) })
`;

// KEYS[1]=entries KEYS[2]=:total KEYS[3]=:hold
// ARGV[1]=entryId ARGV[2]=confirmedAt(ms)
const CONFIRM_ENTRY_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return cjson.encode({ status = 'not_found' })
end
local entry = cjson.decode(raw)
if entry.state ~= 'pending' then
  return cjson.encode({ status = 'already_confirmed' })
end
local amount = tonumber(entry.amount)
if entry.held == true then
  redis.call('INCRBYFLOAT', KEYS[3], -amount)
end
redis.call('INCRBYFLOAT', KEYS[2], entry.amount)
entry.state = 'confirmed'
entry.confirmedAt = tonumber(ARGV[2])
entry.pendingExpiresAt = nil
entry.held = nil
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(entry))
return cjson.encode({ status = 'confirmed' })
`;

// KEYS[1]=entries KEYS[2]=:ctx KEYS[3]=:hold
// ARGV[1]=entryId
const CANCEL_ENTRY_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return cjson.encode({ status = 'not_found' })
end
local entry = cjson.decode(raw)
if entry.state ~= 'pending' then
  return cjson.encode({ status = 'not_pending' })
end
local amount = tonumber(entry.amount)
if entry.held == true then
  redis.call('INCRBYFLOAT', KEYS[3], -amount)
end
redis.call('HINCRBYFLOAT', KEYS[2], entry.context, -amount)
redis.call('HDEL', KEYS[1], ARGV[1])
return cjson.encode({ status = 'cancelled' })
`;

// ============================================================================
// Ledger Class
// ============================================================================

export class Ledger<TPayload = Record<string, unknown>> {
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
    entry: LedgerEntry<TPayload>
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

  private getHoldKey(accountId: string, currency: string): string {
    return `${this.config.keyPrefix}:${accountId}:${currency}:hold`;
  }

  async addPendingEntry(
    accountId: string,
    currency: string,
    entry: LedgerEntry<TPayload>,
    options?: { pendingTtlMs?: number }
  ): Promise<{ duplicate: boolean }> {
    const ttl = options?.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    const stamped: LedgerEntry<TPayload> = {
      ...entry,
      state: "pending",
      pendingExpiresAt: Date.now() + ttl,
    };
    const raw = await this.adapter.eval(
      ADD_PENDING_ENTRY_LUA,
      [this.getLedgerKey(accountId, currency), this.getContextKey(accountId, currency)],
      [entry.id, JSON.stringify(stamped), entry.amount, entry.context, String(this.config.maxEntriesPerKey)]
    );
    return JSON.parse(raw as string);
  }

  async addPendingEntryIfSufficient(
    accountId: string,
    currency: string,
    entry: LedgerEntry<TPayload>,
    floor: string | number,
    options?: { pendingTtlMs?: number }
  ): Promise<{ success: boolean; duplicate?: boolean; reason?: string; currentSum: string }> {
    const ttl = options?.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    const stamped: LedgerEntry<TPayload> = {
      ...entry,
      state: "pending",
      pendingExpiresAt: Date.now() + ttl,
      held: true,
    };
    const raw = await this.adapter.eval(
      ADD_PENDING_IF_SUFFICIENT_LUA,
      [
        this.getLedgerKey(accountId, currency),
        this.getTotalKey(accountId, currency),
        this.getContextKey(accountId, currency),
        this.getHoldKey(accountId, currency),
      ],
      [
        entry.id,
        JSON.stringify(stamped),
        entry.amount,
        entry.context,
        String(floor),
        String(this.config.maxEntriesPerKey),
      ]
    );
    return JSON.parse(raw as string);
  }

  async confirmEntry(
    accountId: string,
    currency: string,
    entryId: string
  ): Promise<{ status: "confirmed" | "already_confirmed" | "not_found" }> {
    const raw = await this.adapter.eval(
      CONFIRM_ENTRY_LUA,
      [
        this.getLedgerKey(accountId, currency),
        this.getTotalKey(accountId, currency),
        this.getHoldKey(accountId, currency),
      ],
      [entryId, String(Date.now())]
    );
    return JSON.parse(raw as string);
  }

  async cancelEntry(
    accountId: string,
    currency: string,
    entryId: string
  ): Promise<{ status: "cancelled" | "not_pending" | "not_found" }> {
    const raw = await this.adapter.eval(
      CANCEL_ENTRY_LUA,
      [
        this.getLedgerKey(accountId, currency),
        this.getContextKey(accountId, currency),
        this.getHoldKey(accountId, currency),
      ],
      [entryId]
    );
    return JSON.parse(raw as string);
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

    const entry: LedgerEntry<TPayload> = JSON.parse(raw);
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
  ): Promise<LedgerEntry<TPayload> | null> {
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
  ): Promise<PaginatedResult<TPayload>> {
    const key = this.getLedgerKey(accountId, currency);
    const result = await this.adapter.hScan(key, cursor, { COUNT: count });

    const entries: LedgerEntry<TPayload>[] = [];
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

export default Ledger;
