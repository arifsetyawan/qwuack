// example.ts
import {
  addEntry,
  removeEntry,
  getEntry,
  getBalance,
  redis,
  getSum,
  getAllEntries,
  clearLedger,
} from "./ledger-optimized";

const accountId = "acc_123";
const currency = "vnd";

// Define entries dynamically
const entries = [
  { id: "c9b598e4-34dd-434b-92ee-ebaeb806a4ca", context: "funding", amount: "1000000", currency: "vnd" },
  { id: "da4ebc84-83fc-47aa-bef2-c1e74209c2d3", context: "sm_fund", amount: "-200000", currency: "vnd" },
  { id: "589c895e-5fc8-4b53-b5ec-9add61097d36", context: "sm_fund", amount: "-100000", currency: "vnd" },
];

for (const entry of entries) {
  await addEntry(accountId, entry.currency, entry);
}

console.log("Sum:", await getSum(accountId, currency));

// Remove one entry (second entry)
// await removeEntry(accountId, currency, "c9b598e4-34dd-434b-92ee-ebaeb806a4ca");
// console.log("After removal:", await getSum(accountId, currency));

// Get specific entry (first entry)
console.log("Remaining Entry", await getAllEntries(accountId, currency));

// console.log("Clearing ledger...");
// await clearLedger(accountId, currency);

await redis.quit();