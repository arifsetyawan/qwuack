// broker.ts - RabbitMQ topic-exchange pub/sub plumbing
import amqp from "amqplib";
import { config } from "./config";

export interface SettlementItem {
  kind: string;
  beneficiaryId: string;
  amount: string; // positive decimal — credited to the beneficiary
}

export interface SettlementEvent {
  eventId: string;
  reference: string;
  payerId: string;
  currency: string;
  grandTotal: string; // total debited from the payer
  items: SettlementItem[];
  occurredAt: string;
}

export async function connectBroker() {
  const connection = await amqp.connect(config.rabbit.url);
  const publishChannel = await connection.createConfirmChannel();
  await publishChannel.assertExchange(config.exchange, "topic", { durable: true });

  // Per-message confirm callback: waitForConfirms() waits on ALL outstanding
  // publishes on the channel, which serializes concurrent publishers under load.
  const publish = (routingKey: string, event: SettlementEvent): Promise<void> =>
    new Promise((resolve, reject) => {
      publishChannel.publish(
        config.exchange,
        routingKey,
        Buffer.from(JSON.stringify(event)),
        { persistent: true, contentType: "application/json", messageId: event.eventId },
        (err) => (err ? reject(err) : resolve())
      );
    });

  return { connection, publishChannel, publish };
}
