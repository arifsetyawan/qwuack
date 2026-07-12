// load.ts - sustained concurrent load generator for the payment flow.
// N workers each keep one payment in flight, paced so the fleet approximates
// targetRps overall (jittered inter-arrival), for durationMs.
import { processPayment, type PaymentServiceDeps } from "./payment-service";

export interface LoadOptions {
  concurrency: number;
  durationMs: number;
  targetRps: number; // total across all workers
  dbFailureRate: number; // 0..1 fraction of requests with simulateDbFailure
  payerPool: string[];
  payeePool: string[];
  minPrincipalCents: number;
  maxPrincipalCents: number;
  progressIntervalMs?: number;
}

export interface LoadStats {
  attempted: number;
  accepted: number;
  rejected: number;
  failed: number; // MySQL rollbacks (injected failures)
  errors: number; // unexpected throws from processPayment
  rejectedByItem: Record<string, number>;
  errorSamples: string[];
  durationMs: number;
  attemptedRps: number;
  acceptedRps: number;
}

export async function runLoad(deps: PaymentServiceDeps, opts: LoadOptions): Promise<LoadStats> {
  const startedAt = Date.now();
  const endAt = startedAt + opts.durationMs;
  const interArrivalMs = (opts.concurrency * 1000) / opts.targetRps;

  let attempted = 0;
  let accepted = 0;
  let rejected = 0;
  let failed = 0;
  let errors = 0;
  const rejectedByItem: Record<string, number> = {};
  const errorSamples: string[] = [];

  const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
  const pick = <T>(pool: T[]): T => pool[Math.floor(Math.random() * pool.length)]!;

  const worker = async (workerId: number): Promise<void> => {
    let seq = 0;
    while (Date.now() < endAt) {
      const iterationStart = Date.now();
      const payerId = pick(opts.payerPool);
      let payeeId = pick(opts.payeePool);
      while (payeeId === payerId) payeeId = pick(opts.payeePool);

      attempted++;
      try {
        const result = await processPayment(deps, {
          reference: `load-${workerId}-${seq++}`,
          payerId,
          payeeId,
          principalCents: randInt(opts.minPrincipalCents, opts.maxPrincipalCents),
          simulateDbFailure: Math.random() < opts.dbFailureRate,
        });
        if (result.status === "awaiting_settlement") accepted++;
        else if (result.status === "rejected") {
          rejected++;
          rejectedByItem[result.failedItemKind] = (rejectedByItem[result.failedItemKind] ?? 0) + 1;
        } else failed++;
      } catch (error) {
        errors++;
        if (errorSamples.length < 5) {
          errorSamples.push(error instanceof Error ? error.message : String(error));
        }
      }

      const elapsed = Date.now() - iterationStart;
      const jitter = 0.5 + Math.random(); // 0.5x..1.5x
      const sleepMs = interArrivalMs * jitter - elapsed;
      if (sleepMs > 0) await Bun.sleep(Math.min(sleepMs, Math.max(0, endAt - Date.now())));
    }
  };

  let running = true;
  const progressLoop = (async () => {
    const interval = opts.progressIntervalMs ?? 10_000;
    let lastLog = Date.now();
    while (running) {
      await Bun.sleep(250);
      if (!running) break;
      if (Date.now() - lastLog < interval) continue;
      lastLog = Date.now();
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      console.info(
        `[load ${elapsedS}s] attempted=${attempted} accepted=${accepted} rejected=${rejected} ` +
          `failed=${failed} errors=${errors} (~${Math.round(attempted / Math.max(1, elapsedS))} rps)`
      );
    }
  })();

  await Promise.all(Array.from({ length: opts.concurrency }, (_, w) => worker(w)));
  running = false;
  await progressLoop;

  const durationMs = Date.now() - startedAt;
  return {
    attempted,
    accepted,
    rejected,
    failed,
    errors,
    rejectedByItem,
    errorSamples,
    durationMs,
    attemptedRps: Math.round((attempted * 1000) / durationMs),
    acceptedRps: Math.round((accepted * 1000) / durationMs),
  };
}
