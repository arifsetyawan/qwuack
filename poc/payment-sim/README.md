# @poc/payment-sim

POC that exercises the **live `qwuack` npm package** (not the local source) as a Redis
soft ledger in front of a MySQL final ledger, with RabbitMQ pub/sub carrying balance
settlement, and a payment + fee itemization flow that can roll back at every phase.

## Architecture

```
                       ┌──────────────────────── rejected/failed ────────────────────────┐
                       │                     (cancel pending entries)                    │
                       ▼                                                                 │
┌──────────┐   ① reserve itemized     ┌──────────┐   ② payment + items    ┌───────────┐  │
│ payment  │──── pending debits ─────▶│  Redis   │──── in ONE MySQL ─────▶│   MySQL   │──┘ on throw:
│ request  │   (qwuack soft ledger)   │  qwuack  │      transaction       │  payments │    txn ROLLBACK
└──────────┘                          └──────────┘                        └───────────┘
                                           │ ③ confirm entries                 ▲
                                           ▼                                   │
                                     ┌───────────┐  payment.settlement.*  ┌──────────────┐
                                     │ RabbitMQ  │───────────────────────▶│ balance      │
                                     │ topic exch│      (pub/sub)         │ consumer     │
                                     └───────────┘                        │ accounts.balance
                                                                          └──────────────┘
```

1. **Reserve (soft ledger, Redis via qwuack)** — each payment is itemized into
   principal + processing fee (2.9% + $0.30) + platform fee ($1.00) + VAT (11% on fees).
   Every item becomes a held pending debit via `addPendingEntryIfSufficient(…, floor 0)`,
   so the payer's available balance can never go below zero. If a later item fails the
   floor check, the earlier items' reservations are cancelled (`cancelEntry`).
2. **Persist (final ledger, MySQL via Sequelize)** — `payments` + `payment_items` rows
   are written in a single transaction. Any throw (simulated failure, unique-constraint
   violation, …) rolls back MySQL *and* releases the soft ledger reservation.
3. **Confirm + publish** — after commit, the pending entries are confirmed
   (`confirmEntry` moves hold → total) and a settlement event is published to the
   `payments.events` topic exchange.
4. **Settle (consumer)** — the `balance-updater` queue subscriber applies the balance
   deltas to `accounts.balance` in its own MySQL transaction, idempotently
   (`processed_events` INSERT-claim guards redelivery), and marks the payment `settled`.
   It then mirrors the credits onto the beneficiaries' **soft ledgers** as confirmed
   `receipt` entries (deduped by entry id), so Redis tracks every account — payers and
   payees — and money can circulate: a merchant's receipts are spendable in later
   payments, and `soft balance == final balance` holds for the whole economy.

## Run it

```bash
cd poc/payment-sim
bun install
bun run test        # functional suite: compose up --wait → bun test → compose down -v
bun run test:keep   # same, but leaves the containers running for inspection

bun run load        # load test: 100 concurrent workers for 10 minutes + reconciliation
bun run load:keep   # same, keeps containers up afterwards
```

Load test knobs (env vars): `LOAD_DURATION_MS` (default 600000), `LOAD_CONCURRENCY`
(default 100), `LOAD_TARGET_RPS` (default 150), `LOAD_DB_FAILURE_RATE` (default 0.02).
Each run writes a `result.load.<stamp>.md` reconciliation report next to this README.

Infra (see `docker-compose.yml`, POC-only credentials, off-default host ports):

| Service  | Image                          | Host port      |
|----------|--------------------------------|----------------|
| MySQL    | mysql:8.4 (tmpfs, ephemeral)   | 33061          |
| Redis    | redis:7-alpine                 | 63791          |
| RabbitMQ | rabbitmq:3.13-management       | 56721 / 15673  |

Tests are gated on `POC_PAYMENT_SIM=1` (set by the scripts), so a repo-root `bun test`
skips them when the infra isn't up.

## Scenarios covered

