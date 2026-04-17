import chalk, { type ChalkInstance } from "chalk";
import clipboard from "clipboardy";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";

const POLL_MS = 2000;

function statusColor(ain: number): ChalkInstance {
  if (ain >= 60) return chalk.green;
  if (ain >= 40) return chalk.yellow;
  return chalk.red;
}

export async function cmdWatch(): Promise<void> {
  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  process.stdout.write(chalk.bold("Watching clipboard. ") + chalk.gray("Copy any text to score it. Ctrl+C to stop.\n"));

  let last = "";
  try {
    // Prime the baseline with whatever is on the clipboard at start so
    // we don't accidentally re-score whatever the user had queued up.
    last = (await clipboard.read()).slice(0, 100_000);
  } catch {
    process.stderr.write(
      chalk.red(
        "Clipboard access unavailable. On Linux, install xclip or wl-clipboard.\n",
      ),
    );
    process.exit(1);
  }

  // Main loop — simple setInterval-style polling via await+sleep so we keep
  // a clean shutdown path on Ctrl+C (no dangling handles).
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let current = "";
    try {
      current = (await clipboard.read()).slice(0, 100_000);
    } catch {
      continue;
    }
    if (!current || current === last) continue;
    last = current;
    if (current.trim().length < 10) continue;

    try {
      const { bias, d } = analyzeSentiment(current);
      const res = await client.compute({ d, bias, samples: 1000 });
      const ain = Math.round(res.ain * 100);
      const color = statusColor(ain);
      const ts = new Date().toISOString().slice(11, 19);
      const preview = current.replace(/\s+/g, " ").slice(0, 60);
      process.stdout.write(
        `[${chalk.gray(ts)}] ${color.bold("AIN " + ain)} ${color(res.ain_status)} ${chalk.gray("— " + preview + (current.length > 60 ? "…" : ""))}\n`,
      );
      appendHistory({
        command: "watch",
        input: current,
        score: ain,
        status: res.ain_status,
        tokens: res.tokens_used,
      });
    } catch (err) {
      process.stderr.write(chalk.red(`watch: ${(err as Error).message}\n`));
    }
  }
}
