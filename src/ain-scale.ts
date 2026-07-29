/**
 * AIN scale conversion — one place, so every command presents the same number.
 *
 * The engine returns `ain` on a 0.0–1.0 scale. Clients may present it as a
 * percentage (×100), but must NOT collapse it to an integer: rounding to a
 * whole number throws away most of the engine's precision, and determinism /
 * reproducibility is the whole point of the product. A `consistency` probe
 * that compares integers cannot see sub-percent drift at all.
 *
 * Pre-fix every command did `Math.round(res.ain * 100)`. This module replaces
 * that with the two-decimal percentage form (equivalent to
 * `(ain * 100).toFixed(2)`), which is what the CLI actually reports.
 */

/**
 * Engine scale (0.0–1.0) → percentage (0.00–100.00), two decimals kept.
 * Equivalent in value to `Number((ain * 100).toFixed(2))`.
 */
export function ainPercent(ain: number): number {
  return Math.round(ain * 10_000) / 100;
}

/** Render a percentage-scale AIN (or an AIN delta) with two decimals. */
export function fmtAin(percent: number): string {
  return percent.toFixed(2);
}

/** Render an AIN delta with an explicit sign, two decimals. */
export function fmtAinDelta(percent: number): string {
  return (percent >= 0 ? "+" : "") + percent.toFixed(2);
}