| Test | What it proves |
|------|----------------|
| Itemized payment settles | 4-item breakdown lands in both ledgers; consumer drives MySQL balances; soft total == final balance |
| MySQL failure mid-transaction | Rows written before the failure are rolled back; soft ledger reservation cancelled; nothing published |
| Insufficient balance on a fee item | Principal reserved, fee fails the floor → earlier reservations cancelled, MySQL untouched |
| 10 concurrent payments vs $1000 | Lua-atomic holds prevent overdraft; deterministic 6 accepted / 4 rejected split; money conserved across accounts; both ledgers agree; full reconciliation passes |
| Load test: 100 workers × 10 min | ~150 rps sustained over a 25-account circular economy with 2% injected MySQL rollbacks, then a full drain and journal-vs-balances reconciliation |

## Post-run reconciliation (`src/reconcile.ts`)

After a load run (and at the end of the functional concurrency test), every account
position is **recomputed from the payment journal** — `opening_balance` − Σ settled
`grand_total` as payer + Σ settled `payment_items.amount` as beneficiary — and diffed
against both stores. Checks:

| Check | Meaning |
|-------|---------|
| `itemization-integrity` | every payment has exactly 4 items; `grand_total = Σ items`, `fee_total = Σ fee items`, `principal = principal item` |
| `no-awaiting-payments` | nothing stuck in `awaiting_settlement` after the drain |
| `settled-events-parity` | settled payments ↔ `processed_events` match 1:1 in both directions |
| `journal-matches-balances` | `accounts.balance` equals the journal-derived position for every account (the payments-vs-positions diff) |
| `soft-ledger-matches-final` | Redis `getSum` (2dp) equals `accounts.balance` for every account |
| `conservation` | Σ final balances == Σ opening balances, to the cent |
| `no-negative-balances` | no account overdrawn in either store |
| `no-pending-soft-entries` | no leaked holds: every Redis entry is confirmed or stateless |

### A finding worth knowing: reservation livelock under a thundering herd

An earlier version of the concurrency test fired 10 × $100.00 payments at the $1000.00
balance. All ten principals fit *exactly* (10 × $100 = $1000), every payment then failed
on its first fee item, and all ten rolled back — **0 accepted**, even though the balance
could have funded 9. Per-item reservations with no retry can starve everyone when the
herd exhausts the balance with first items. The committed test uses $150.00 principals,
where the arithmetic guarantees exactly 6 acceptances regardless of interleaving. A real
system would want batched reservation (single entry for the grand total, itemization in
the payload) or retry-with-backoff to avoid this failure mode.

## Design decisions

- **Live package**: `qwuack@^0.2.0` resolves from the npm registry — this package has its
  own lockfile and is not workspace-linked to the repo source.
- **Money as integer cents** in JS; decimal strings only at the qwuack/SQL boundary.
  Redis `INCRBYFLOAT` can leave float dust, so soft balances are asserted at 2dp.
- **Per-item soft entries** (not one lump sum) so the itemization shows up in
  `getBalance().byContext` and partial-failure rollback is actually exercised.
- **Idempotent consumer**: an atomic INSERT-claim on the `processed_events` PK inside
  the settlement transaction (a `SELECT … FOR UPDATE` probe on a missing row takes a
  gap lock that deadlocks against concurrent claims). Soft-ledger receipt credits run
  on every delivery and dedup by entry id, so a crash between commit and credit heals
  on redelivery.
- **Deadlock-free settlements**: balance UPDATEs are grouped per account and applied
  in sorted account order, so concurrent settlements (prefetch 16) acquire row locks
  in a consistent global order.
- **Per-message publisher confirms** instead of `waitForConfirms()`, which waits on
  all outstanding publishes and serializes 100 concurrent workers.
- **Nack policy**: unparseable messages are dropped; processing failures requeue and
  retry (a real system would cap retries and dead-letter).

## Known limitations (deliberate for a POC)

- No outbox: a crash between MySQL commit and confirm/publish would leave pending
  entries and an unsettled payment (qwuack stamps `pendingExpiresAt`, but reaping and
  recovery are out of scope here).
- The consumer retries failed settlements forever instead of dead-lettering after a
  retry cap.
- Single currency, no partial refunds, no auth on the brokers.
