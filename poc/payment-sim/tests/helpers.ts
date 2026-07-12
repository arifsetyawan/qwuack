// helpers.ts - infra readiness, polling, and per-test seeding
import type { Sequelize } from "sequelize";
import type { Redis } from "ioredis";
import type { Ledger } from "qwuack";
import { Account } from "../src/models";
import { centsToAmount } from "../src/money";
import { config } from "../src/config";
import type { PaymentEntryPayload } from "../src/payment-service";

export async function waitFor(
  condition: () => Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

export async function authenticateWithRetry(sequelize: Sequelize, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await sequelize.authenticate();
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await Bun.sleep(1000);
    }
  }
}

export interface SeedAccount {
  id: string;
  name: string;
  balanceCents: number;
}

export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  { id: "alice", name: "Alice (payer)", balanceCents: 100_000 },
  { id: "bob", name: "Bob (payer, low balance)", balanceCents: 10_300 },
  { id: "merchant", name: "Merchant", balanceCents: 0 },
  { id: config.feeAccountId, name: "Fee collector", balanceCents: 0 },
];

// Reset both ledgers to the same opening balances: MySQL rows (balance +
// opening_balance for reconciliation) and, for funded accounts, a confirmed
// "deposit" entry on the Redis soft ledger.
export async function resetAndSeed(
  sequelize: Sequelize,
  redis: Redis,
  ledger: Ledger<PaymentEntryPayload>,
  accounts: readonly SeedAccount[] = SEED_ACCOUNTS
): Promise<void> {
  await sequelize.sync({ force: true });
  await Account.bulkCreate(
    accounts.map((account) => ({
      id: account.id,
      name: account.name,
      balance: centsToAmount(account.balanceCents),
      openingBalance: centsToAmount(account.balanceCents),
    }))
  );

  await redis.flushdb();
  for (const account of accounts) {
    if (account.balanceCents === 0) continue;
    await ledger.addEntry(account.id, config.currency, {
      id: `seed:${account.id}`,
      context: "deposit",
      currency: config.currency,
      amount: centsToAmount(account.balanceCents),
    });
  }
}
