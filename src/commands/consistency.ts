import chalk from "chalk";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";

export async function cmdConsistency(question: string, opts: { n?: string }): Promise<void> {
  const cfg = requireConfig();
  const n = Math.max(2, Math.min(20, parseInt(opts.n ?? "5", 10)));

  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });
  const { bias, d } = analyzeSentiment(question);

  process.stdout.write(chalk.bold(`Running ${n} consistency passes...\n`));

  const scores: number[] = [];
  let totalTokens = 0;

  for (let i = 0; i < n; i++) {
    try {
      const res = await client.compute({ d, bias, samples: 1000 });
      const ain = Math.round(res.ain * 100);
      scores.push(ain);
      totalTokens += res.tokens_used;
      process.stdout.write(`  Pass ${i + 1}: AIN ${chalk.cyan(String(ain))}\n`);
    } catch (err) {
      process.stderr.write(chalk.red(`  Pass ${i + 1} failed: ${(err as Error).message}\n`));
    }
  }

  if (scores.length === 0) {
    process.stderr.write(chalk.red("All passes failed.\n"));
    process.exit(1);
  }

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length;
  const stdDev = Math.sqrt(variance);

  // The threshold here is heuristic. StdDev < 10 (on a 0–100 scale) means
  // the engine is producing repeatable verdicts for this input — which is
  // the whole point of the consistency probe.
  const consistent = stdDev < 10;
  const label = consistent ? chalk.green("CONSISTENT") : chalk.yellow("INCONSISTENT");

  process.stdout.write(
    `\n${chalk.bold("Mean")} ${mean.toFixed(2)}  ${chalk.bold("StdDev")} ${stdDev.toFixed(2)}  ${label}\n`,
  );
  process.stdout.write(chalk.gray(`Tokens used: ${totalTokens}\n`));

  appendHistory({
    command: "consistency",
    input: question,
    score: Math.round(mean),
    status: consistent ? "CONSISTENT" : "INCONSISTENT",
    tokens: totalTokens,
  });
}
