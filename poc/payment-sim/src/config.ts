// config.ts - connection settings matching docker-compose.yml
export const config = {
  mysql: {
    host: process.env.POC_MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.POC_MYSQL_PORT ?? 33061),
    username: "poc",
    password: "pocpass",
    database: "ledger_final",
  },
  redis: {
    host: process.env.POC_REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.POC_REDIS_PORT ?? 63791),
  },
  rabbit: {
    url: process.env.POC_RABBIT_URL ?? "amqp://guest:guest@127.0.0.1:56721",
  },
  exchange: "payments.events",
  settlementQueue: "balance-updater",
  settlementRoutingKey: "payment.settlement.requested",
  feeAccountId: "fees",
  currency: "USD",
} as const;
