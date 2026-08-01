import chalk, { type ChalkInstance } from "chalk";
import { requireConfig } from "../config.js";
import {
  ApiClient, ApiAuthError, ApiCloudflareError, ApiQuotaExhaustedError,
  ApiUpgradeRequiredError,
} from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { readTextFileOrDie } from "../file-utils.js";
import { printDisclaimer } from "../disclaimer.js";
import { ainPercent, fmtAin, fmtAinDelta } from "../ain-scale.js";

export interface DiffOptions {
  /** Score line-by-line instead of whole-file (bug #11 alignment with /cli docs). */
  lines?: boolean;
  /** Cap number of lines scored when --lines is on (defence against huge files). */
  maxLines?: string;
}

async function score(client: ApiClient, text: string) {
  const { bias, d } = analyzeSentiment(text);
  const res = await client.compute({ d, bias, samples: 1000 });
  // Percentage scale, decimals preserved — see src/ain-scale.ts.
  return { ain: ainPercent(res.ain), status: res.ain_status, tokens: res.tokens_used };
}

function labelDelta(delta: number): { label: string; color: ChalkInstance } {
  if (delta > 2) return { label: "improved", color: chalk.green };
  if (delta < -2) return { label: "worsened", color: chalk.red };
  return { label: "unchanged", color: chalk.gray };
}

const DEFAULT_MAX_LINES = 40;

/** What runLineDiff reports back, and what the summary is rendered from. */
export interface LineDiffResult {
  totalTokens: number;
  changedLines: number;
  meanDelta: number;
  scored: number;
  failed: number;
}

/**
 * Render the Summary block.
 *
 * AUDIT 2026-07-31: with nothing scored this printed
 * "Mean delta: +0.00 AIN (unchanged)" on stdout. The exit code and the stderr
 * warning were fixed on 2026-07-30, so the command already failed correctly —
 * but the fabricated number stayed on stdout, and stdout is what a script
 * greps. Measured against a closed port: exit 1, "Scored lines: 0 of 3", and
 * "+0.00 AIN (unchanged)" printed two lines below it.
 *
 * A mean over zero samples is not zero, it is absent.
 *
 * Extracted from the command so this is a unit test rather than a regex over
 * the source. Two guards of mine reported green on the defect they were
 * written for tonight, both because they checked the shape of the code instead
 * of what it produces.
 */
export function formatLineDiffSummary(result: LineDiffResult): string {
  const { label, color } = labelDelta(result.meanDelta);
  const meanRow =
    result.scored === 0
      ? `  Mean delta:    ${chalk.red("not measured")} (0 of ${result.failed} pairs scored)\n`
      : `  Mean delta:    ${color(fmtAinDelta(result.meanDelta))} AIN (${color(label)})\n`;
  return (
    `\n${chalk.bold("Summary")}\n` +
    `  Scored lines:  ${result.scored} of ${result.scored + result.failed}\n` +
    (result.failed > 0 ? `  ${chalk.red(`Failed lines:  ${result.failed}`)}\n` : "") +
    `  Changed lines: ${result.changedLines}\n` +
    meanRow +
    `  Tokens:        ${result.totalTokens}\n`
  );
}

/**
 * Line-level diff mode (bug #11 fix).
 *
 * The /cli docs page describes diff as *"Identify lines drifting from
 * neutrality"* but the pre-1.1.6 implementation only computed a whole-file
 * delta. This mode aligns with the docs: pair up matching lines from
 * before/after by index, score each pair, and surface lines whose delta
 * exceeds the noise threshold (±2 AIN).
 *
 * Caveats:
 *   - Pairs lines by index, not by content alignment. If the file got
 *     re-ordered or had insertions, results will mislead. For real
 *     content-aware diffing use `git diff` first then pipe each hunk through
 *     `zpl pipe`.
 *   - Caps at --max-lines (default 40) to avoid blowing the free token
 *     budget on a huge log file.
 */
