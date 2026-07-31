/**
 * The verdict line must not contradict the status line above it.
 *
 * AUDIT 2026-07-31: `zpl check` prints the engine's ain_status and its own
 * verdict on consecutive lines. verdictFor had its own bands - 80/60/40 -
 * so across the middle of the scale the two disagreed:
 *
 *   AIN 85  engine NEUTRAL        verdict "highly balanced"
 *   AIN 75  engine MODERATE_BIAS  verdict "moderately balanced"
 *   AIN 65  engine MODERATE_BIAS  verdict "moderately balanced"
 *
 * The whole 60-79 range was called balanced by a client whose own header had
 * just printed MODERATE_BIAS. One line apart, opposite framings, same number.
 *
 * `zpl about` published the same bands as documentation and added
 * "trustworthy" at >= 80 - a claim the engine makes about nothing.
 *
 * Last of five surfaces carrying its own vocabulary. The MCP had three and
 * both SDKs had one each, and the two SDKs had drifted apart from each other
 * as well. Every client now uses the engine's boundaries and the same words.
 *
 * Measured after the fix, live: AIN 29.40 HIGH_BIAS over "high bias", and
 * AIN 90.00 HIGHLY_NEUTRAL over "highly neutral".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The engine's bands, from crates/zpl-core/src/ain.rs, on the 0-100 scale. */
const BANDS = [
  [96, "certified neutral"],
  [90, "highly neutral"],
  [80, "neutral"],
  [60, "moderate bias"],
  [40, "significant bias"],
  [0, "high bias"],
];

const expected = (ain) => BANDS.find(([lo]) => ain >= lo)[1];

/** Pull verdictFor out of the source and run it. */
async function verdictFor() {
  const src = await readFile(join(ROOT, "src", "commands", "check.ts"), "utf-8");
  const m = src.match(/function verdictFor[\s\S]*?\n}/);
  assert.ok(m, "verdictFor not found — this test would check nothing");
  const body = m[0]
    .replace("function verdictFor", "function")
    .replace(/:\s*number/, "")
    .replace(/:\s*string/, "");
  return eval(`(${body})`);
}

test("every verdict is the engine's band for that reading", async () => {
  const fn = await verdictFor();
  const wrong = [];
  for (let tenths = 0; tenths <= 1000; tenths++) {
    const ain = tenths / 10;
    if (fn(ain) !== expected(ain)) {
      wrong.push(`AIN ${ain}: "${fn(ain)}" where the engine says ${expected(ain)}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} readings disagree with the engine`);
});

test("no reading the engine calls biased is described as balanced", async () => {
  const fn = await verdictFor();
  const contradictions = [];
  for (let ain = 0; ain <= 100; ain += 0.5) {
    const engineSaysBias = expected(ain).includes("bias");
    if (engineSaysBias && fn(ain).includes("balanced")) {
      contradictions.push(`AIN ${ain}: "${fn(ain)}" under ${expected(ain)}`);
    }
  }
  assert.deepEqual(
    contradictions.slice(0, 5),
    [],
    `${contradictions.length} readings where the verdict says balanced and the ` +
      `status line directly above says bias`,
  );
});

test("the boundaries are the engine's", async () => {
  const fn = await verdictFor();
  assert.equal(fn(96), "certified neutral");
  assert.equal(fn(95.9), "highly neutral");
  assert.equal(fn(90), "highly neutral");
  assert.equal(fn(89.9), "neutral");
  assert.equal(fn(80), "neutral");
  assert.equal(fn(79.9), "moderate bias");
  assert.equal(fn(60), "moderate bias");
  assert.equal(fn(59.9), "significant bias");
  assert.equal(fn(40), "significant bias");
  assert.equal(fn(39.9), "high bias");
});

test("the published band table matches, and claims nothing extra", async () => {
  const raw = await readFile(join(ROOT, "src", "commands", "about.ts"), "utf-8");

  // Non-comment lines only. The audit note above the table names the word it
  // removed, and the first version of this matched that - the fourth guard
  // tonight to flag its own documentation.
  //
  // Same distinction as elsewhere in this repo: a rule about a *word* skips
  // comments, because quoting a bad word in a comment ships nothing. The rule
  // keeping the engine's derivation out of published packages does not skip
  // them, because a formula in a comment still ships the secret. What the
  // comment contains decides which way the rule goes.
  const about = raw
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

  for (const [, name] of BANDS) {
    assert.ok(about.includes(name), `the about table does not mention "${name}"`);
  }
  assert.ok(
    !about.includes("trustworthy"),
    "the engine reports balance, not trustworthiness — that word was added here " +
      "and is supported by nothing the engine returns",
  );
  assert.ok(
    !about.includes("highly balanced"),
    "the old vocabulary is back in the published table",
  );
});
