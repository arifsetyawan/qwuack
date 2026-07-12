<p align="center">
  <img src="qwuack-logo.jpeg" alt="qwuack logo" width="200">
</p>

<h1 align="center">qwuack</h1>

<p align="center">
  <a href="https://github.com/arifsetyawan/qwuack/actions/workflows/test.yml"><img src="https://github.com/arifsetyawan/qwuack/actions/workflows/test.yml/badge.svg" alt="Test"></a>
  <img src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/arifsetyawan/d79c81077e8a18665d0e8706044f08f9/raw/qwuack-coverage.json" alt="Coverage">
  <a href="https://www.npmjs.com/package/qwuack"><img src="https://img.shields.io/npm/v/qwuack.svg" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  A high-performance Redis-backed ledger library with O(1) balance lookups.<br>
  Supports both <code>node-redis</code> and <code>ioredis</code> clients.
</p>

## Features

- **O(1) Balance Queries** - Uses running totals instead of scanning all entries
- **Atomic Transactions** - All write operations use Redis MULTI/EXEC
- **Two-Phase Entries** - Reserve funds with pending entries, then confirm or cancel
- **Dual Client Support** - Works with both `redis` (node-redis) and `ioredis`
- **Deduplication** - Prevents duplicate entries by ID
- **Entry Limits** - Configurable maximum entries per account/currency
- **Pagination** - Efficient cursor-based pagination for large datasets
- **Context Breakdown** - Track balances by context (deposit, withdrawal, etc.)

## Installation

```bash
npm install qwuack
# or
bun add qwuack
```

You also need one of the supported Redis clients:

```bash
# Option 1: node-redis
npm install redis

# Option 2: ioredis
npm install ioredis
```

## Quick Start

### With node-redis

```typescript
import { createClient } from "redis";
import { Ledger } from "qwuack";

const redis = createClient();
await redis.connect();

const ledger = new Ledger(redis);

// Add an entry
await ledger.addEntry("user_123", "usd", {
  id: "txn_001",
  context: "deposit",
  currency: "usd",
  amount: "100.00",
});

// Get balance (O(1) operation)
const balance = await ledger.getBalance("user_123", "usd");
console.log(balance);
// { total: "100.00", byContext: { deposit: "100.00" }, entryCount: 1 }
```

### With ioredis

```typescript
import Redis from "ioredis";
import { Ledger } from "qwuack";

const redis = new Redis();
const ledger = new Ledger(redis);

// Same API as above
await ledger.addEntry("user_123", "usd", {
  id: "txn_001",
  context: "deposit",
  currency: "usd",
  amount: "100.00",
});
```

## API Reference

### `new Ledger(redis, config?)`

Creates a new Ledger instance.

| Parameter | Type | Description |
|-----------|------|-------------|
| `redis` | `RedisClient \| IORedis` | Redis client instance |
| `config.maxEntriesPerKey` | `number` | Maximum entries per account/currency (default: 1,000,000) |
| `config.keyPrefix` | `string` | Redis key prefix (default: "ledger") |

### `addEntry(accountId, currency, entry)`

Adds a new ledger entry. Throws if entry ID already exists or limit reached.

```typescript
await ledger.addEntry("user_123", "usd", {
  id: "txn_001",        // Unique entry ID
  context: "deposit",   // Category for breakdown
  currency: "usd",      // Currency code
  amount: "100.00",     // Amount as string
});
```

### `removeEntry(accountId, currency, entryId)`

