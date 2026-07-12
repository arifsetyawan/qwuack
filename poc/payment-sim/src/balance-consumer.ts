// balance-consumer.ts - RabbitMQ subscriber that applies settled payments to
// the MySQL final ledger (accounts.balance) exactly once per event, and mirrors
// the credits onto the beneficiaries' Redis soft ledgers so both stores track
// every account (payers AND payees), keeping the economy circular.
import { UniqueConstraintError, type Sequelize } from "sequelize";
import type { Ledger } from "qwuack";
import { config } from "./config";
import { amountToCents, centsToAmount } from "./money";
import { Account, Payment, ProcessedEvent } from "./models";
import type { connectBroker, SettlementEvent } from "./broker";
import type { PaymentEntryPayload } from "./payment-service";

type BrokerConnection = Awaited<ReturnType<typeof connectBroker>>["connection"];

export async function startBalanceConsumer(
  connection: BrokerConnection,
  sequelize: Sequelize,
  ledger: Ledger<PaymentEntryPayload>
) {
  const channel = await connection.createChannel();
  await channel.assertExchange(config.exchange, "topic", { durable: true });
  const { queue } = await channel.assertQueue(config.settlementQueue, { durable: true });
  await channel.bindQueue(queue, config.exchange, "payment.settlement.*");
  await channel.prefetch(16);

  const { consumerTag } = await channel.consume(queue, async (message) => {
    if (!message) return;

    let event: SettlementEvent;
    try {
      event = JSON.parse(message.content.toString()) as SettlementEvent;
    } catch {
      channel.nack(message, false, false); // unparseable — drop, retrying can't help
      return;
    }

    try {
      await applySettlement(sequelize, ledger, event);
      channel.ack(message);
    } catch (error) {
      // Transient failure (pool timeout, deadlock, ...): requeue and retry.
      // A real system would cap retries and dead-letter instead.
      console.warn(
        `settlement retry for ${event.reference}:`,
        error instanceof Error ? error.message : error
      );
      channel.nack(message, false, true);
    }
  });

  return {
    stop: async (): Promise<void> => {
      await channel.cancel(consumerTag);
      await channel.close();
    },
  };
}

async function applySettlement(
  sequelize: Sequelize,
  ledger: Ledger<PaymentEntryPayload>,
  event: SettlementEvent
): Promise<void> {
  try {
    await sequelize.transaction(async (t) => {
      // Idempotency claim first: an atomic INSERT on the PK instead of
      // SELECT ... FOR UPDATE, whose gap lock on a missing row deadlocks
      // against concurrent claims of other events.
      await ProcessedEvent.create({ eventId: event.eventId }, { transaction: t });

      // One UPDATE per account: payer debit and per-beneficiary credits grouped.
      const deltas = new Map<string, number>();
      const bump = (accountId: string, cents: number) =>
        deltas.set(accountId, (deltas.get(accountId) ?? 0) + cents);
      bump(event.payerId, -amountToCents(event.grandTotal));
      for (const item of event.items) bump(item.beneficiaryId, amountToCents(item.amount));

      // Sorted account order = consistent lock acquisition order across
      // concurrent settlements, which prevents deadlock cycles.
      for (const [accountId, cents] of [...deltas].sort(([a], [b]) => a.localeCompare(b))) {
        await Account.increment({ balance: cents / 100 }, { where: { id: accountId }, transaction: t });
      }
      await Payment.update(
        { status: "settled", settledAt: new Date() },
        { where: { reference: event.reference }, transaction: t }
      );
    });
  } catch (error) {
    if (!(error instanceof UniqueConstraintError)) throw error;
    // redelivered message — MySQL side already applied; still mirror the
    // soft-ledger credits below in case the first delivery crashed mid-way
  }

  // Mirror credits onto the beneficiaries' soft ledgers AFTER the MySQL commit.
  // Runs on every delivery (not guarded by processed_events) so a crash between
  // commit and credit heals on redelivery; addEntry dedups by id, so replays
  // are safe.
  const credits = new Map<string, number>();
  for (const item of event.items) {
    credits.set(item.beneficiaryId, (credits.get(item.beneficiaryId) ?? 0) + amountToCents(item.amount));
  }
  for (const [accountId, cents] of credits) {
    try {
      await ledger.addEntry(accountId, config.currency, {
        id: `stl:${event.reference}`,
        context: "receipt",
        currency: config.currency,
        amount: centsToAmount(cents),
      });
    } catch (error) {
      const duplicate = error instanceof Error && error.message.includes("Duplicate entry");
      if (!duplicate) throw error;
    }
  }
}
