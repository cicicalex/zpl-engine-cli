import chalk, { type ChalkInstance } from "chalk";
import clipboard from "clipboardy";
import { requireConfig } from "../config.js";
import { ApiClient, ApiAuthError, ApiCloudflareError } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";

const POLL_MS = 2000;
/** Cap clipboard reads at 1 MB so a giant paste doesn't OOM the process. */
const CLIPBOARD_MAX = 1_000_000;

function statusColor(ain: number): ChalkInstance {
  if (ain >= 60) return chalk.green;
  if (ain >= 40) return chalk.yellow;
  return chalk.red;
}

/**
 * Watch the system clipboard. On each new paste, score it with the engine.
 *
 * v1.0.0 fixes:
 *   - Auth failures and Cloudflare blocks are NOW terminal: pre-v1 the catch
 *     block printed the error and kept polling, producing an endless red
 *     scroll while the user thought "watch" was still working. Now we exit
 *     non-zero so the user sees the failure and can run `zpl repair`.
 *   - Clipboard reads capped at 1 MB so a 50 MB paste doesn't crash Node.
 */
export async function cmdWatch(): Promise<void> {
  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  process.stdout.write(
    chalk.bold("Watching clipboard. ") +
      chalk.gray("Copy any text to score it. Ctrl+C to stop.\n"),
  );

  let last = "";
  try {
    // Prime the baseline with whatever is on the clipboard at start so we
    // don't accidentally re-score whatever the user had queued up.
    last = (await clipboard.read()).slice(0, CLIPBOARD_MAX);
  } catch {
    process.stderr.write(
      chalk.red(
        "Clipboard access unavailable. On Linux, install xclip or wl-clipboard.\n",
      ),
    );
    process.exit(1);
  }

  // Main loop — simple poll-and-sleep so Ctrl+C cleans up immediately
  // (no dangling timers / fetch handles).
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let current = "";
    try {
      current = (await clipboard.read()).slice(0, CLIPBOARD_MAX);
    } catch {
      // Clipboard read can fail transiently (e.g. focus stealing on Windows).
      // Skip this tick and try again next poll.
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
      // Auth and Cloudflare are TERMINAL — they will not resolve by polling
      // again 2 seconds later, and silently swallowing them lets the user
      // believe `watch` is healthy when it has been broken for an hour.
      // Exit so the failure is visible and the user can run `zpl repair`.
      if (err instanceof ApiAuthError) {
        process.stderr.write(
          chalk.red(`\nAuthentication failed: ${err.message}\n`) +
            chalk.gray(`Run \`zpl repair --yes\` to re-login, then \`zpl watch\`.\n`),
        );
        process.exit(1);
      }
      if (err instanceof ApiCloudflareError) {
        process.stderr.write(
          chalk.yellow(`\n${err.message}\n`) +
            chalk.gray(
              `Cloudflare blocked the request. Wait a moment and re-run \`zpl watch\`,\n` +
                `or run \`zpl diagnose\` for details.\n`,
            ),
        );
        process.exit(1);
      }
      // Anything else (transient 5xx, network blip): print and continue —
      // these often resolve on the next poll.
      process.stderr.write(chalk.red(`watch: ${(err as Error).message}\n`));
    }
  }
}
