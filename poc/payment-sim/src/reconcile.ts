// reconcile.ts - post-run integrity checks: recompute every account position
// from the payment journal (payments + payment_items) and diff it against the
// MySQL balance column AND the Redis soft ledger.
import { QueryTypes, type Sequelize } from "sequelize";
import type { Ledger } from "qwuack";
import { config } from "./config";
import { amountToCents, centsToAmount } from "./money";
import { Payment, PaymentItem, ProcessedEvent } from "./models";
import type { PaymentEntryPayload } from "./payment-service";

export interface CheckResult {
  name: string;
  ok: boolean;
  details: string;
}

export interface AccountPosition {
  accountId: string;
  openingCents: number;
  settledDebitCents: number; // Σ grand_total of settled payments as payer
  settledCreditCents: number; // Σ item amounts of settled payments as beneficiary
  derivedCents: number; // opening - debits + credits (from the journal)
  mysqlCents: number; // accounts.balance
  redisCents: number; // soft ledger getSum, rounded to 2dp
  journalDiffCents: number; // mysql - derived  → 0 when balances tally with payments
  softDiffCents: number; // redis - mysql      → 0 when both ledgers agree
}

export interface ReconciliationStats {
  accounts: number;
  paymentsSettled: number;
  paymentsAwaiting: number;
  paymentItems: number;
  processedEvents: number;
  pendingSoftEntries: number;
}

export interface ReconciliationReport {
  ok: boolean;
  checks: CheckResult[];
  positions: AccountPosition[];
  stats: ReconciliationStats;
}

interface PositionRow {
  id: string;
  opening: string;
  balance: string;
  debits: string;
  credits: string;
}

const POSITIONS_SQL = `
SELECT a.id,
       CAST(a.opening_balance AS CHAR) AS opening,
       CAST(a.balance AS CHAR)         AS balance,
       CAST(COALESCE(d.total, 0) AS CHAR) AS debits,
       CAST(COALESCE(c.total, 0) AS CHAR) AS credits
FROM accounts a
LEFT JOIN (
  SELECT payer_id, SUM(grand_total) AS total
  FROM payments WHERE status = 'settled' GROUP BY payer_id
) d ON d.payer_id = a.id
LEFT JOIN (
  SELECT i.beneficiary_id, SUM(i.amount) AS total
  FROM payment_items i JOIN payments p ON p.id = i.payment_id
  WHERE p.status = 'settled'
  GROUP BY i.beneficiary_id
) c ON c.beneficiary_id = a.id
ORDER BY a.id`;

const ITEMIZATION_VIOLATIONS_SQL = `
SELECT p.reference
FROM payments p
LEFT JOIN payment_items i ON i.payment_id = p.id
GROUP BY p.id, p.reference, p.grand_total, p.principal, p.fee_total
HAVING COUNT(i.id) <> 4
    OR COALESCE(SUM(i.amount), 0) <> p.grand_total
    OR COALESCE(SUM(CASE WHEN i.kind = 'principal' THEN i.amount ELSE 0 END), 0) <> p.principal
    OR COALESCE(SUM(CASE WHEN i.kind <> 'principal' THEN i.amount ELSE 0 END), 0) <> p.fee_total
LIMIT 50`;

const SETTLED_WITHOUT_EVENT_SQL = `
SELECT COUNT(*) AS n FROM payments p
WHERE p.status = 'settled'
  AND NOT EXISTS (
    SELECT 1 FROM processed_events e WHERE e.event_id = CONCAT('settlement:', p.reference)
  )`;

const EVENT_WITHOUT_SETTLED_SQL = `
SELECT COUNT(*) AS n FROM processed_events e
WHERE NOT EXISTS (
  SELECT 1 FROM payments p
  WHERE CONCAT('settlement:', p.reference) = e.event_id AND p.status = 'settled'
)`;

