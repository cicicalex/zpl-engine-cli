import chalk, { type ChalkInstance } from "chalk";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { readTextFileOrDie } from "../file-utils.js";

async function score(client: ApiClient, text: string) {
  const { bias, d } = analyzeSentiment(text);
  const res = await client.compute({ d, bias, samples: 1000 });
  return { ain: Math.round(res.ain * 100), status: res.ain_status, tokens: res.tokens_used };
}

export async function cmdDiff(before: string, after: string): Promise<void> {
  const tBefore = readTextFileOrDie(before);
  const tAfter = readTextFileOrDie(after);

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  const [sBefore, sAfter] = await Promise.all([
    score(client, tBefore),
    score(client, tAfter),
  ]);
  const delta = sAfter.ain - sBefore.ain;

  // Threshold: anything <= 2 AIN points is noise; we treat as unchanged.
  let label: string;
  let color: ChalkInstance;
  if (delta > 2) {
    label = "improved";
    color = chalk.green;
  } else if (delta < -2) {
    label = "worsened";
    color = chalk.red;
  } else {
    label = "unchanged";
    color = chalk.gray;
  }

  process.stdout.write(`${chalk.bold("before")} (${before}): AIN ${sBefore.ain}/100  ${chalk.gray(sBefore.status)}\n`);
  process.stdout.write(`${chalk.bold("after ")} (${after}): AIN ${sAfter.ain}/100  ${chalk.gray(sAfter.status)}\n`);
  process.stdout.write(
    `Result: ${color.bold(label)}  ${color((delta >= 0 ? "+" : "") + delta + " AIN")}\n`,
  );

  appendHistory({
    command: "diff",
    input: `${before}::${after}`,
    score: delta,
    status: label,
    tokens: sBefore.tokens + sAfter.tokens,
  });
}
