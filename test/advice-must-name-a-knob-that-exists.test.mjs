/**
 * A refusal must tell the customer something they can actually do.
 *
 * AUDIT 2026-08-02. When an input was too long for the plan, the CLI said:
 *
 *   Dimension 15 is above your plan's ceiling of 9. Use a smaller dimension,
 *   or raise the ceiling at ...
 *
 * No command in this tool takes a dimension. All six that reach the engine —
 * check, compare, consistency, diff, pipe and watch — derive one from the text
 * they were given. So the reader was sent looking for an option that does not
 * exist, and nothing connected the refusal to the input they had typed.
 *
 * Measured end to end against a real engine with a free-plan key: forty
 * sentences refused at dimension 15 against a ceiling of 9, six sentences
 * fine. After the fix the message names the real lever and the real number,
 * and the boundary it promises was measured too — 18 and 19 sentences pass,
 * 20 and 21 are refused, against a ceiling of 9.
 *
 * The first two groups below are behavioural: they call the real functions and
 * construct the real error. The last group reads source, comments stripped,
 * because "this tool has no dimension option" is a fact about the argument
 * table and cannot be observed from one command's output.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MIN_DIMENSION,
  MAX_DIMENSION,
  dimensionForSentences,
  maxSentencesForDimension,
} from "../dist/dimension.js";
import { ApiDimensionError } from "../dist/api-client.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_m, b) => b ?? "");

// ── The number in the message has to be true ──────────────────────────────

test("the advertised sentence count fits, and one more does not", async () => {
  // The property that makes the message honest. Every plan ceiling this tool
  // can meet, checked against the mapping the analyser actually uses - so the
  // two cannot drift into a message that promises a length which is refused.
  for (let ceiling = MIN_DIMENSION; ceiling < MAX_DIMENSION; ceiling++) {
    const fits = maxSentencesForDimension(ceiling);
    assert.notEqual(fits, null, `no sentence count offered for a ceiling of ${ceiling}`);
    assert.ok(
      dimensionForSentences(fits) <= ceiling,
      `the message would promise ${fits} sentences for a ceiling of ${ceiling}, but ` +
        `that many produces dimension ${dimensionForSentences(fits)} and is refused`,
    );
    assert.ok(
      dimensionForSentences(fits + 1) > ceiling,
      `${fits} is not the largest input that fits a ceiling of ${ceiling} - ` +
        `${fits + 1} sentences still produce ${dimensionForSentences(fits + 1)}, so the ` +
        `advice sends the customer to cut more than they need to`,
    );
  }
});

test("a ceiling this tool cannot get under offers no false hope", () => {
  // Below the floor, no input is short enough. Saying "send less" would be a
  // lie, and the message has a different branch for it.
  assert.equal(maxSentencesForDimension(MIN_DIMENSION - 1), null);
  assert.equal(maxSentencesForDimension(0), null);
});

test("a ceiling above everything this tool sends needs no advice", () => {
  // Nothing this tool asks for can exceed its own top, so a plan at or above
  // it never refuses on dimension, and there is no length to recommend.
  assert.equal(maxSentencesForDimension(MAX_DIMENSION), null);
  assert.equal(maxSentencesForDimension(100), null);
});

test("the free plan's boundary is the one that was measured", () => {
  // Nineteen sentences pass and twenty are refused against a ceiling of 9.
  // Measured by running the built CLI against a real engine, not derived here.
  assert.equal(maxSentencesForDimension(9), 19);
  assert.ok(dimensionForSentences(19) <= 9);
  assert.ok(dimensionForSentences(20) > 9);
});

// ── What the customer reads ───────────────────────────────────────────────

test("the refusal names the input, not a setting", () => {
  const message = new ApiDimensionError(15, 9).message;
  assert.match(
    message,
    /\b19\b/,
    `the message does not tell the customer how long an input would fit:\n${message}`,
  );
  assert.match(
    message,
    /input/i,
    `nothing in the message connects the refusal to what the customer sent:\n${message}`,
  );
  assert.doesNotMatch(
    message,
    /\buse a smaller dimension\b/i,
    `the message still points at a dimension setting. No command in this tool ` +
      `takes one, so this sends the reader looking for something that is not ` +
      `there:\n${message}`,
  );
});

test("the ceiling and what was asked for are both still named", () => {
  // The diagnosis has to survive the better advice.
  const message = new ApiDimensionError(15, 9).message;
  assert.match(message, /\b15\b/, `what was asked for is missing:\n${message}`);
  assert.match(message, /ceiling of 9/, `the plan's ceiling is missing:\n${message}`);
});

test("at the engine's own maximum, nobody is told to pay more", () => {
  const message = new ApiDimensionError(100, 100).message;
  assert.doesNotMatch(
    message,
    /pricing/,
    `the top plan already grants the engine's maximum, so an upgrade link is ` +
      `advice no amount of money can follow:\n${message}`,
  );
});

test("a refusal with no numbers still avoids the missing knob", () => {
  const message = new ApiDimensionError().message;
  assert.doesNotMatch(message, /\buse a smaller dimension\b/i, message);
  assert.match(message, /shorter input/i, message);
});

// ── The premise the advice rests on ───────────────────────────────────────

test("no command actually takes a dimension", async () => {
  // If one is ever added, the advice above becomes wrong in the other
  // direction, and this is where that gets noticed.
  const code = strip(await readFile(join(ROOT, "src", "index.ts"), "utf-8"));
  const options = [...code.matchAll(/\.option\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  assert.ok(
    options.length > 10,
    `only ${options.length} options found - the scan is not reading the argument ` +
      `table, so the check below would pass over almost nothing`,
  );
  const dimensionFlags = options.filter((o) => /(^|\W)(-d\b|--dimension\b)/.test(o));
  assert.deepEqual(
    dimensionFlags,
    [],
    `this tool now takes a dimension (${dimensionFlags.join(", ")}). The refusal ` +
      `message says the dimension comes from the input length, which is no longer ` +
      `the whole truth - revisit it.`,
  );
});

test("the analyser and the message read the same mapping", async () => {
  // A second copy of this rule is a copy that goes stale, which is how the
  // wrong advice survived in the first place.
  const code = strip(await readFile(join(ROOT, "src", "sentiment.ts"), "utf-8"));
  assert.match(
    code,
    /dimensionForSentences\s*\(/,
    "the analyser computes the dimension itself again instead of using the " +
      "shared mapping, so the number in the refusal message can drift away " +
      "from the number the tool actually sends",
  );
});