export async function reconcile(
  sequelize: Sequelize,
  ledger: Ledger<PaymentEntryPayload>
): Promise<ReconciliationReport> {
  const rows = await sequelize.query<PositionRow>(POSITIONS_SQL, { type: QueryTypes.SELECT });

  const positions: AccountPosition[] = [];
  let pendingSoftEntries = 0;
  for (const row of rows) {
    const openingCents = amountToCents(row.opening);
    const settledDebitCents = amountToCents(row.debits);
    const settledCreditCents = amountToCents(row.credits);
    const derivedCents = openingCents - settledDebitCents + settledCreditCents;
    const mysqlCents = amountToCents(row.balance);
    const redisCents = amountToCents(Number(await ledger.getSum(row.id, config.currency)).toFixed(2));

    positions.push({
      accountId: row.id,
      openingCents,
      settledDebitCents,
      settledCreditCents,
      derivedCents,
      mysqlCents,
      redisCents,
      journalDiffCents: mysqlCents - derivedCents,
      softDiffCents: redisCents - mysqlCents,
    });

    pendingSoftEntries += await countPendingEntries(ledger, row.id);
  }

  const [itemViolations, settledNoEvent, eventNoSettled] = await Promise.all([
    sequelize.query<{ reference: string }>(ITEMIZATION_VIOLATIONS_SQL, { type: QueryTypes.SELECT }),
    sequelize.query<{ n: number }>(SETTLED_WITHOUT_EVENT_SQL, { type: QueryTypes.SELECT }),
    sequelize.query<{ n: number }>(EVENT_WITHOUT_SETTLED_SQL, { type: QueryTypes.SELECT }),
  ]);

  const stats: ReconciliationStats = {
    accounts: positions.length,
    paymentsSettled: await Payment.count({ where: { status: "settled" } }),
    paymentsAwaiting: await Payment.count({ where: { status: "awaiting_settlement" } }),
    paymentItems: await PaymentItem.count(),
    processedEvents: await ProcessedEvent.count(),
    pendingSoftEntries,
  };

  const journalMismatches = positions.filter((p) => p.journalDiffCents !== 0);
  const softMismatches = positions.filter((p) => p.softDiffCents !== 0);
  const negative = positions.filter((p) => p.mysqlCents < 0 || p.redisCents < 0);
  const openingTotal = positions.reduce((s, p) => s + p.openingCents, 0);
  const finalTotal = positions.reduce((s, p) => s + p.mysqlCents, 0);

  const describeAccounts = (list: AccountPosition[], diff: (p: AccountPosition) => number) =>
    list.slice(0, 5).map((p) => `${p.accountId}: ${diff(p)}¢`).join(", ");

  const checks: CheckResult[] = [
    {
      name: "itemization-integrity",
      ok: itemViolations.length === 0,
      details:
        itemViolations.length === 0
          ? "every payment has exactly 4 items and grand_total = Σ items, fee_total = Σ fee items"
          : `${itemViolations.length}+ payments violate itemization (e.g. ${itemViolations.slice(0, 3).map((v) => v.reference).join(", ")})`,
    },
    {
      name: "no-awaiting-payments",
      ok: stats.paymentsAwaiting === 0,
      details:
        stats.paymentsAwaiting === 0
          ? "all persisted payments reached settled"
          : `${stats.paymentsAwaiting} payments stuck in awaiting_settlement`,
    },
    {
      name: "settled-events-parity",
      ok: (settledNoEvent[0]?.n ?? -1) === 0 && (eventNoSettled[0]?.n ?? -1) === 0,
      details: `settled without processed_event: ${settledNoEvent[0]?.n}, processed_event without settled payment: ${eventNoSettled[0]?.n}`,
    },
    {
      name: "journal-matches-balances",
      ok: journalMismatches.length === 0,
      details:
        journalMismatches.length === 0
          ? "accounts.balance == opening - settled debits + settled credits for every account"
          : `${journalMismatches.length} accounts diverge from the payment journal (${describeAccounts(journalMismatches, (p) => p.journalDiffCents)})`,
    },
    {
      name: "soft-ledger-matches-final",
      ok: softMismatches.length === 0,
      details:
        softMismatches.length === 0
          ? "Redis soft ledger sum (2dp) == accounts.balance for every account"
          : `${softMismatches.length} accounts diverge between Redis and MySQL (${describeAccounts(softMismatches, (p) => p.softDiffCents)})`,
    },
    {
      name: "conservation",
      ok: finalTotal === openingTotal,
      details: `Σ opening = ${centsToAmount(openingTotal)}, Σ final = ${centsToAmount(finalTotal)} (diff ${finalTotal - openingTotal}¢)`,
    },
    {
      name: "no-negative-balances",
      ok: negative.length === 0,
      details:
        negative.length === 0
          ? "no account is overdrawn in either store"
          : `overdrawn: ${negative.map((p) => p.accountId).join(", ")}`,
    },
    {
      name: "no-pending-soft-entries",
      ok: pendingSoftEntries === 0,
      details:
        pendingSoftEntries === 0
          ? "every soft ledger entry is confirmed or stateless (no leaked holds)"
          : `${pendingSoftEntries} pending entries leaked on the soft ledger`,
    },
  ];

  return { ok: checks.every((c) => c.ok), checks, positions, stats };
}

async function countPendingEntries(
  ledger: Ledger<PaymentEntryPayload>,
  accountId: string
): Promise<number> {
  let pending = 0;
  let cursor = "0";
  do {
    const page = await ledger.getEntriesPaginated(accountId, config.currency, cursor, 1000);
    pending += page.entries.filter((e) => e.state === "pending").length;
    cursor = page.nextCursor;
  } while (cursor !== "0");
  return pending;
}

export function renderReportMarkdown(
  report: ReconciliationReport,
  meta: Record<string, string | number>
): string {
  const lines: string[] = [];
  lines.push("# payment-sim load test — reconciliation report", "");
  lines.push("## Run parameters", "");
  for (const [key, value] of Object.entries(meta)) lines.push(`- **${key}**: ${value}`);
  lines.push("", "## Reconciliation checks", "");
  lines.push("| check | result | details |");
  lines.push("|-------|--------|---------|");
  for (const c of report.checks) lines.push(`| ${c.name} | ${c.ok ? "✅" : "❌"} | ${c.details} |`);
  lines.push("", "## Stats", "");
  for (const [key, value] of Object.entries(report.stats)) lines.push(`- **${key}**: ${value}`);
  lines.push("", "## Balance positions (from payment journal vs stores)", "");
  lines.push("| account | opening | settled debits | settled credits | derived | mysql | redis | journal diff | soft diff |");
  lines.push("|---------|---------|----------------|-----------------|---------|-------|-------|--------------|-----------|");
  for (const p of report.positions) {
    lines.push(
      `| ${p.accountId} | ${centsToAmount(p.openingCents)} | ${centsToAmount(p.settledDebitCents)} | ` +
        `${centsToAmount(p.settledCreditCents)} | ${centsToAmount(p.derivedCents)} | ${centsToAmount(p.mysqlCents)} | ` +
        `${centsToAmount(p.redisCents)} | ${p.journalDiffCents}¢ | ${p.softDiffCents}¢ |`
    );
  }
  lines.push("", `## Verdict: ${report.ok ? "✅ CONSISTENT" : "❌ INCONSISTENT"}`, "");
  return lines.join("\n");
}
