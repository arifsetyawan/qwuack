// payment-flow.test.ts - end-to-end simulation against dockerized MySQL/Redis/RabbitMQ.
// Gated on POC_PAYMENT_SIM so a repo-root `bun test` skips it; run via `bun run test`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import IORedis, { type Redis } from "ioredis";
import { Ledger } from "qwuack";
import type { Sequelize } from "sequelize";
import { connectBroker } from "../src/broker";
import { startBalanceConsumer } from "../src/balance-consumer";
import { createDb, Account, Payment, PaymentItem, ProcessedEvent } from "../src/models";
import { processPayment, type PaymentEntryPayload, type PaymentServiceDeps } from "../src/payment-service";
import { config } from "../src/config";
import { centsToAmount } from "../src/money";
import { reconcile } from "../src/reconcile";
import { authenticateWithRetry, resetAndSeed, waitFor } from "./helpers";

const RUN = !!process.env.POC_PAYMENT_SIM;

describe.skipIf(!RUN)("qwuack payment simulation (redis soft ledger → mysql final ledger via rabbitmq)", () => {
  let redis: Redis;
  let ledger: Ledger<PaymentEntryPayload>;
  let sequelize: Sequelize;
  let broker: Awaited<ReturnType<typeof connectBroker>>;
  let consumer: Awaited<ReturnType<typeof startBalanceConsumer>>;
  let deps: PaymentServiceDeps;

  // Redis INCRBYFLOAT can leave float dust, so soft balances are compared at 2dp.
  const softBalance = async (accountId: string): Promise<string> =>
    Number(await ledger.getSum(accountId, config.currency)).toFixed(2);

  const finalBalance = async (accountId: string): Promise<string> =>
    Number((await Account.findByPk(accountId))!.balance).toFixed(2);

  beforeAll(async () => {
    redis = new IORedis({ host: config.redis.host, port: config.redis.port });
    ledger = new Ledger(redis, { keyPrefix: "soft-ledger" });
    sequelize = createDb();
    await authenticateWithRetry(sequelize);
    broker = await connectBroker();
    await broker.publishChannel.deleteQueue(config.settlementQueue); // drop leftovers from prior runs
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

  beforeEach(async () => {
    await resetAndSeed(sequelize, redis, ledger);
  });

  test("itemized payment settles: soft ledger confirms, consumer updates final balances", async () => {
    // $100.00 principal → $3.20 processing + $1.00 platform + $0.46 VAT = $104.66 total debit
    const result = await processPayment(deps, {
      reference: "pay-001",
      payerId: "alice",
      payeeId: "merchant",
      principalCents: 10_000,
    });

    expect(result.status).toBe("awaiting_settlement");
    if (result.status !== "awaiting_settlement") throw new Error("unreachable");
    expect(result.grandTotalCents).toBe(10_466);

    // Soft ledger already debited, entries confirmed
    expect(await softBalance("alice")).toBe("895.34");
    const principal = await ledger.getEntry("alice", config.currency, "pay-001:principal");
    expect(principal?.state).toBe("confirmed");

    // Itemization breakdown visible in both ledgers
    expect(await PaymentItem.count()).toBe(4);
    const { byContext } = await ledger.getBalance("alice", config.currency);
    expect(Number(byContext["payment"]).toFixed(2)).toBe("-100.00");
    expect(Number(byContext["fee"]).toFixed(2)).toBe("-4.66");

    // Consumer picks up the RabbitMQ event and settles the final ledger
    await waitFor(
      async () => (await Payment.count({ where: { status: "settled" } })) === 1,
      "payment settled by consumer"
    );
    expect(await finalBalance("alice")).toBe("895.34");
    expect(await finalBalance("merchant")).toBe("100.00");
    expect(await finalBalance(config.feeAccountId)).toBe("4.66");
    expect(await ProcessedEvent.count()).toBe(1);

    // Soft and final ledger agree
    expect(await softBalance("alice")).toBe(await finalBalance("alice"));
  });

  test("mysql failure rolls back the transaction and releases the soft ledger reservation", async () => {
    const before = await softBalance("alice");
    const result = await processPayment(deps, {
      reference: "pay-002",
      payerId: "alice",
      payeeId: "merchant",
      principalCents: 10_000,
      simulateDbFailure: true,
    });

    expect(result.status).toBe("failed");

    // MySQL transaction rolled back — payment and item rows written before the
    // failure are gone
    expect(await Payment.count()).toBe(0);
    expect(await PaymentItem.count()).toBe(0);

    // Soft ledger reservation cancelled — balance restored, entries deleted
    expect(await softBalance("alice")).toBe(before);
    expect(await ledger.getEntry("alice", config.currency, "pay-002:principal")).toBeNull();

    // Nothing reached the settlement pipeline
    await Bun.sleep(400);
    const queueState = await broker.publishChannel.checkQueue(config.settlementQueue);
    expect(queueState.messageCount).toBe(0);
    expect(await finalBalance("merchant")).toBe("0.00");
    expect(await ProcessedEvent.count()).toBe(0);
  });

  test("insufficient balance on a fee item rejects the payment and cancels earlier reservations", async () => {
    // bob has $103.00: the $100.00 principal fits, the $3.20 processing fee does not
    const result = await processPayment(deps, {
      reference: "pay-003",
      payerId: "bob",
      payeeId: "merchant",
      principalCents: 10_000,
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.failedItemKind).toBe("fee_processing");
    expect(result.reason).toBe("INSUFFICIENT_BALANCE");

    // The already-reserved principal was rolled back on the soft ledger
    expect(await softBalance("bob")).toBe("103.00");
    expect(await ledger.getEntry("bob", config.currency, "pay-003:principal")).toBeNull();

    // MySQL was never touched
    expect(await Payment.count()).toBe(0);
    expect(await finalBalance("bob")).toBe("103.00");
  });

  test("concurrent payments conserve money across soft and final ledgers", async () => {
    // 10 concurrent $150.00 payments ($156.27 with fees) against $1000.00.
    // Exactly 6 principals can reserve (7 × $150 > $1000), and the $100 left
    // after 6 principals always covers their 6 × $6.27 of fees — so the split
    // is deterministically 6 accepted / 4 rejected regardless of interleaving.
    // (With $100 principals the herd can consume the whole balance with
    // principals and then ALL fail on fees — see README.)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        processPayment(deps, {
          reference: `pay-c-${i}`,
          payerId: "alice",
          payeeId: "merchant",
          principalCents: 15_000,
        })
      )
    );

    const accepted = results.filter((r) => r.status === "awaiting_settlement");
    const rejected = results.filter((r) => r.status === "rejected");
    console.info(`concurrency split: ${accepted.length} accepted / ${rejected.length} rejected`);
    expect(accepted.length).toBe(6);
    expect(rejected.length).toBe(4);

    await waitFor(
      async () => (await Payment.count({ where: { status: "settled" } })) === accepted.length,
      "all accepted payments settled"
    );

    // Rejected payments left no trace in MySQL
    expect(await Payment.count()).toBe(accepted.length);

    // Both ledgers agree with the arithmetic ($156.27 grand total per payment)
    const expectedAliceCents = 100_000 - 15_627 * accepted.length;
    expect(await softBalance("alice")).toBe(centsToAmount(expectedAliceCents));
    expect(await finalBalance("alice")).toBe(centsToAmount(expectedAliceCents));
    expect(await finalBalance("merchant")).toBe(centsToAmount(15_000 * accepted.length));
    expect(await finalBalance(config.feeAccountId)).toBe(centsToAmount(627 * accepted.length));

    // Conservation: alice + merchant + fees still sum to the original $1000.00
    const balances = await Promise.all(
      ["alice", "merchant", config.feeAccountId].map((id) => finalBalance(id))
    );
    const totalCents = balances.reduce((sum, b) => sum + Math.round(Number(b) * 100), 0);
    expect(totalCents).toBe(100_000);

    // Full journal-vs-balances reconciliation passes on the final state
    const report = await reconcile(sequelize, ledger);
    expect(report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.details}`)).toEqual([]);
  });
});
