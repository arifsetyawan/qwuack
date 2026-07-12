// ledger-10k.ts - One atomic Lua round-trip per write, over a small connection pool
import { createClient } from "redis";

// ============================================================================
// Configuration
// ============================================================================

const MAX_ENTRIES_PER_KEY = 1000000;
const POOL_SIZE = Math.max(1, Number(process.env.LEDGER_POOL_SIZE ?? 4));

// ============================================================================
// Types
// ============================================================================

interface LedgerEntry {
  id: string;
  context: string;
  currency: string;
  amount: string;
}

interface PaginatedResult {
  entries: LedgerEntry[];
  nextCursor: string;
  hasMore: boolean;
}

// ============================================================================
// Connection Pool
// ============================================================================

async function makeClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

const pool = await Promise.all(Array.from({ length: POOL_SIZE }, makeClient));
const redis = pool[0]!;

let poolIndex = 0;
function nextClient() {
  poolIndex = (poolIndex + 1) % pool.length;
  return pool[poolIndex]!;
}

async function quitAll(): Promise<void> {
  await Promise.all(pool.map((client) => client.quit()));
}

// ============================================================================
// Key Helpers
// ============================================================================

function getLedgerKey(accountId: string, currency: string): string {
  return `ledger:${accountId}:${currency}`;
}

function getTotalKey(accountId: string, currency: string): string {
  return `ledger:${accountId}:${currency}:total`;
}

function getContextKey(accountId: string, currency: string): string {
  return `ledger:${accountId}:${currency}:ctx`;
}

function ledgerKeys(accountId: string, currency: string): string[] {
  return [
    getLedgerKey(accountId, currency),
    getTotalKey(accountId, currency),
    getContextKey(accountId, currency),
  ];
}

// ============================================================================
// Lua Scripts (dedup + limit + write + totals in one atomic round-trip)
// ============================================================================

const ADD_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return 'DUP'
end
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[5]) then
  return 'LIMIT'
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('INCRBYFLOAT', KEYS[2], ARGV[3])
redis.call('HINCRBYFLOAT', KEYS[3], ARGV[4], ARGV[3])
return 'OK'
`;

const REMOVE_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return 0
end
local entry = cjson.decode(raw)
local neg = tostring(0 - tonumber(entry.amount))
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('INCRBYFLOAT', KEYS[2], neg)
redis.call('HINCRBYFLOAT', KEYS[3], entry.context, neg)
return 1
`;

const [ADD_SHA, REMOVE_SHA] = await Promise.all([
  redis.scriptLoad(ADD_SCRIPT),
  redis.scriptLoad(REMOVE_SCRIPT),
]);

async function runScript(
  script: string,
  sha: string,
  keys: string[],
  args: string[]
): Promise<unknown> {
  const client = nextClient();
  try {
    return await client.evalSha(sha, { keys, arguments: args });
  } catch (error) {
    // Script cache can be flushed (e.g. Redis restart); re-send full script.
    if (error instanceof Error && error.message.includes("NOSCRIPT")) {
      return await client.eval(script, { keys, arguments: args });
    }
    throw error;
  }
}

// ============================================================================
// Core Operations
// ============================================================================

async function addEntry(
  accountId: string,
  currency: string,
  entry: LedgerEntry
): Promise<void> {
  const maxEntries = Number(process.env.LEDGER_MAX_ENTRIES ?? MAX_ENTRIES_PER_KEY);
  const result = await runScript(ADD_SCRIPT, ADD_SHA, ledgerKeys(accountId, currency), [
    entry.id,
    JSON.stringify(entry),
    entry.amount,
    entry.context,
    String(maxEntries),
  ]);
  if (result === "DUP") {
    throw new Error(`Duplicate entry: entry with id '${entry.id}' already exists`);
  }
  if (result === "LIMIT") {
    throw new Error(
      `Ledger limit reached: maximum ${maxEntries} entries per account/currency`
    );
  }
}

async function removeEntry(
  accountId: string,
  currency: string,
  entryId: string
): Promise<boolean> {
  const result = await runScript(
    REMOVE_SCRIPT,
    REMOVE_SHA,
    ledgerKeys(accountId, currency),
    [entryId]
  );
  return result === 1;
}