async function runLineDiff(
  client: ApiClient,
  textBefore: string,
  textAfter: string,
  maxLines: number,
): Promise<{
  totalTokens: number;
  changedLines: number;
  meanDelta: number;
  /** Pairs that produced a delta. A mean over zero of these is not a reading. */
  scored: number;
  /** Pairs the engine could not score. */
  failed: number;
}> {
  const linesBefore = textBefore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const linesAfter = textAfter.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const pairCount = Math.min(linesBefore.length, linesAfter.length, maxLines);

  process.stdout.write(
    chalk.bold(`Line-level diff: ${pairCount} line pairs (capped at ${maxLines})\n\n`),
  );

  let totalTokens = 0;
  let changed = 0;
  // Pairs the engine could not score. Counted so the summary can say how much
  // of the diff actually ran, instead of averaging over whatever survived.
  let failed = 0;
  const deltas: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    const bef = linesBefore[i];
    const aft = linesAfter[i];
    if (bef.length < 5 || aft.length < 5) {
      process.stdout.write(chalk.gray(`  L${i + 1}: skipped (too short)\n`));
      continue;
    }
    let sBefore;
    let sAfter;
    try {
      [sBefore, sAfter] = await Promise.all([score(client, bef), score(client, aft)]);
    } catch (err) {
      // AUDIT 2026-07-30: this caught everything and carried on, including the
      // errors the API client re-throws precisely because retrying them is
      // pointless — a rejected key, an exhausted quota, a Cloudflare block.
      // With every pair failing, `deltas` stayed empty, the mean collapsed to
      // 0, and the command printed "Mean delta: +0.00 AIN (unchanged)" and
      // exited 0. A total engine outage was indistinguishable from a clean
      // run, and appendHistory recorded the fabricated clean row.
      //
      // The same command's whole-file path lets these reach dieFormatted and
      // fails properly, so one command reported opposite outcomes for the same
      // failure depending on a flag.
      //
      // AUDIT 2026-08-01: ApiUpgradeRequiredError added to the same list.
      //
      // Not for the fabricated-clean-run reason above — that one is already
      // closed twice over. The `result.scored === 0` guard below exits 1, and
      // formatLineDiffSummary prints "Mean delta: not measured" rather than a
      // mean over nothing (pinned by test/diff-summary.test.mjs). A 426 would
      // have failed loudly either way.
      //
      // It belongs here for the two reasons that are still open. The engine's
      // forced-upgrade gate rejects every pair identically, so without the
      // rethrow the loop keeps going: --max-lines is clamped to 200 and each
      // pair issues two compute calls, so up to 400 requests are sent for a
      // verdict fixed before the first one — against a rate limiter that, on
      // the engine side, runs before key extraction. And the message that
      // names the actual fix (the upgrade command) scrolls past once per line
      // in stderr, while the run ends on "No line pair could be scored", which
      // says nothing about upgrading.
      if (
        err instanceof ApiAuthError ||
        err instanceof ApiCloudflareError ||
        err instanceof ApiQuotaExhaustedError ||
        err instanceof ApiUpgradeRequiredError
      ) {
        throw err;
      }
      failed++;
      process.stderr.write(chalk.red(`  L${i + 1}: failed (${(err as Error).message})\n`));
      continue;
    }
    totalTokens += sBefore.tokens + sAfter.tokens;
    const delta = Math.round((sAfter.ain - sBefore.ain) * 100) / 100;
    deltas.push(delta);
    const { label, color } = labelDelta(delta);
    if (label !== "unchanged") changed++;
    const preview = aft.length > 60 ? aft.slice(0, 60) + "..." : aft;
    process.stdout.write(
      `  L${String(i + 1).padStart(2, " ")}  ${color(label.padEnd(9))}  ${color(fmtAinDelta(delta))} AIN  ${chalk.gray(preview)}\n`,
    );
  }
  const meanDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  return { totalTokens, changedLines: changed, meanDelta, scored: deltas.length, failed };
}

export async function cmdDiff(
  before: string,
  after: string,
  opts: DiffOptions = {},
): Promise<void> {
  const tBefore = readTextFileOrDie(before);
  const tAfter = readTextFileOrDie(after);

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  // ── Line-by-line mode ──────────────────────────────────────────────────
  if (opts.lines) {
    const maxLines = opts.maxLines
      ? Math.max(2, Math.min(200, Number.parseInt(opts.maxLines, 10) || DEFAULT_MAX_LINES))
      : DEFAULT_MAX_LINES;
    const result = await runLineDiff(client, tBefore, tAfter, maxLines);
    const { label } = labelDelta(result.meanDelta);
    process.stdout.write(formatLineDiffSummary(result));

    // AUDIT 2026-07-30: with nothing scored there is no verdict to give.
    // Previously the mean collapsed to 0, labelDelta(0) returned "unchanged",
    // and the command exited 0 — so a total engine outage printed the same
    // summary as a clean run, and the fabricated result was written to
    // history as though it were a measurement.
    if (result.scored === 0) {
      process.stderr.write(
        chalk.red("\nNo line pair could be scored — the mean above is not a measurement.\n"),
      );
      process.exitCode = 1;
      printDisclaimer();
      return;
    }

    appendHistory({
      command: "diff-lines",
      input: `${before}::${after}`,
      score: Math.round(result.meanDelta * 100) / 100,
      status: label,
      tokens: result.totalTokens,
    });
    printDisclaimer();
    return;
  }

  // ── Whole-file mode (default, legacy) ──────────────────────────────────
  const [sBefore, sAfter] = await Promise.all([
    score(client, tBefore),
    score(client, tAfter),
  ]);
  const delta = Math.round((sAfter.ain - sBefore.ain) * 100) / 100;
  const { label, color } = labelDelta(delta);

  process.stdout.write(`${chalk.bold("before")} (${before}): AIN ${fmtAin(sBefore.ain)}/100  ${chalk.gray(sBefore.status)}\n`);
  process.stdout.write(`${chalk.bold("after ")} (${after}): AIN ${fmtAin(sAfter.ain)}/100  ${chalk.gray(sAfter.status)}\n`);
  process.stdout.write(
    `Result: ${color.bold(label)}  ${color(fmtAinDelta(delta) + " AIN")}\n`,
  );
  process.stdout.write(
    chalk.gray(`Tip: add --lines to score paragraph-by-paragraph and locate the drift.\n`),
  );

  appendHistory({
    command: "diff",
    input: `${before}::${after}`,
    score: delta,
    status: label,
    tokens: sBefore.tokens + sAfter.tokens,
  });
  printDisclaimer();
}
