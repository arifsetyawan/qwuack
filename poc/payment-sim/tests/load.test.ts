// load.test.ts - sustained load run (default: 100 concurrent workers, 10 min)
// followed by a full drain and journal-vs-balances reconciliation.
// Gated on POC_LOAD_TEST; run via `bun run load` (or `bun run load:keep`).
// Knobs: LOAD_DURATION_MS, LOAD_CONCURRENCY, LOAD_TARGET_RPS, LOAD_DB_FAILURE_RATE.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import IORedis, { type Redis } from "ioredis";
import { Ledger } from "qwuack";
import type { Sequelize } from "sequelize";
import { connectBroker } from "../src/broker";
import { startBalanceConsumer } from "../src/balance-consumer";
import { createDb, Payment } from "../src/models";
import type { PaymentEntryPayload, PaymentServiceDeps } from "../src/payment-service";
import { config } from "../src/config";
import { runLoad } from "../src/load";
import { reconcile, renderReportMarkdown } from "../src/reconcile";
import { authenticateWithRetry, resetAndSeed, waitFor, type SeedAccount } from "./helpers";

const RUN = !!process.env.POC_LOAD_TEST;

const DURATION_MS = Number(process.env.LOAD_DURATION_MS ?? 600_000); // 10 minutes
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 100);
const TARGET_RPS = Number(process.env.LOAD_TARGET_RPS ?? 150);
const DB_FAILURE_RATE = Number(process.env.LOAD_DB_FAILURE_RATE ?? 0.02);

// Circular economy: 20 payers × $50k; merchants start at 0 but receive credits
// on both ledgers (the consumer mirrors receipts into Redis), so they become
// spenders as the run progresses. Fee account only accrues.
const PAYERS: SeedAccount[] = Array.from({ length: 20 }, (_, i) => ({
  id: `payer-${String(i).padStart(2, "0")}`,
  name: `Load payer ${i}`,
  balanceCents: 5_000_000,
}));
const MERCHANTS: SeedAccount[] = Array.from({ length: 5 }, (_, i) => ({
  id: `merchant-${i}`,
  name: `Load merchant ${i}`,
  balanceCents: 0,
}));
const FEE_ACCOUNT: SeedAccount = { id: config.feeAccountId, name: "Fee collector", balanceCents: 0 };

describe.skipIf(!RUN)("payment load test with post-run reconciliation", () => {
  let redis: Redis;
  let ledger: Ledger<PaymentEntryPayload>;
  let sequelize: Sequelize;
  let broker: Awaited<ReturnType<typeof connectBroker>>;
  let consumer: Awaited<ReturnType<typeof startBalanceConsumer>>;
  let deps: PaymentServiceDeps;

  beforeAll(async () => {
    redis = new IORedis({ host: config.redis.host, port: config.redis.port });
    ledger = new Ledger(redis, { keyPrefix: "soft-ledger" });
    sequelize = createDb();
    await authenticateWithRetry(sequelize);
    broker = await connectBroker();
    await broker.publishChannel.deleteQueue(config.settlementQueue);
    consumer = await startBalanceConsumer(broker.connection, sequelize, ledger);
    deps = { ledger, sequelize, publish: broker.publish };
  });

  afterAll(async () => {
    await consumer?.stop();
    await broker?.publishChannel.close();
    await broker?.connection.close();
    await sequelize?.close();
    redis?.disconnect();
  });

  test("sustained concurrent payments keep both ledgers consistent and tallied", async () => {
    await resetAndSeed(sequelize, redis, ledger, [...PAYERS, ...MERCHANTS, FEE_ACCOUNT]);

    const traders = [...PAYERS, ...MERCHANTS].map((a) => a.id);
    console.info(
      `starting load: ${CONCURRENCY} workers, ${Math.round(DURATION_MS / 1000)}s, ` +
        `target ~${TARGET_RPS} rps, ${DB_FAILURE_RATE * 100}% injected db failures`
    );

    const stats = await runLoad(deps, {
      concurrency: CONCURRENCY,
      durationMs: DURATION_MS,
      targetRps: TARGET_RPS,
      dbFailureRate: DB_FAILURE_RATE,
      payerPool: traders,
      payeePool: traders,
      minPrincipalCents: 100, // $1.00
      maxPrincipalCents: 20_000, // $200.00
    });

    console.info(
      `load done: attempted=${stats.attempted} accepted=${stats.accepted} rejected=${stats.rejected} ` +
        `failed=${stats.failed} errors=${stats.errors} (${stats.attemptedRps} rps attempted, ${stats.acceptedRps} rps accepted)`
    );
    if (stats.errorSamples.length > 0) console.error("error samples:", stats.errorSamples);

    // Drain: settlement queue empty and every persisted payment settled.
    await waitFor(
      async () => {
        const queueState = await broker.publishChannel.checkQueue(config.settlementQueue);
        if (queueState.messageCount > 0) return false;
        return (await Payment.count({ where: { status: "awaiting_settlement" } })) === 0;
      },
      "settlement queue drained and all payments settled",
      600_000,
      1000
    );

    // Post-run integrity: recompute positions from the payment journal and
    // diff against MySQL balances and the Redis soft ledger.
    const report = await reconcile(sequelize, ledger);

    const stamp = new Date().toISOString().slice(2, 16).replace(/[-:]/g, "").replace("T", ".");
    const reportPath = `${import.meta.dir}/../result.load.${stamp}.md`;
    await Bun.write(
      reportPath,
      renderReportMarkdown(report, {
        "generated at": new Date().toISOString(),
        "duration (s)": Math.round(stats.durationMs / 1000),
        "concurrent workers": CONCURRENCY,
        "target rps": TARGET_RPS,
        "injected db failure rate": DB_FAILURE_RATE,
        attempted: stats.attempted,
        accepted: stats.accepted,
        rejected: stats.rejected,
        "failed (injected rollbacks)": stats.failed,
        errors: stats.errors,
        "attempted rps": stats.attemptedRps,
        "accepted rps": stats.acceptedRps,
        "rejections by item": JSON.stringify(stats.rejectedByItem),
      })
    );
    console.info(`reconciliation report written to ${reportPath}`);
    for (const check of report.checks) {
      console.info(`  ${check.ok ? "✅" : "❌"} ${check.name}: ${check.details}`);
    }

    // Meaningful volume actually ran
    expect(stats.accepted).toBeGreaterThan(0);
    expect(stats.failed).toBeGreaterThan(0); // injected rollbacks exercised
    expect(stats.errors).toBe(0);

    // Every reconciliation check passes — failures list name + details
    expect(report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.details}`)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