// ============================================================================
// Read Operations (O(1) using running totals)
// ============================================================================

async function getEntry(
  accountId: string,
  currency: string,
  entryId: string
): Promise<LedgerEntry | null> {
  const raw = await nextClient().hGet(getLedgerKey(accountId, currency), entryId);
  return raw ? JSON.parse(raw) : null;
}

async function getSum(accountId: string, currency: string): Promise<string> {
  const total = await nextClient().get(getTotalKey(accountId, currency));
  return total ?? "0";
}

async function getBalance(accountId: string, currency: string) {
  const client = nextClient();
  const [total, entryCount, byContext] = await Promise.all([
    client.get(getTotalKey(accountId, currency)),
    client.hLen(getLedgerKey(accountId, currency)),
    client.hGetAll(getContextKey(accountId, currency)),
  ]);

  return {
    total: total ?? "0",
    byContext: byContext as Record<string, string>,
    entryCount,
  };
}

// ============================================================================
// Pagination
// ============================================================================

async function getEntriesPaginated(
  accountId: string,
  currency: string,
  cursor: string = "0",
  count: number = 100
): Promise<PaginatedResult> {
  const result = await nextClient().hScan(getLedgerKey(accountId, currency), cursor, {
    COUNT: count,
  });

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

async function getAllEntries(
  accountId: string,
  currency: string
): Promise<LedgerEntry[]> {
  const entries = await nextClient().hVals(getLedgerKey(accountId, currency));
  return entries.map((e) => JSON.parse(e));
}

// ============================================================================
// Cleanup
// ============================================================================

async function clearLedger(accountId: string, currency: string): Promise<void> {
  await nextClient().del(ledgerKeys(accountId, currency));
}

// ============================================================================
// Exports
// ============================================================================

export {
  addEntry,
  removeEntry,
  getEntry,
  getAllEntries,
  getEntriesPaginated,
  getSum,
  getBalance,
  clearLedger,
  quitAll,
  redis,
  MAX_ENTRIES_PER_KEY,
  POOL_SIZE,
};
export type { LedgerEntry, PaginatedResult };

// ============================================================================
// Demo (runs only when executed directly: `bun run poc/ledger-10k.ts`)
// ============================================================================

if (import.meta.main) {
  const accountId = "demo_10k";
  const currency = "usd";

  console.log(`Connected to Redis at ${process.env.REDIS_URL} (pool size ${POOL_SIZE})`);
  console.log("Running ledger-10k demo...\n");

  await clearLedger(accountId, currency);

  await addEntry(accountId, currency, { id: "demo-1", context: "funding", currency, amount: "1000" });
  await addEntry(accountId, currency, { id: "demo-2", context: "payout", currency, amount: "-250" });
  console.log("Sum:", await getSum(accountId, currency), "(expect 750)");
  console.log("Balance:", await getBalance(accountId, currency));
  const page = await getEntriesPaginated(accountId, currency);
  console.log(`Paginated fetch: ${page.entries.length} entries (expect 2), hasMore: ${page.hasMore}`);

  await clearLedger(accountId, currency);
  const sameId = Array.from({ length: 50 }, () =>
    addEntry(accountId, currency, { id: "same", context: "race", currency, amount: "10" })
  );
  const settled = await Promise.allSettled(sameId);
  const wins = settled.filter((s) => s.status === "fulfilled").length;
  console.log(`\nSame-id storm: ${wins}/50 succeeded (expect 1), sum=${await getSum(accountId, currency)} (expect 10)`);

  await clearLedger(accountId, currency);
  await Promise.all(
    Array.from({ length: 200 }, async (_, i) => {
      const id = `storm-${i}`;
      await addEntry(accountId, currency, { id, context: "storm", currency, amount: "7" });
      await removeEntry(accountId, currency, id);
    })
  );
  const bal = await getBalance(accountId, currency);
  console.log(`Add/remove storm: sum=${await getSum(accountId, currency)} (expect 0), entries=${bal.entryCount} (expect 0)`);

  await clearLedger(accountId, currency);
  console.log("\nDemo complete, ledger cleared.");
  await quitAll();
}
