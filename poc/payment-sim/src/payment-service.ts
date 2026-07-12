// payment-service.ts - two-phase payment flow:
//   1. reserve itemized debits on the Redis soft ledger (qwuack pending entries)
//   2. persist payment + items to MySQL in one transaction (rollback cancels the reservation)
//   3. confirm the soft ledger entries and publish a settlement event to RabbitMQ
import type { Sequelize } from "sequelize";
import type { Ledger } from "qwuack";
import { config } from "./config";
import { centsToAmount } from "./money";
import { Payment, PaymentItem } from "./models";
import type { SettlementEvent } from "./broker";

export type ItemKind = "principal" | "fee_processing" | "fee_platform" | "fee_vat";

export interface PaymentEntryPayload extends Record<string, unknown> {
  reference: string;
  kind: ItemKind;
  description: string;
}

export interface ItemSpec {
  kind: ItemKind;
  description: string;
  amountCents: number; // positive; always debited from the payer
  beneficiaryId: string;
}

export interface PaymentRequest {
  reference: string;
  payerId: string;
  payeeId: string;
  principalCents: number;
  simulateDbFailure?: boolean;
}

export type PaymentResult =
  | { status: "awaiting_settlement"; reference: string; grandTotalCents: number }
  | { status: "rejected"; reference: string; reason: string; failedItemKind: ItemKind }
  | { status: "failed"; reference: string; reason: string };

export interface PaymentServiceDeps {
  ledger: Ledger<PaymentEntryPayload>;
  sequelize: Sequelize;
  publish: (routingKey: string, event: SettlementEvent) => Promise<void>;
}

// Fee schedule: 2.9% + $0.30 processing, $1.00 platform flat, 11% VAT on the fees.
export function itemize(request: PaymentRequest): ItemSpec[] {
  const processingCents = Math.round((request.principalCents * 290) / 10_000) + 30;
  const platformCents = 100;
  const vatCents = Math.round(((processingCents + platformCents) * 1_100) / 10_000);

  return [
    {
      kind: "principal",
      description: `Payment to ${request.payeeId}`,
      amountCents: request.principalCents,
      beneficiaryId: request.payeeId,
    },
    {
      kind: "fee_processing",
      description: "Processing fee 2.9% + 0.30",
      amountCents: processingCents,
      beneficiaryId: config.feeAccountId,
    },
    {
      kind: "fee_platform",
      description: "Platform flat fee",
      amountCents: platformCents,
      beneficiaryId: config.feeAccountId,
    },
    {
      kind: "fee_vat",
      description: "VAT 11% on fees",
      amountCents: vatCents,
      beneficiaryId: config.feeAccountId,
    },
  ];
}

const entryId = (reference: string, kind: ItemKind): string => `${reference}:${kind}`;

export async function processPayment(
  deps: PaymentServiceDeps,
  request: PaymentRequest
): Promise<PaymentResult> {
  const { ledger, sequelize, publish } = deps;
  const items = itemize(request);
  const grandTotalCents = items.reduce((sum, item) => sum + item.amountCents, 0);

  // Phase 1: reserve each item on the soft ledger as a held pending debit.
  // The Lua-side floor check keeps the payer's balance (total + holds) >= 0.
  const reserved: ItemSpec[] = [];
  for (const item of items) {
    const result = await ledger.addPendingEntryIfSufficient(
      request.payerId,
      config.currency,
      {
        id: entryId(request.reference, item.kind),
        context: item.kind === "principal" ? "payment" : "fee",
        currency: config.currency,
        amount: centsToAmount(-item.amountCents),
        payload: { reference: request.reference, kind: item.kind, description: item.description },
      },
      0
    );

    if (!result.success) {
      await releaseReservation(deps, request, reserved);
      return {
        status: "rejected",
        reference: request.reference,
        reason: result.reason ?? "INSUFFICIENT_BALANCE",
        failedItemKind: item.kind,
      };
    }
    reserved.push(item);
  }

  // Phase 2: persist to MySQL. Any throw rolls back the whole transaction and
  // the catch block releases the soft ledger reservation to match.
  try {
    await sequelize.transaction(async (t) => {
      const payment = await Payment.create(
        {
          reference: request.reference,
          payerId: request.payerId,
          payeeId: request.payeeId,
          currency: config.currency,
          principal: centsToAmount(request.principalCents),
          feeTotal: centsToAmount(grandTotalCents - request.principalCents),
          grandTotal: centsToAmount(grandTotalCents),
          status: "awaiting_settlement",
        },
        { transaction: t }
      );

      await PaymentItem.bulkCreate(
        items.map((item) => ({
          paymentId: payment.id,
          kind: item.kind,
          description: item.description,
          amount: centsToAmount(item.amountCents),
          beneficiaryId: item.beneficiaryId,
        })),
        { transaction: t }
      );

      if (request.simulateDbFailure) {
        throw new Error("injected failure after payment items were written");
      }
    });
  } catch (error) {
    await releaseReservation(deps, request, reserved);
    return {
      status: "failed",
      reference: request.reference,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // Phase 3: the payment is durable — confirm the reservation and hand the
  // final balance update to the RabbitMQ consumer.
  for (const item of items) {
    await ledger.confirmEntry(request.payerId, config.currency, entryId(request.reference, item.kind));
  }

  const event: SettlementEvent = {
    eventId: `settlement:${request.reference}`,
    reference: request.reference,
    payerId: request.payerId,
    currency: config.currency,
    grandTotal: centsToAmount(grandTotalCents),
    items: items.map((item) => ({
      kind: item.kind,
      beneficiaryId: item.beneficiaryId,
      amount: centsToAmount(item.amountCents),
    })),
    occurredAt: new Date().toISOString(),
  };
  await publish(config.settlementRoutingKey, event);

  return { status: "awaiting_settlement", reference: request.reference, grandTotalCents };
}

async function releaseReservation(
  deps: PaymentServiceDeps,
  request: PaymentRequest,
  reserved: ItemSpec[]
): Promise<void> {
  for (const item of [...reserved].reverse()) {
    await deps.ledger.cancelEntry(request.payerId, config.currency, entryId(request.reference, item.kind));
  }
}
