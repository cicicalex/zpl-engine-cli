/**
 * `zpl diff --lines` must not print a mean it did not measure.
 *
 * AUDIT 2026-07-31: the exit code and the stderr warning for "no line pair
 * could be scored" were added on 2026-07-30, and they work — measured against
 * a closed port, the command exits 1 and stderr reads "the mean above is not a
 * measurement". But stdout still carried
 *
 *   Scored lines:  0 of 3
 *   Failed lines:  3
 *   Changed lines: 0
 *   Mean delta:    +0.00 AIN (unchanged)
 *
 * and stdout is what a script greps. Anything reading the Mean delta row saw a
 * clean, unchanged +0.00 for a run in which the engine answered nothing at
 * all. The mean of zero samples is not zero; it is absent.
 *
 * These tests call the formatter rather than matching the source. Two guards
 * written tonight passed while the defect sat in the file, both because they
 * described the shape of the code instead of checking what it produced.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { formatLineDiffSummary } from "../dist/commands/diff.js";

/** Strip ANSI so assertions read the text a user sees. */
const plain = (s) => s.replace(/\[[0-9;]*m/g, "");

const NOTHING_SCORED = {
  totalTokens: 0,
  changedLines: 0,
  meanDelta: 0,
  scored: 0,
  failed: 3,
};

const ALL_SCORED = {
  totalTokens: 6,
  changedLines: 2,
  meanDelta: 20.4,
  scored: 3,
  failed: 0,
};

const PARTIAL = {
  totalTokens: 4,
  changedLines: 1,
  meanDelta: -3.5,
  scored: 2,
  failed: 1,
};

test("a run that scored nothing prints no mean", () => {
  const out = plain(formatLineDiffSummary(NOTHING_SCORED));
  assert.match(out, /Mean delta:\s+not measured/, "the mean must be named absent");
  assert.doesNotMatch(
    out,
    /Mean delta:.*[+-]?\d+\.\d+ AIN/,
    "no numeric mean may appear when nothing was scored",
  );
  assert.doesNotMatch(
    out,
    /unchanged/,
    `"unchanged" is a verdict, and a run that measured nothing reached none`,
  );
  assert.match(out, /Scored lines:\s+0 of 3/, "the counts still have to be reported");
});

test("a healthy run still prints the real mean and its label", () => {
  const out = plain(formatLineDiffSummary(ALL_SCORED));
  assert.match(out, /Mean delta:\s+\+20\.40 AIN \(improved\)/);
  assert.match(out, /Scored lines:\s+3 of 3/);
  assert.doesNotMatch(out, /Failed lines/, "no failures, so no failure row");
  assert.doesNotMatch(out, /not measured/);
});

test("a partial run reports both the mean and what was lost", () => {
  const out = plain(formatLineDiffSummary(PARTIAL));
  assert.match(out, /Scored lines:\s+2 of 3/, "denominator counts the failures too");
  assert.match(out, /Failed lines:\s+1/);
  assert.match(out, /Mean delta:\s+-3\.50 AIN \(worsened\)/, "a real mean over the pairs that ran");
});

test("the counts always add up", () => {
  for (const r of [NOTHING_SCORED, ALL_SCORED, PARTIAL]) {
    const out = plain(formatLineDiffSummary(r));
    const m = out.match(/Scored lines:\s+(\d+) of (\d+)/);
    assert.ok(m, "scored line missing");
    assert.equal(Number(m[1]), r.scored);
    assert.equal(
      Number(m[2]),
      r.scored + r.failed,
      "the denominator must be every pair attempted, not just the ones that worked",
    );
  }
});
