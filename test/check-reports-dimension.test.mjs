/**
 * `zpl check --output json` must say what dimension it was billed at.
 *
 * AUDIT 2026-07-31: `d` was computed by analyzeSentiment, sent to the engine,
 * and then dropped before the JSON was written. Measured by running the built
 * command against the live engine at five input sizes:
 *
 *      3 lines -> 1 token      16 lines -> 2 tokens
 *      9 lines -> 1 token      25 lines -> 5 tokens      40 lines -> 5 tokens
 *
 * The price changed with the input and nothing in the output said why.
 * `--output json` exists so scripts can consume this — the docs advertise
 * `zpl check | jq .ain` — and a script could read what it had been charged but
 * not what it had been charged FOR. It could neither predict the next call nor
 * check this one.
 *
 * The same figure also explains something that looks like a bug and is not: 25
 * lines and 40 lines cost the same because the CLI clamps d to 5..15, so both
 * land in the 10..16 price band. Defensible behaviour, previously invisible.
 *
 * Two things are pinned here. That the dimension reaches the output, and that
 * it is the one actually sent — the value passed to client.compute and the
 * value serialised must come from the same binding, or the JSON would report a
 * price basis the call never used.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeSentiment } from "../dist/sentiment.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK = join(ROOT, "src", "commands", "check.ts");

function stripComments(src) {
  // One pass, alternating: a `/*` inside a line comment must not open a block.
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_m, before) => before ?? "");
}

const lines = (n) =>
  Array.from({ length: n }, (_, i) => `Line ${i}: this is sentence number ${i} with some content.`).join("\n");

test("the dimension is clamped to a band the cheapest plans can afford", () => {
  // Free is capped at d=9 by the engine, so a CLI that scaled d with input
  // length without bound would start returning 403 on long files. It clamps.
  for (const n of [1, 3, 9, 16, 25, 40, 200]) {
    const { d } = analyzeSentiment(lines(n));
    assert.ok(
      d >= 5 && d <= 15,
      `${n} lines produced d=${d}, outside the 5..15 clamp. Above 16 the cost band ` +
        `changes and every plan below Pro starts refusing the call.`,
    );
  }
});

test("the dimension actually varies with the input, so reporting it is worth doing", () => {
  // If d were constant the field would be noise. It is not: measured 5, 5, 8,
  // 12, 15 across the sizes above.
  const seen = new Set([3, 9, 16, 25, 40].map((n) => analyzeSentiment(lines(n)).d));
  assert.ok(
    seen.size > 1,
    `d is the same (${[...seen]}) at every input size, so it no longer explains the ` +
      `price and this whole guard is pointless — check what changed in analyzeSentiment.`,
  );
});

test("the JSON output carries the dimension", async () => {
  const code = stripComments(await readFile(CHECK, "utf-8"));

  const at = code.indexOf('output === "json"');
  assert.notEqual(at, -1, "the JSON branch is gone — this guard checks nothing");
  const branch = code.slice(at, code.indexOf("return {", at));

  assert.match(
    branch,
    /^\s*d,\s*$/m,
    "the JSON output no longer includes `d`. It is the only input to the price, and " +
      "the output prints tokens_used without it — a consumer can see the bill and not " +
      "the basis for it.",
  );
});

test("the dimension reported is the one sent to the engine", async () => {
  // A separately-computed `d` in the output would be worse than none: it would
  // look authoritative and describe a call that never happened.
  const code = stripComments(await readFile(CHECK, "utf-8"));

  assert.match(
    code,
    /const \{[^}]*\bd\b[^}]*\} = analyzeSentiment\(text\)/,
    "`d` is no longer destructured from analyzeSentiment, so the value in the JSON " +
      "may not be the one the call was priced on",
  );
  assert.match(
    code,
    /client\.compute\(\{\s*d\s*,/,
    "client.compute no longer receives that same `d` binding",
  );
});
