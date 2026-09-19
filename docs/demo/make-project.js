import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { join } from "node:path";

const target = process.argv[2] ?? "/tmp/checkout-service";

const PACKAGE_JSON = `{
  "name": "checkout-service",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "node run-tests.js"
  }
}
`;

const SETTINGS_JSON = `{ "permissions": { "allow": ["Bash(npm test:*)"] } }
`;

const RUN_TESTS = `const suites = [
  ["src/cart/totals.test.js", "totals", ["sums line items", "applies a percentage discount", "rounds to two decimals", "keeps the currency code", "handles an empty cart", "rejects a negative quantity", "merges duplicate skus", "caps the quantity at 99"]],
  ["src/cart/shipping.test.js", "shipping", ["picks the cheapest rate", "adds handling for oversize items", "falls back to flat rate", "skips shipping for digital goods", "uses the billing address", "splits a multi-warehouse order", "reads the carrier cutoff", "marks a PO box"]],
  ["src/checkout/session.test.js", "session", ["creates a session", "expires after 30 minutes", "rejects an expired token", "reuses an open session", "clears the cart on completion", "stores the idempotency key", "locks inventory", "releases the lock on abandon"]],
  ["src/checkout/payment.test.js", "payment", ["authorizes a card", "captures on fulfilment", "voids an unused authorization", "retries a network failure", "declines an invalid cvv", "records the processor id", "refunds a partial amount", "rejects a zero amount"]],
  ["src/catalog/pricing.test.js", "pricing", ["reads the list price", "applies a tier price", "prefers the contract price", "falls back to list", "converts currency", "keeps two decimals", "rejects a missing price", "caches by sku"]],
  ["src/catalog/search.test.js", "search", ["matches a prefix", "ranks by relevance", "filters by facet", "paginates results", "handles an empty query", "trims whitespace", "escapes special characters", "returns a total count"]],
  ["src/inventory/stock.test.js", "stock", ["decrements on sale", "increments on return", "reserves for a session", "releases a reservation", "reads a warehouse total", "flags a backorder", "rejects a negative adjustment", "audits every change"]],
  ["src/webhooks/dispatch.test.js", "dispatch", ["signs the payload", "retries on 500", "gives up after five tries", "records the attempt", "drops an unknown event", "batches by endpoint", "respects the rate limit", "redacts the customer email"]],
];
const SLOW = {
  "src/checkout/session.test.js": { "reuses an open session": 3184 },
  "src/catalog/search.test.js": { "ranks by relevance": 2470 },
  "src/webhooks/dispatch.test.js": { "gives up after five tries": 9418 },
};
let pass = 0;
process.stdout.write("\\n RUN  v2.1.9 checkout-service\\n\\n");
for (const [file, name, tests] of suites) {
  for (const t of tests) {
    const slow = SLOW[file] && SLOW[file][t];
    const ms = slow || (1 + ((t.length * 7 + name.length * 13) % 240));
    pass += 1;
    process.stdout.write(" \\u2713 " + file + " > " + name + " > " + t + " " + ms + "ms\\n");
  }
  process.stdout.write("stderr | " + file + " > " + name + " > setup\\n");
  for (let i = 0; i < 20; i += 1) {
    process.stdout.write("[" + name + "] seed " + i + "\\n");
  }
}
process.stdout.write("\\n Test Files  8 passed (8)\\n      Tests  " + pass + " passed (" + pass + ")\\n   Duration  18.94s\\n");
`;

await mkdir(join(target, ".claude"), { recursive: true });
await writeFile(join(target, "package.json"), PACKAGE_JSON, "utf8");
await writeFile(join(target, "run-tests.js"), RUN_TESTS, "utf8");
await writeFile(join(target, ".claude", "settings.local.json"), SETTINGS_JSON, "utf8");
