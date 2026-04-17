import { readFileSync, existsSync } from "node:fs";
import chalk from "chalk";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";

export interface CheckResult {
  ain: number;
  status: string;
  verdict: string;
  tokens: number;
}

function verdictFor(ain: number): string {
  if (ain >= 80) return "highly balanced";
  if (ain >= 60) return "moderately balanced";
  if (ain >= 40) return "noticeable bias";
  return "heavily biased";
}

function statusColor(ain: number): (s: string) => string {
  if (ain >= 60) return chalk.green;
  if (ain >= 40) return chalk.yellow;
  return chalk.red;
}

export async function runCheck(text: string, label: string): Promise<CheckResult> {
  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  const { bias, d, positive, negative, neutral, sentences } = analyzeSentiment(text);
  const result = await client.compute({ d, bias, samples: 1000 });
  const ain = Math.round(result.ain * 100);
  const verdict = verdictFor(ain);

  appendHistory({
    command: "check",
    input: text,
    score: ain,
    status: result.ain_status,
    tokens: result.tokens_used,
  });

  const color = statusColor(ain);
  process.stdout.write(`${chalk.bold(label)}  ${chalk.gray(`(${text.length} chars)`)}\n`);
  process.stdout.write(`  AIN      ${color.bold(String(ain) + "/100")}  ${color(result.ain_status)}\n`);
  process.stdout.write(`  Verdict  ${color(verdict)}\n`);
  process.stdout.write(
    `  Signal   ${chalk.gray(`pos=${positive} neg=${negative} neutral=${neutral} sentences=${sentences}`)}\n`,
  );
  process.stdout.write(`  Bias     ${chalk.gray(bias.toFixed(2))}\n`);
  process.stdout.write(`  Tokens   ${chalk.gray(String(result.tokens_used))}\n`);

  return { ain, status: result.ain_status, verdict, tokens: result.tokens_used };
}

export async function cmdCheck(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    process.stderr.write(chalk.red(`File not found: ${filePath}\n`));
    process.exit(1);
  }
  const text = readFileSync(filePath, "utf-8");
  if (text.trim().length < 10) {
    process.stderr.write(chalk.red(`File is too short to analyze (minimum 10 characters).\n`));
    process.exit(1);
  }
  await runCheck(text, filePath);
}
