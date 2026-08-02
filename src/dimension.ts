/**
 * How this tool turns an input into an engine dimension — in one place.
 *
 * Nothing in the CLI lets a caller choose a dimension. Every command that
 * reaches the engine derives one from the text it was given: `check`,
 * `compare`, `consistency`, `diff`, `pipe` and `watch`. The dimension decides
 * both whether the plan allows the call and what it costs, so it is the number
 * a customer most needs explained, and the one they have the least direct
 * control over.
 *
 * AUDIT 2026-08-02: the refusal a customer got when their input was too long
 * for their plan read
 *
 *   Dimension 15 is above your plan's ceiling of 9. Use a smaller dimension,
 *   or raise the ceiling at ...
 *
 * Measured end to end against a real engine with a free-plan key: forty
 * sentences refused, six sentences fine. The advice names a knob this tool
 * does not have — there is no dimension option on any command — so it sends
 * the reader looking for something that is not there, and nothing connects the
 * refusal to the input they actually gave.
 *
 * The band and the mapping live here so the message and the analyser cannot
 * drift. They were previously two inline constants inside analyzeSentiment,
 * and a message that restated them by hand is exactly the shape that has gone
 * stale three times in this codebase already.
 */

/** Narrowest dimension this tool will ask the engine for. */
export const MIN_DIMENSION = 5;

/** Widest. The engine accepts far more; this band suits typical CLI inputs. */
export const MAX_DIMENSION = 15;

/** Sentences that map to one step of dimension. */
const SENTENCES_PER_STEP = 2;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The dimension this tool will use for an input of `sentences` sentences. */
export function dimensionForSentences(sentences: number): number {
  return clamp(Math.floor(sentences / SENTENCES_PER_STEP), MIN_DIMENSION, MAX_DIMENSION);
}

/**
 * The longest input, in sentences, that still fits under `maxD`.
 *
 * Null when no input fits: a ceiling below this tool's own floor cannot be
 * satisfied by shortening anything, and saying "send less" would be false.
 * No real plan is that low — the lowest is well above the floor — but a
 * message that can be wrong eventually is.
 */
export function maxSentencesForDimension(maxD: number): number | null {
  if (!Number.isFinite(maxD) || maxD < MIN_DIMENSION) return null;
  if (maxD >= MAX_DIMENSION) return null; // nothing this tool sends can exceed it
  return maxD * SENTENCES_PER_STEP + (SENTENCES_PER_STEP - 1);
}
