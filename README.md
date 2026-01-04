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

Removes an entry and updates running totals. Returns `true` if removed, `false` if not found.

```typescript
const removed = await ledger.removeEntry("user_123", "usd", "txn_001");
```

### `getEntry(accountId, currency, entryId)`

Retrieves a single entry by ID. Returns `null` if not found.

```typescript
const entry = await ledger.getEntry("user_123", "usd", "txn_001");
```

### `getSum(accountId, currency)`

Returns the total sum for an account/currency pair. O(1) operation.

```typescript
const total = await ledger.getSum("user_123", "usd");
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

Removes all entries and totals for an account/currency pair.

```typescript
await ledger.clearLedger("user_123", "usd");
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
| `ledger:user_123:usd:total` | String | Running total sum |
| `ledger:user_123:usd:ctx` | Hash | Running totals by context |

## Performance

| Operation | Time Complexity |
|-----------|-----------------|
| `addEntry` | O(1) |
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
