// ledger.ts
import { createClient } from "redis";
import BigNumber from "bignumber.js";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

interface LedgerEntry {
  id: string;
  context: string;
  currency: string;
  amount: string;
}

function getLedgerKey(accountId: string, currency: string): string {
  return `ledger:${accountId}:${currency}`;
}

async function addEntry(accountId: string, currency: string, entry: LedgerEntry): Promise<void> {
  const key = getLedgerKey(accountId, currency);
  await redis.hSet(key, entry.id, JSON.stringify(entry));
}

async function removeEntry(accountId: string, currency: string, entryId: string): Promise<boolean> {
  const key = getLedgerKey(accountId, currency);
  const removed = await redis.hDel(key, entryId);
  return removed > 0;
}

async function getEntry(accountId: string, currency: string, entryId: string): Promise<LedgerEntry | null> {
  const key = getLedgerKey(accountId, currency);
  const raw = await redis.hGet(key, entryId);
  return raw ? JSON.parse(raw) : null;
}

async function getAllEntries(accountId: string, currency: string): Promise<LedgerEntry[]> {
  const key = getLedgerKey(accountId, currency);
  const entries = await redis.hVals(key);
  return entries.map((e) => JSON.parse(e));
}

async function getSum(accountId: string, currency: string): Promise<string> {
  const entries = await getAllEntries(accountId, currency);
  return entries
    .reduce((sum, e) => sum.plus(e.amount), new BigNumber(0))
    .toString();
}

async function getBalance(accountId: string, currency: string) {
  const entries = await getAllEntries(accountId, currency);

  const total = entries
    .reduce((sum, e) => sum.plus(e.amount), new BigNumber(0))
    .toString();

  const byContext = entries.reduce(
    (acc, e) => {
      const current = new BigNumber(acc[e.context] || "0");
      acc[e.context] = current.plus(e.amount).toString();
      return acc;
    },
    {} as Record<string, string>
  );

  return { total, byContext, entryCount: entries.length };
}

async function clearLedger(accountId: string, currency: string): Promise<void> {
  const key = getLedgerKey(accountId, currency);
  await redis.del(key);
}

// Export functions
export {
  addEntry,
  removeEntry,
  getEntry,
  getAllEntries,
  getSum,
  getBalance,
  clearLedger,
  redis,
};
export type { LedgerEntry };