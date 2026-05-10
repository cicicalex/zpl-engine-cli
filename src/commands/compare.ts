import chalk from "chalk";
import Table from "cli-table3";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { readTextFileOrDie } from "../file-utils.js";

async function score(client: ApiClient, text: string) {
  const { bias, d } = analyzeSentiment(text);
  const res = await client.compute({ d, bias, samples: 1000 });
  return {
    ain: Math.round(res.ain * 100),
    status: res.ain_status,
    tokens: res.tokens_used,
  };
}

export async function cmdCompare(a: string, b: string): Promise<void> {
  // Read both files first so size/permission errors fail fast before we hit
  // the engine. readTextFileOrDie handles every failure mode + sets exit 1.
  const textA = readTextFileOrDie(a);
  const textB = readTextFileOrDie(b);

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  const [sA, sB] = await Promise.all([score(client, textA), score(client, textB)]);
  const delta = sB.ain - sA.ain;
  const deltaColor = delta > 0 ? chalk.green : delta < 0 ? chalk.red : chalk.gray;

  const table = new Table({
    head: [chalk.bold("File"), chalk.bold("AIN"), chalk.bold("Status"), chalk.bold("Tokens")],
    style: { head: [] },
  });
  table.push(
    [a, String(sA.ain), sA.status, String(sA.tokens)],
    [b, String(sB.ain), sB.status, String(sB.tokens)],
  );
  process.stdout.write(table.toString() + "\n");
  process.stdout.write(
    `Delta (B - A): ${deltaColor.bold((delta >= 0 ? "+" : "") + delta)} AIN\n`,
  );

  appendHistory({
    command: "compare",
    input: `${a}::${b}`,
    score: delta,
    status: delta > 0 ? "B_HIGHER" : delta < 0 ? "A_HIGHER" : "EQUAL",
    tokens: sA.tokens + sB.tokens,
  });
}
