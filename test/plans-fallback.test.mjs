/**
 * `zpl plans` never once fetched live data.
 *
 * AUDIT 2026-07-31. v1.1.8 replaced a hardcoded plan list with a live fetch
 * from the engine, because the old list claimed token counts 5x what the
 * engine enforced and a user upgrading to Pro for 250K tokens got 50K. The
 * file's own header describes that incident.
 *
 * The live fetch sent no Authorization header. Measured against production:
 *
 *   no auth               -> 401 Missing Authorization header
 *   garbage token         -> 401 Invalid API key format
 *   valid key             -> 200 with the plan catalogue
 *
 * So `res.ok` was false on every call, the function returned null every time,
 * and every user has seen the built-in fallback since. The note under the
 * table read "engine /plans unreachable", which sent anyone investigating to
 * look at an engine that was fine.
 *
 * And the fallback had drifted anyway: Agent carried max_keys 15, against 50
 * on the website and in the MCP's copy, and 20 in the engine's. Four copies of
 * one table, three different values for one field. max_keys is not rendered in
 * the text table, so this was only visible through `--output json`, which is
 * the form scripts consume.
 *
 * Three things are pinned here: the key is sent, the reason for a fallback is
 * distinguished, and the fallback numbers match the website.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "src", "commands", "plans.ts");

/** As granted by the website's PLAN_TIERS, which is what issues the keys. */
const WEBSITE = {
  free: { tokens_per_month: 5_000, max_d: 9, max_keys: 1, price_usd: 0 },
  basic: { tokens_per_month: 10_000, max_d: 16, max_keys: 1, price_usd: 10 },
  pro: { tokens_per_month: 50_000, max_d: 25, max_keys: 3, price_usd: 29 },
  gamepro: { tokens_per_month: 150_000, max_d: 32, max_keys: 5, price_usd: 69 },
  studio: { tokens_per_month: 500_000, max_d: 48, max_keys: 10, price_usd: 149 },
  agent: { tokens_per_month: 2_000_000, max_d: 48, max_keys: 50, price_usd: 199 },
  enterprise: { tokens_per_month: 10_000_000, max_d: 64, max_keys: 25, price_usd: 499 },
  enterprise_xl: { tokens_per_month: 50_000_000, max_d: 100, max_keys: 50, price_usd: 999 },
};

async function source() {
  return readFile(SRC, "utf-8");
}

/** Parse the FALLBACK_PLANS array out of the source. */
async function fallbackPlans() {
  const src = await source();
  const found = {};
  const re =
    /\{\s*name:\s*"(\w+)",\s*tokens_per_month:\s*([\d_]+),\s*price_usd:\s*(\d+),\s*max_d:\s*(\d+),\s*max_keys:\s*(\d+)/g;
  for (const m of src.matchAll(re)) {
    found[m[1]] = {
      tokens_per_month: Number(m[2].replace(/_/g, "")),
      price_usd: Number(m[3]),
      max_d: Number(m[4]),
      max_keys: Number(m[5]),
    };
  }
  return found;
}

test("the fallback list was actually parsed", async () => {
  const plans = await fallbackPlans();
  assert.equal(
    Object.keys(plans).length,
    Object.keys(WEBSITE).length,
    `parsed ${Object.keys(plans).length} fallback plans — the array shape changed and ` +
      `the comparison below would check almost nothing`,
  );
});

test("the fallback numbers match what the website grants", async () => {
  const plans = await fallbackPlans();
  const drift = [];
  for (const [name, expected] of Object.entries(WEBSITE)) {
    const got = plans[name];
    if (!got) {
      drift.push(`${name}: missing from the fallback`);
      continue;
    }
    for (const field of Object.keys(expected)) {
      if (got[field] !== expected[field]) {
        drift.push(`${name}.${field}: fallback ${got[field]}, website ${expected[field]}`);
      }
    }
  }
  assert.deepEqual(
    drift,
    [],
    `the offline list disagrees with the plans customers actually buy:\n  ${drift.join("\n  ")}`,
  );
});

test("the live fetch sends the API key", async () => {
  const src = await source();
  const fn = src.slice(src.indexOf("async function fetchEnginePlans"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(
    body,
    /Authorization:\s*`Bearer \$\{apiKey\}`/,
    "/plans returns 401 without a key — a fetch that omits it can only ever fall back",
  );
});

test("a rejected key is not reported as an unreachable engine", async () => {
  const src = await source();
  assert.match(src, /res\.status === 401/, "401 must be distinguished");
  assert.match(src, /"rejected"/, "a rejected key needs its own reason");
  assert.match(src, /"no-key"/, "not being signed in needs its own reason");
  // Non-comment lines only. The first version of this scanned the whole file
  // and matched the audit comment above fetchEnginePlans, which quotes the old
  // message in order to explain it. A guard that flags its own documentation
  // is a guard the next person deletes.
  const printed = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  assert.doesNotMatch(
    printed,
    /engine \/plans unreachable/,
    "the old note blamed the engine for something that was never the engine",
  );
});

test("the configured engine URL is honoured, and validated first", async () => {
  const src = await source();
  assert.match(src, /ZPL_ENGINE_URL/, "the env override must be read");
  assert.match(
    src,
    /validateEngineUrl\(/,
    "this request carries the API key, so the URL has to pass the same validator " +
      "the rest of the CLI uses before it is sent anywhere",
  );
});
