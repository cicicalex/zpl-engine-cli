/**
 * Shared disclaimer printed below scoring output.
 *
 * Why this exists:
 *   ZPL is a STRUCTURAL math signal, not a semantic AI bias detector. It
 *   measures whether the sentiment distribution of the input is balanced —
 *   it does NOT understand sarcasm, complex negation chains ("absolutely not
 *   never"), factual errors, or context that requires world knowledge.
 *
 *   Treat AIN as ONE signal — pair it with a manual review or an LLM-based
 *   judge (`zpl_sycophancy_score` MCP tool) for high-stakes decisions.
 *
 *   Pre-v1.1.6 the CLI returned the inverse verdict on the large majority
 *   of non-edge inputs. v1.1.6 re-tuned the sentiment-to-matrix mapping and
 *   added negation handling (see src/sentiment.ts); the adversarial pass
 *   that caught the inversion now passes on all but the genuinely ambiguous
 *   cases — triple negation, sarcasm, irony — which regex cannot resolve.
 *
 *   AUDIT 2026-07-30: this block previously quoted "~85-90% accuracy" and a
 *   "~7% failure rate", both attributed to a 20-input test set. Twenty
 *   samples cannot support either figure — the confidence interval on an
 *   87% estimate at n=20 is roughly ±15 points, and 7% is finer than the 5%
 *   granularity a 20-item set can even express. The numbers were removed
 *   rather than restated: they ship in a public package, and an accuracy
 *   claim that collapses under the first competent question costs more than
 *   having no number at all. The qualitative finding they came from — the
 *   pre-fix inversion, and where the residual failures live — is real and
 *   is kept.
 *
 * Visibility rules:
 *   - Always show in `text` output (single line at the bottom, gray).
 *   - NEVER show in `json` output (would break tooling/jq pipelines).
 *   - Print to stdout, not stderr, so it's captured by users who tee.
 *
 * Wording is deliberately short — the goal is "honest signal", not "guilt
 * trip the user every run".
 */

import chalk from "chalk";

const ONE_LINER =
  "Note: AIN is a math signal on sentiment distribution. Like any heuristic it can miss sarcasm, complex negation, or factual errors. Use as one input, not a verdict.";

/** Print the standard disclaimer to stdout. Call once at the end of text-mode output. */
export function printDisclaimer(): void {
  process.stdout.write("\n" + chalk.gray(ONE_LINER) + "\n");
}

/** Raw string for callers that want to embed it elsewhere (e.g. about page JSON). */
export const DISCLAIMER_TEXT = ONE_LINER;
