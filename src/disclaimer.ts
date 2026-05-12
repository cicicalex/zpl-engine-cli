/**
 * Shared disclaimer printed below scoring output.
 *
 * Why this exists:
 *   ZPL is a STRUCTURAL math signal, not a semantic AI bias detector. It
 *   measures whether the sentiment distribution of the input is balanced —
 *   it does NOT understand sarcasm, complex negation chains ("absolutely not
 *   never"), factual errors, or context that requires world knowledge.
 *
 *   Realistic accuracy on typical AI-generated text is ~85-90% relative to
 *   human intuition (measured across our internal 20-input brutal test set).
 *   So treat AIN as ONE signal — pair it with a manual review or an
 *   LLM-based judge (`zpl_sycophancy_score` MCP tool) for high-stakes
 *   decisions.
 *
 *   Pre-v1.1.6 the CLI gave the inverse answer ~80% of the time. v1.1.6
 *   re-tuned the sentiment-to-matrix mapping and added negation handling
 *   (see src/sentiment.ts). Failure rate dropped to ~7% on the same test
 *   set, but the remaining 7% lives in genuinely ambiguous text (triple
 *   negation, sarcasm, irony) that regex cannot resolve.
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
