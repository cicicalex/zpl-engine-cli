/**
 * Tests for the plans command — static catalogue, no engine call.
 * Validates JSON output shape (so agents can rely on it) + format flag handling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runCli(args) {
  return spawnSync(process.execPath, ["dist/index.js", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ZPL_SKIP_UPDATE_CHECK: "1" },
  });
}

test("plans exits 0 with text output", () => {
  const r = runCli(["plans"]);
  assert.equal(r.status, 0);
  // free + pro + enterprise should appear in the table (lowercase
  // because engine returns plan names in canonical lowercase form).
  assert.match(r.stdout, /free/);
  assert.match(r.stdout, /pro/);
  assert.match(r.stdout, /enterprise/);
});

test("plans --output json emits valid JSON with expected shape", () => {
  const r = runCli(["plans", "--output", "json"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  // v1.1.8: source = engine_live (when reachable) or client_fallback.
  // Currency switched from EUR to USD because engine /plans returns price_usd.
  assert.match(parsed.source, /^(engine_live|client_fallback)$/);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.billing, "monthly");
  assert.ok(Array.isArray(parsed.plans));
  assert.ok(parsed.plans.length >= 5, `expected >= 5 plans, got ${parsed.plans.length}`);
  // Every plan has the expected keys
  for (const p of parsed.plans) {
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.tokens_per_month, "number");
    assert.equal(typeof p.price_usd, "number");
    assert.equal(typeof p.max_d, "number");
    assert.equal(typeof p.max_keys, "number");
  }
  // Free plan must exist with 0 USD
  const free = parsed.plans.find((p) => p.name === "free");
  assert.ok(free, "free plan must exist");
  assert.equal(free.price_usd, 0);
});

test("plans rejects bogus --output value", () => {
  const r = runCli(["plans", "--output", "yaml"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --output/i);
});
