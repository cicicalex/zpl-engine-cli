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
  // Free + Pro + Enterprise should appear in the table
  assert.match(r.stdout, /Free/);
  assert.match(r.stdout, /Pro/);
  assert.match(r.stdout, /Enterprise/);
});

test("plans --output json emits valid JSON with expected shape", () => {
  const r = runCli(["plans", "--output", "json"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.currency, "EUR");
  assert.equal(parsed.billing, "monthly");
  assert.ok(Array.isArray(parsed.plans));
  assert.ok(parsed.plans.length >= 5, `expected >= 5 plans, got ${parsed.plans.length}`);
  // Every plan has the expected keys
  for (const p of parsed.plans) {
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.monthly_tokens, "number");
    assert.equal(typeof p.price_eur_month, "number");
    assert.equal(typeof p.notes, "string");
  }
  // Free plan must exist with 0 EUR
  const free = parsed.plans.find((p) => p.name === "Free");
  assert.ok(free, "Free plan must exist");
  assert.equal(free.price_eur_month, 0);
});

test("plans rejects bogus --output value", () => {
  const r = runCli(["plans", "--output", "yaml"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --output/i);
});
