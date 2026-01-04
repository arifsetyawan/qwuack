// build.ts - Build script for qwuack library
import { $ } from "bun";

const startTime = performance.now();

console.log("Building qwuack...\n");

// Clean dist folder
console.log("Cleaning dist/...");
await $`rm -rf dist`.quiet();

// Build JavaScript with Bun
console.log("Compiling TypeScript to JavaScript...");
const result = await Bun.build({
  entrypoints: ["./src/ledger.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: false,
  external: ["redis", "ioredis"],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Generate type declarations with tsc
console.log("Generating type declarations...");
await $`bun run tsc -p tsconfig.build.json`;

const duration = ((performance.now() - startTime) / 1000).toFixed(2);

console.log(`\nBuild complete in ${duration}s`);
console.log("Output:");
console.log("  dist/ledger.js      - ESM bundle");
console.log("  dist/ledger.js.map  - Source map");
console.log("  dist/ledger.d.ts    - Type declarations");
