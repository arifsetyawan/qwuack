// src/ledger.ts
function createNodeRedisAdapter(client) {
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
      const adapter = {
        hSet: (k, f, v) => {
          m.hSet(k, f, v);
          return adapter;
        },
        hDel: (k, f) => {
          m.hDel(k, f);
          return adapter;
        },
        incrByFloat: (k, inc) => {
          m.incrByFloat(k, inc);
          return adapter;
        },
        hIncrByFloat: (k, f, inc) => {
          m.hIncrByFloat(k, f, inc);
          return adapter;
        },
        exec: () => m.exec()
      };
      return adapter;
    }
  };
}
function createIORedisAdapter(client) {
  return {
    hSet: (key, field, value) => client.hset(key, field, value),
    hGet: (key, field) => client.hget(key, field),
    hExists: async (key, field) => await client.hexists(key, field) === 1,
    hLen: (key) => client.hlen(key),
    hGetAll: (key) => client.hgetall(key),
    hDel: (key, field) => client.hdel(key, field),
    hIncrByFloat: (key, field, increment) => client.hincrbyfloat(key, field, increment),
    hScan: async (key, cursor, options) => {
      const [nextCursor, items] = await client.hscan(key, cursor, "COUNT", options.COUNT);
      const entries = [];
      for (let i = 0;i < items.length; i += 2) {
        entries.push({ field: items[i], value: items[i + 1] });
      }
      return { cursor: nextCursor, entries };
    },
    get: (key) => client.get(key),
    incrByFloat: (key, increment) => client.incrbyfloat(key, increment),
    del: (keys) => client.del(...keys),
    multi: () => {
      const pipeline = client.multi();
      const adapter = {
        hSet: (k, f, v) => {
          pipeline.hset(k, f, v);
          return adapter;
        },
        hDel: (k, f) => {
          pipeline.hdel(k, f);
          return adapter;
        },
        incrByFloat: (k, inc) => {
          pipeline.incrbyfloat(k, inc);
          return adapter;
        },
        hIncrByFloat: (k, f, inc) => {
          pipeline.hincrbyfloat(k, f, inc);
          return adapter;
        },
        exec: () => pipeline.exec()
      };
      return adapter;
    }
  };
}
function createRedisAdapter(client) {
  const isIORedis = typeof client.status === "string";
  if (isIORedis) {
    return createIORedisAdapter(client);
  }
  return createNodeRedisAdapter(client);
}
var DEFAULT_CONFIG = {
  maxEntriesPerKey: 1e6,
  keyPrefix: "ledger"
};

class Ledger {
  adapter;
  config;
  constructor(redis, config) {
    this.adapter = createRedisAdapter(redis);
    this.config = {
      maxEntriesPerKey: config?.maxEntriesPerKey ?? DEFAULT_CONFIG.maxEntriesPerKey,
      keyPrefix: config?.keyPrefix ?? DEFAULT_CONFIG.keyPrefix
    };
  }
  getLedgerKey(accountId, currency) {
    return `${this.config.keyPrefix}:${accountId}:${currency}`;
  }
  getTotalKey(accountId, currency) {
    return `${this.config.keyPrefix}:${accountId}:${currency}:total`;
  }
  getContextKey(accountId, currency) {
    return `${this.config.keyPrefix}:${accountId}:${currency}:ctx`;
  }
  async addEntry(accountId, currency, entry) {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);
    const exists = await this.adapter.hExists(key, entry.id);
    if (exists) {
      throw new Error(`Duplicate entry: entry with id '${entry.id}' already exists`);
    }
    const count = await this.adapter.hLen(key);
    if (count >= this.config.maxEntriesPerKey) {
      throw new Error(`Ledger limit reached: maximum ${this.config.maxEntriesPerKey} entries per account/currency`);
    }
    await this.adapter.multi().hSet(key, entry.id, JSON.stringify(entry)).incrByFloat(totalKey, parseFloat(entry.amount)).hIncrByFloat(ctxKey, entry.context, parseFloat(entry.amount)).exec();
  }
  async removeEntry(accountId, currency, entryId) {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);
    const raw = await this.adapter.hGet(key, entryId);
    if (!raw) {
      return false;
    }
    const entry = JSON.parse(raw);
    const amount = parseFloat(entry.amount);
    await this.adapter.multi().hDel(key, entryId).incrByFloat(totalKey, -amount).hIncrByFloat(ctxKey, entry.context, -amount).exec();
    return true;
  }
  async getEntry(accountId, currency, entryId) {
    const key = this.getLedgerKey(accountId, currency);
    const raw = await this.adapter.hGet(key, entryId);
    return raw ? JSON.parse(raw) : null;
  }
  async getSum(accountId, currency) {
    const totalKey = this.getTotalKey(accountId, currency);
    const total = await this.adapter.get(totalKey);
    return total ?? "0";
  }
  async getBalance(accountId, currency) {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);
    const [total, entryCount, byContext] = await Promise.all([
      this.adapter.get(totalKey),
      this.adapter.hLen(key),
      this.adapter.hGetAll(ctxKey)
    ]);
    return {
      total: total ?? "0",
      byContext,
      entryCount
    };
  }
  async getEntriesPaginated(accountId, currency, cursor = "0", count = 100) {
    const key = this.getLedgerKey(accountId, currency);
    const result = await this.adapter.hScan(key, cursor, { COUNT: count });
    const entries = [];
    for (const item of result.entries) {
      entries.push(JSON.parse(item.value));
    }
    return {
      entries,
      nextCursor: result.cursor,
      hasMore: result.cursor !== "0"
    };
  }
  async clearLedger(accountId, currency) {
    const key = this.getLedgerKey(accountId, currency);
    const totalKey = this.getTotalKey(accountId, currency);
    const ctxKey = this.getContextKey(accountId, currency);
    await this.adapter.del([key, totalKey, ctxKey]);
  }
  getConfig() {
    return { ...this.config };
  }
}
export {
  Ledger
};

//# debugId=EABE26211F8F122264756E2164756E21
