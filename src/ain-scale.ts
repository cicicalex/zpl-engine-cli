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

/**
 * Signed distance of the output balance from the 0.500 equilibrium point.
 *
 * AUDIT 2026-07-30: `p_output` is the measurement the engine actually makes —
 * the balance of the output stream, 0.500 being equilibrium. It arrives on
 * every response and no command had ever printed it.
 *
 * AIN is derived from it through an absolute value, so it cannot say which
 * side of equilibrium a reading sits on: p_output 0.4687 and 0.5313 both come
 * back as AIN 93.73. For a tool whose purpose is finding a stable centre,
 * which way it leans is half the answer, and that half never reached the
 * terminal.
 *
 * Negative leans toward 0, positive toward 1.
 */
export function equilibriumOffset(pOutput: number): string {
  const delta = pOutput - 0.5;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
  const lean =
    Math.abs(delta) < 5e-7 ? "dead centre" : delta > 0 ? "leans toward 1" : "leans toward 0";
  return `${sign}${Math.abs(delta).toFixed(6)} (${lean})`;
}

/** Render p_output itself, six decimals — the engine's own precision. */
export function fmtPOutput(pOutput: number): string {
  return pOutput.toFixed(6);
}
