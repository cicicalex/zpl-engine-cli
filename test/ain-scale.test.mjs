/**
 * Tests for the AIN scale conversion.
 *
 * The rule these lock in: the engine's `ain` (0.0–1.0) may be presented as a
 * percentage, but must not be collapsed to an integer. Two AIN values that
 * differ only in the decimals must stay distinguishable, otherwise the
 * determinism claim the product is sold on cannot be checked by the CLI that
 * is supposed to check it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ainPercent, fmtAin, fmtAinDelta } from "../dist/ain-scale.js";

test("ainPercent scales 0.0-1.0 to 0.00-100.00", () => {
  assert.equal(ainPercent(0), 0);
  assert.equal(ainPercent(1), 100);
  assert.equal(ainPercent(0.5), 50);
});

test("ainPercent keeps two decimals of the percentage", () => {
  assert.equal(ainPercent(0.932412), 93.24);
  assert.equal(ainPercent(0.999999), 100);
  assert.equal(ainPercent(0.004999), 0.5);
});

test("ainPercent does NOT round to an integer", () => {
  // The pre-fix behaviour was Math.round(ain * 100), which mapped all three
  // of these to 93 and made sub-point drift invisible.
  const a = ainPercent(0.9312);
  const b = ainPercent(0.9324);
  const c = ainPercent(0.9349);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.equal(new Set([a, b, c]).size, 3);
});

test("ainPercent matches (ain * 100).toFixed(2)", () => {
  for (const ain of [0.123456, 0.5, 0.809999, 0.960001, 0.42]) {
    assert.equal(ainPercent(ain), Number((ain * 100).toFixed(2)));
  }
});

test("fmtAin always renders two decimals", () => {
  assert.equal(fmtAin(93.24), "93.24");
  assert.equal(fmtAin(100), "100.00");
  assert.equal(fmtAin(0), "0.00");
});

test("fmtAinDelta signs the value explicitly", () => {
  assert.equal(fmtAinDelta(3.5), "+3.50");
  assert.equal(fmtAinDelta(0), "+0.00");
  assert.equal(fmtAinDelta(-1.25), "-1.25");
});