Removes a **confirmed** (or legacy stateless) entry and updates running totals. Returns
`true` if removed, `false` if not found **or if the entry is still `pending`** — pending
entries must be resolved with `confirmEntry` or `cancelEntry` first (see
[Two-Phase Entries](#two-phase-entries)).

```typescript
const removed = await ledger.removeEntry("user_123", "usd", "txn_001");
```

### `getEntry(accountId, currency, entryId)`

Retrieves a single entry by ID. Returns `null` if not found.

```typescript
const entry = await ledger.getEntry("user_123", "usd", "txn_001");
```

### `getSum(accountId, currency)`

Returns the **available** sum for an account/currency pair — the confirmed running total
**plus** any outstanding reservations from `held` pending entries (`:total + :hold`). O(1)
operation.

> **Semantic change in 0.2.0:** `getSum` previously returned only the confirmed total.
> It now returns `total + hold` so that funds reserved by `addPendingEntryIfSufficient`
> are already reflected in the available balance. See [Two-Phase Entries](#two-phase-entries).

```typescript
const available = await ledger.getSum("user_123", "usd");
// "100.00"
```

### `getBalance(accountId, currency)`

Returns complete balance information including context breakdown. O(1) operation.

```typescript
const balance = await ledger.getBalance("user_123", "usd");
// {
//   total: "250.00",
//   byContext: { deposit: "300.00", withdrawal: "-50.00" },
//   entryCount: 5
// }
```

### `getEntriesPaginated(accountId, currency, cursor?, count?)`

Retrieves entries with cursor-based pagination.

```typescript
let cursor = "0";
do {
  const result = await ledger.getEntriesPaginated("user_123", "usd", cursor, 100);
  console.log(result.entries);
  cursor = result.nextCursor;
} while (result.hasMore);
```

### `clearLedger(accountId, currency)`

Removes all entries and totals for an account/currency pair, including the running total,
the per-context breakdown, and the `:hold` reservation total.

```typescript
await ledger.clearLedger("user_123", "usd");
```

## Two-Phase Entries

In addition to the single-shot `addEntry`, qwuack supports a **two-phase lifecycle** for
entries whose outcome is not yet final (e.g. an in-flight authorization or transfer). An
entry is first added as **`pending`**, then later **confirmed** (it becomes permanent) or
**cancelled** (it is rolled back).

### Entry lifecycle

```
addPendingEntry / addPendingEntryIfSufficient
                    │
              state: "pending"
                    │
        ┌───────────┴───────────┐
   confirmEntry              cancelEntry
        │                        │
  state: "confirmed"        entry removed
  (permanent, counted       (reservation released)
   in the running total)
```

Every `LedgerEntry` carries optional lifecycle fields:

| Field | Type | Meaning |
|-------|------|---------|
| `state` | `"pending" \| "confirmed"` | Current lifecycle state. Absent on legacy entries. |
| `pendingExpiresAt` | `number` (epoch ms) | When the pending reservation expires. Set on add, cleared on confirm. |
| `confirmedAt` | `number` (epoch ms) | When the entry was confirmed. |
| `held` | `boolean` | `true` when the entry reserved funds in the `:hold` total (see below). |

### The `held` reservation marker

`addPendingEntryIfSufficient` stamps the entry with `held: true` and moves its amount into
a dedicated `:hold` running total. This is what makes reserved funds visible in the
**available balance** returned by `getSum` (`:total + :hold`) *before* the entry is
confirmed. When the entry is later confirmed the amount is moved from `:hold` into `:total`;
when cancelled it is simply released from `:hold`.

The `held` flag — **not** the sign of the amount — is what decides whether `confirmEntry`
and `cancelEntry` release the hold. Plain `addPendingEntry` does **not** set `held` and does
**not** reserve funds, so its confirm/cancel leave `:hold` untouched.

### Legacy stateless entries are treated as confirmed

Entries written by earlier versions (or by `addEntry`) have no `state` field. They are
treated as **confirmed** everywhere:

- `removeEntry` will remove them (only `state === "pending"` is refused).
- `confirmEntry` on such an entry returns `{ status: "already_confirmed" }`.
- `cancelEntry` on such an entry returns `{ status: "not_pending" }`.

This makes the two-phase feature fully backward compatible — no migration is required.

### `DEFAULT_PENDING_TTL_MS`

```typescript
import { DEFAULT_PENDING_TTL_MS } from "qwuack";
// 600_000  (10 minutes)
```

Exported constant used as the default TTL when stamping `pendingExpiresAt` on a pending
entry. Override per call via the `pendingTtlMs` option.

### `addPendingEntry(accountId, currency, entry, options?)`

Adds a `pending` entry (stamped with `state: "pending"` and `pendingExpiresAt`). It updates
the per-context breakdown but does **not** reserve against the running total — use
`addPendingEntryIfSufficient` when you need a balance-guarded reservation. Returns
`{ duplicate: true }` if the entry id already exists.

```typescript
const { duplicate } = await ledger.addPendingEntry("user_123", "usd", {
  id: "txn_002",
  context: "transfer",
  currency: "usd",
  amount: "-25.00",
}, { pendingTtlMs: 300_000 }); // optional, defaults to DEFAULT_PENDING_TTL_MS
```

### `addPendingEntryIfSufficient(accountId, currency, entry, floor, options?)`

Atomically checks the available sum (`:total + :hold`) and, if `available + amount >= floor`,
adds the entry as `pending`, stamps it `held: true`, and reserves the amount in `:hold`.
Otherwise nothing is written. The whole check-and-reserve runs in a single Redis script, so
concurrent callers cannot both reserve past the floor.

```typescript
const result = await ledger.addPendingEntryIfSufficient(
  "user_123",
  "usd",
  { id: "txn_003", context: "withdrawal", currency: "usd", amount: "-40.00" },
  "0" // floor: available balance may not drop below 0
);
// success:  { success: true,  currentSum: "60.00" }
// rejected: { success: false, reason: "INSUFFICIENT_BALANCE", currentSum: "20.00" }
// duplicate:{ success: true,  duplicate: true, currentSum: "60.00" }
```

### `confirmEntry(accountId, currency, entryId)`

Confirms a `pending` entry: moves its amount from `:hold` into the running `:total` (only
releasing `:hold` when the entry was `held`), sets `confirmedAt`, and clears
`pendingExpiresAt`/`held`.

```typescript
const { status } = await ledger.confirmEntry("user_123", "usd", "txn_003");
// status: "confirmed" | "already_confirmed" | "not_found"
```

### `cancelEntry(accountId, currency, entryId)`

Rolls back a `pending` entry: releases its `:hold` reservation (when `held`), reverses its
context breakdown, and deletes the entry.

```typescript
const { status } = await ledger.cancelEntry("user_123", "usd", "txn_003");
// status: "cancelled" | "not_pending" | "not_found"
```

## Configuration

```typescript
const ledger = new Ledger(redis, {
  maxEntriesPerKey: 500_000,  // Limit entries per account/currency
  keyPrefix: "myapp:ledger",  // Custom key prefix
});
```

## Redis Key Structure

For an account `user_123` with currency `usd` and default prefix:

| Key | Type | Purpose |
|-----|------|---------|
| `ledger:user_123:usd` | Hash | Stores all entries |
| `ledger:user_123:usd:total` | String | Running total sum (confirmed entries) |
| `ledger:user_123:usd:ctx` | Hash | Running totals by context |
| `ledger:user_123:usd:hold` | String | Reserved total from `held` pending entries |

## Performance

| Operation | Time Complexity |
|-----------|-----------------|
| `addEntry` | O(1) |
| `addPendingEntry` | O(1) |
| `addPendingEntryIfSufficient` | O(1) |
| `confirmEntry` | O(1) |
| `cancelEntry` | O(1) |
| `removeEntry` | O(1) |
| `getEntry` | O(1) |
| `getSum` | O(1) |
| `getBalance` | O(1) |
| `getEntriesPaginated` | O(n) where n = page size |
| `clearLedger` | O(1) |

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests with coverage
bun test --coverage

# Build for npm
bun run build
```

## License

MIT
