import chalk, { type ChalkInstance } from "chalk";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { readTextFileOrDie } from "../file-utils.js";
import { printDisclaimer } from "../disclaimer.js";

export interface DiffOptions {
  /** Score line-by-line instead of whole-file (bug #11 alignment with /cli docs). */
  lines?: boolean;
  /** Cap number of lines scored when --lines is on (defence against huge files). */
  maxLines?: string;
}

async function score(client: ApiClient, text: string) {
  const { bias, d } = analyzeSentiment(text);
  const res = await client.compute({ d, bias, samples: 1000 });
  return { ain: Math.round(res.ain * 100), status: res.ain_status, tokens: res.tokens_used };
}

function labelDelta(delta: number): { label: string; color: ChalkInstance } {
  if (delta > 2) return { label: "improved", color: chalk.green };
  if (delta < -2) return { label: "worsened", color: chalk.red };
  return { label: "unchanged", color: chalk.gray };
}

const DEFAULT_MAX_LINES = 40;

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
): Promise<{ totalTokens: number; changedLines: number; meanDelta: number }> {
  const linesBefore = textBefore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const linesAfter = textAfter.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const pairCount = Math.min(linesBefore.length, linesAfter.length, maxLines);

  process.stdout.write(
    chalk.bold(`Line-level diff: ${pairCount} line pairs (capped at ${maxLines})\n\n`),
  );

  let totalTokens = 0;
  let changed = 0;
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
      process.stderr.write(chalk.red(`  L${i + 1}: failed (${(err as Error).message})\n`));
      continue;
    }
    totalTokens += sBefore.tokens + sAfter.tokens;
    const delta = sAfter.ain - sBefore.ain;
    deltas.push(delta);
    const { label, color } = labelDelta(delta);
    if (label !== "unchanged") changed++;
    const preview = aft.length > 60 ? aft.slice(0, 60) + "..." : aft;
    process.stdout.write(
      `  L${String(i + 1).padStart(2, " ")}  ${color(label.padEnd(9))}  ${color((delta >= 0 ? "+" : "") + delta)} AIN  ${chalk.gray(preview)}\n`,
    );
  }
  const meanDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  return { totalTokens, changedLines: changed, meanDelta };
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
    const { label, color } = labelDelta(result.meanDelta);
    process.stdout.write(
      `\n${chalk.bold("Summary")}\n` +
        `  Changed lines: ${result.changedLines}\n` +
        `  Mean delta:    ${color((result.meanDelta >= 0 ? "+" : "") + result.meanDelta.toFixed(1))} AIN (${color(label)})\n` +
        `  Tokens:        ${result.totalTokens}\n`,
    );
    appendHistory({
      command: "diff-lines",
      input: `${before}::${after}`,
      score: Math.round(result.meanDelta),
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
  const delta = sAfter.ain - sBefore.ain;
  const { label, color } = labelDelta(delta);

  process.stdout.write(`${chalk.bold("before")} (${before}): AIN ${sBefore.ain}/100  ${chalk.gray(sBefore.status)}\n`);
  process.stdout.write(`${chalk.bold("after ")} (${after}): AIN ${sAfter.ain}/100  ${chalk.gray(sAfter.status)}\n`);
  process.stdout.write(
    `Result: ${color.bold(label)}  ${color((delta >= 0 ? "+" : "") + delta + " AIN")}\n`,
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
