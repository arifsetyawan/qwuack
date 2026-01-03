// ledger-optimized.ts - Optimized with running totals, transactions, limits, and pagination
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

// ============================================================================
// Configuration
// ============================================================================

const MAX_ENTRIES_PER_KEY = 1000000;

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

// ============================================================================
// Core Operations (with running totals and transactions)
// ============================================================================

async function addEntry(
  accountId: string,
  currency: string,
  entry: LedgerEntry
): Promise<void> {
  const key = getLedgerKey(accountId, currency);
  const totalKey = getTotalKey(accountId, currency);
  const ctxKey = getContextKey(accountId, currency);

  // Check for duplicate entry (deduplication)
  const exists = await redis.hExists(key, entry.id);
  if (exists) {
    throw new Error(`Duplicate entry: entry with id '${entry.id}' already exists`);
  }

  // Check entry limit
  const count = await redis.hLen(key);
  if (count >= MAX_ENTRIES_PER_KEY) {
    throw new Error(
      `Ledger limit reached: maximum ${MAX_ENTRIES_PER_KEY} entries per account/currency`
    );
  }

  // Atomic transaction: add entry + update running totals
  await redis
    .multi()
    .hSet(key, entry.id, JSON.stringify(entry))
    .incrByFloat(totalKey, parseFloat(entry.amount))
    .hIncrByFloat(ctxKey, entry.context, parseFloat(entry.amount))
    .exec();
}

async function removeEntry(
  accountId: string,
  currency: string,
  entryId: string
): Promise<boolean> {
  const key = getLedgerKey(accountId, currency);
  const totalKey = getTotalKey(accountId, currency);
  const ctxKey = getContextKey(accountId, currency);

  // Get entry first to know amount and context
  const raw = await redis.hGet(key, entryId);
  if (!raw) {
    return false;
  }

  const entry: LedgerEntry = JSON.parse(raw);
  const amount = parseFloat(entry.amount);

  // Atomic transaction: remove entry + update running totals
  await redis
    .multi()
    .hDel(key, entryId)
    .incrByFloat(totalKey, -amount)
    .hIncrByFloat(ctxKey, entry.context, -amount)
    .exec();

  return true;
}

// ============================================================================
// Read Operations (O(1) using running totals)
// ============================================================================

async function getEntry(
  accountId: string,
  currency: string,
  entryId: string
): Promise<LedgerEntry | null> {
  const key = getLedgerKey(accountId, currency);
  const raw = await redis.hGet(key, entryId);
  return raw ? JSON.parse(raw) : null;
}

async function getSum(accountId: string, currency: string): Promise<string> {
  const totalKey = getTotalKey(accountId, currency);
  const total = await redis.get(totalKey);
  return total ?? "0";
}

async function getBalance(accountId: string, currency: string) {
  const key = getLedgerKey(accountId, currency);
  const totalKey = getTotalKey(accountId, currency);
  const ctxKey = getContextKey(accountId, currency);

  // Parallel fetch - O(1) operations
  const [total, entryCount, byContext] = await Promise.all([
    redis.get(totalKey),
    redis.hLen(key),
    redis.hGetAll(ctxKey),
  ]);

  return {
    total: total ?? "0",
    byContext: byContext as Record<string, string>,
    entryCount,
  };
}

// ============================================================================
// Pagination (for when you need actual entries)
// ============================================================================

async function getEntriesPaginated(
  accountId: string,
  currency: string,
  cursor: string = "0",
  count: number = 100
): Promise<PaginatedResult> {
  const key = getLedgerKey(accountId, currency);
  const result = await redis.hScan(key, cursor, { COUNT: count });

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

// Legacy function - use getEntriesPaginated for large datasets
async function getAllEntries(
  accountId: string,
  currency: string
): Promise<LedgerEntry[]> {
  const key = getLedgerKey(accountId, currency);
  const entries = await redis.hVals(key);
  return entries.map((e) => JSON.parse(e));
}

// ============================================================================
// Cleanup
// ============================================================================

async function clearLedger(
  accountId: string,
  currency: string
): Promise<void> {
  const key = getLedgerKey(accountId, currency);
  const totalKey = getTotalKey(accountId, currency);
  const ctxKey = getContextKey(accountId, currency);

  // Delete all related keys atomically
  await redis.del([key, totalKey, ctxKey]);
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
  redis,
  MAX_ENTRIES_PER_KEY,
};
export type { LedgerEntry, PaginatedResult };
