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
    mGet: (keys) => client.mGet(keys),
    incrByFloat: (key, increment) => client.incrByFloat(key, increment),
    del: (keys) => client.del(keys),
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
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
    mGet: (keys) => client.mget(...keys),
    incrByFloat: (key, increment) => client.incrbyfloat(key, increment),
    del: (keys) => client.del(...keys),
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
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
var DEFAULT_PENDING_TTL_MS = 600000;
var ADD_PENDING_ENTRY_LUA = `
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
var ADD_PENDING_IF_SUFFICIENT_LUA = `
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
var CONFIRM_ENTRY_LUA = `
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
var REMOVE_CONFIRMED_ENTRY_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return 0
end
local entry = cjson.decode(raw)
if entry.state == 'pending' then
  return -1
end
local neg = -tonumber(entry.amount)
redis.call('INCRBYFLOAT', KEYS[2], tostring(neg))
redis.call('HINCRBYFLOAT', KEYS[3], entry.context, neg)
redis.call('HDEL', KEYS[1], ARGV[1])
return 1
`;
var CANCEL_ENTRY_LUA = `
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
  getHoldKey(accountId, currency) {
    return `${this.config.keyPrefix}:${accountId}:${currency}:hold`;
  }
  async addPendingEntry(accountId, currency, entry, options) {
    const ttl = options?.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    const stamped = {
      ...entry,
      state: "pending",
      pendingExpiresAt: Date.now() + ttl
    };
    const raw = await this.adapter.eval(ADD_PENDING_ENTRY_LUA, [this.getLedgerKey(accountId, currency), this.getContextKey(accountId, currency)], [entry.id, JSON.stringify(stamped), entry.amount, entry.context, String(this.config.maxEntriesPerKey)]);
    return JSON.parse(raw);
  }
  async addPendingEntryIfSufficient(accountId, currency, entry, floor, options) {
    const ttl = options?.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    const stamped = {
      ...entry,
      state: "pending",
      pendingExpiresAt: Date.now() + ttl,
      held: true
    };
    const raw = await this.adapter.eval(ADD_PENDING_IF_SUFFICIENT_LUA, [
      this.getLedgerKey(accountId, currency),
      this.getTotalKey(accountId, currency),
      this.getContextKey(accountId, currency),
      this.getHoldKey(accountId, currency)
    ], [
      entry.id,
      JSON.stringify(stamped),
      entry.amount,
      entry.context,
      String(floor),
      String(this.config.maxEntriesPerKey)
    ]);
    return JSON.parse(raw);
  }
  async confirmEntry(accountId, currency, entryId) {
    const raw = await this.adapter.eval(CONFIRM_ENTRY_LUA, [
      this.getLedgerKey(accountId, currency),
      this.getTotalKey(accountId, currency),
      this.getHoldKey(accountId, currency)
    ], [entryId, String(Date.now())]);
    return JSON.parse(raw);
  }
  async cancelEntry(accountId, currency, entryId) {
    const raw = await this.adapter.eval(CANCEL_ENTRY_LUA, [
      this.getLedgerKey(accountId, currency),
      this.getContextKey(accountId, currency),
      this.getHoldKey(accountId, currency)
    ], [entryId]);
    return JSON.parse(raw);
  }
  async removeEntry(accountId, currency, entryId) {
    const result = await this.adapter.eval(REMOVE_CONFIRMED_ENTRY_LUA, [
      this.getLedgerKey(accountId, currency),
      this.getTotalKey(accountId, currency),
      this.getContextKey(accountId, currency)
    ], [entryId]);
    return Number(result) === 1;
  }
  async getEntry(accountId, currency, entryId) {
    const key = this.getLedgerKey(accountId, currency);
    const raw = await this.adapter.hGet(key, entryId);
    return raw ? JSON.parse(raw) : null;
  }
  async getSum(accountId, currency) {
    const [total, hold] = await this.adapter.mGet([
      this.getTotalKey(accountId, currency),
      this.getHoldKey(accountId, currency)
    ]);
    return String(Number(total ?? "0") + Number(hold ?? "0"));
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
    await this.adapter.del([key, totalKey, ctxKey, this.getHoldKey(accountId, currency)]);
  }
  getConfig() {
    return { ...this.config };
  }
}
var ledger_default = Ledger;
export {
  ledger_default as default,
  Ledger,
  DEFAULT_PENDING_TTL_MS
};

//# debugId=C42D5501B356530864756E2164756E21
