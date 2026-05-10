import chalk from "chalk";
import { requireConfig } from "../config.js";
import { ApiClient, ApiAuthError, ApiCloudflareError } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";

export interface ConsistencyOptions {
  /** Number of passes (string from commander, parsed here). */
  n?: string;
}

/**
 * Probe engine determinism on a given input.
 *
 * v1.0.0 honesty fix: pre-v1 this command made N identical engine calls and
 * pretended to measure "consistency" of the AI agent that produced the text.
 * The engine is a deterministic math function over (d, bias, samples) — same
 * input ALWAYS returns the same output. So the old version always reported
 * stdDev = 0 and labelled everything CONSISTENT regardless of the input. That
 * was a lie of omission.
 *
 * What the command actually measures now (and what it advertises):
 *   - **Engine determinism**: with the same (d, bias) inputs, the engine MUST
 *     return the same `ain`, `status`, and `tokens_used`. Any drift indicates
 *     either an engine bug or load-balancer routing inconsistency.
 *   - **Token cost variance**: even when ain stays the same, `tokens_used`
 *     may differ if the engine internals change (e.g. caching warm vs cold).
 *
 * This is the only honest single-input probe a CLI can run — to test agent
 * consistency you'd need to call the agent N times yourself, score each
 * output, and compare. We may add `zpl probe-agent <prompt>` for that in a
 * future release.
 */
export async function cmdConsistency(
  question: string,
  opts: ConsistencyOptions = {},
): Promise<void> {
  // ── Input validation ─────────────────────────────────────────────────
  // Pre-v1 used `parseInt(opts.n ?? "5", 10)` raw, which returned NaN on
  // bad input ("--n abc") and was then silently clamped to 2 by Math.max,
  // hiding the user error. v1.0: surface invalid input explicitly.
  const rawN = opts.n ?? "5";
  const parsedN = Number.parseInt(rawN, 10);
  if (Number.isNaN(parsedN) || parsedN < 2 || parsedN > 20) {
    process.stderr.write(
      chalk.red(`Invalid --n value: "${rawN}". Must be an integer between 2 and 20.\n`),
    );
    process.exit(2); // 2 = bad args (consistent across CLI)
  }
  const n = parsedN;

  if (question.trim().length < 10) {
    process.stderr.write(
      chalk.red(`Question is too short to analyze (minimum 10 characters).\n`),
    );
    process.exit(2);
  }

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });
  const { bias, d } = analyzeSentiment(question);

  process.stdout.write(
    chalk.bold(`Probing engine determinism over ${n} identical (d=${d}, bias=${bias.toFixed(2)}) calls…\n`) +
      chalk.gray(
        `Note: this measures engine reproducibility, NOT agent consistency.\n` +
          `For agent consistency, call the agent N times yourself and use \`zpl pipe\` on each output.\n\n`,
      ),
  );

  const scores: number[] = [];
  const tokens: number[] = [];

  for (let i = 0; i < n; i++) {
    try {
      const res = await client.compute({ d, bias, samples: 1000 });
      const ain = Math.round(res.ain * 100);
      scores.push(ain);
      tokens.push(res.tokens_used);
      process.stdout.write(
        `  Pass ${i + 1}/${n}: AIN ${chalk.cyan(String(ain))}  tokens=${chalk.gray(String(res.tokens_used))}\n`,
      );
    } catch (err) {
      // Auth and Cloudflare are terminal — no point continuing.
      if (err instanceof ApiAuthError || err instanceof ApiCloudflareError) {
        throw err;
      }
      process.stderr.write(chalk.red(`  Pass ${i + 1}/${n} failed: ${(err as Error).message}\n`));
    }
  }

  if (scores.length < 2) {
    process.stderr.write(chalk.red("\nFewer than 2 passes succeeded — cannot compute variance.\n"));
    process.exit(1);
  }

  const meanAin = scores.reduce((a, b) => a + b, 0) / scores.length;
  const ainVariance =
    scores.reduce((s, x) => s + (x - meanAin) ** 2, 0) / scores.length;
  const ainStdDev = Math.sqrt(ainVariance);

  const meanTokens = tokens.reduce((a, b) => a + b, 0) / tokens.length;
  const tokensVariance =
    tokens.reduce((s, x) => s + (x - meanTokens) ** 2, 0) / tokens.length;
  const tokensStdDev = Math.sqrt(tokensVariance);

  // For a deterministic engine we EXPECT stdDev = 0. Any drift > 0 is a
  // signal that something on the engine side isn't pinned. Surface it.
  const ainDeterministic = ainStdDev === 0;
  const ainLabel = ainDeterministic
    ? chalk.green("✓ DETERMINISTIC")
    : chalk.yellow(`⚠ DRIFT (stdDev=${ainStdDev.toFixed(2)})`);

  const totalTokens = tokens.reduce((a, b) => a + b, 0);

  process.stdout.write(
    `\n${chalk.bold("AIN")}     mean=${meanAin.toFixed(2)}  stdDev=${ainStdDev.toFixed(2)}  ${ainLabel}\n` +
      `${chalk.bold("Tokens")}  mean=${meanTokens.toFixed(1)}  stdDev=${tokensStdDev.toFixed(2)}  total=${chalk.gray(String(totalTokens))}\n`,
  );

  if (!ainDeterministic) {
    process.stdout.write(
      chalk.yellow(
        `\nDrift detected. Possible causes: engine load-balancer routing to different\n` +
          `versions, A/B test in production, or a bug. Report at zeropointlogic.io/support.\n`,
      ),
    );
  }

  appendHistory({
    command: "consistency",
    input: question,
    score: Math.round(meanAin),
    status: ainDeterministic ? "DETERMINISTIC" : "DRIFT",
    tokens: totalTokens,
  });
}
