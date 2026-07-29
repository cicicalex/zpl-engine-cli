import chalk, { type ChalkInstance } from "chalk";
import clipboard from "clipboardy";
import { watch as fsWatch, statSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { requireConfig } from "../config.js";
import { ApiClient, ApiAuthError, ApiCloudflareError } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { ainPercent, fmtAin } from "../ain-scale.js";

export interface WatchOptions {
  /** Force clipboard mode (default if no <file> given). */
  clipboard?: boolean;
}

const POLL_MS = 2000;
/** Cap clipboard / file reads at 1 MB. */
const READ_MAX = 1_000_000;
/** Debounce file rescores so an editor saving 5 times in 200ms = 1 score. */
const FILE_DEBOUNCE_MS = 600;

function statusColor(ain: number): ChalkInstance {
  if (ain >= 60) return chalk.green;
  if (ain >= 40) return chalk.yellow;
  return chalk.red;
}

async function scoreAndPrint(
  client: ApiClient,
  text: string,
  source: string,
  command: string,
): Promise<void> {
  if (text.trim().length < 10) return;
  try {
    const { bias, d } = analyzeSentiment(text);
    const res = await client.compute({ d, bias, samples: 1000 });
    // Percentage scale, decimals preserved — see src/ain-scale.ts.
    const ain = ainPercent(res.ain);
    const color = statusColor(ain);
    const ts = new Date().toISOString().slice(11, 19);
    const preview = text.replace(/\s+/g, " ").slice(0, 60);
    process.stdout.write(
      `[${chalk.gray(ts)}] ${chalk.gray(source.padEnd(20))} ${color.bold("AIN " + fmtAin(ain))} ${color(res.ain_status)} ${chalk.gray("— " + preview + (text.length > 60 ? "…" : ""))}\n`,
    );
    appendHistory({
      command,
      input: text,
      score: ain,
      status: res.ain_status,
      tokens: res.tokens_used,
    });
  } catch (err) {
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
          chalk.gray(`Cloudflare blocked the request. Wait a moment and re-run.\n`),
      );
      process.exit(1);
    }
    process.stderr.write(chalk.red(`watch: ${(err as Error).message}\n`));
  }
}

/**
 * `zpl watch` — score new content as it appears.
 *
 * v1.1.6 (bug #10 fix): the /cli docs page says "Continuous scoring on file
 * changes" but the implementation only watched the system clipboard. v1.1.6
 * supports BOTH:
 *
 *   zpl watch                  → clipboard mode (legacy)
 *   zpl watch file.md          → re-score whenever file.md changes on disk
 *   zpl watch --clipboard      → explicit clipboard mode
 *
 * File mode uses fs.watch (native) with a 600ms debounce so a save-storm
 * from an editor (Code, Vim swap files) doesn't burn tokens. Each save
 * costs ~1 token if the content actually changed; identical re-saves are
 * skipped.
 *
 * Pre-existing behaviour preserved:
 *   - Auth/Cloudflare failures are TERMINAL (exit 1, prompts user to run
 *     `zpl repair`). Polling errors silently is worse than crashing.
 *   - Clipboard and file reads capped at 1 MB.
 */
export async function cmdWatch(
  filePath: string | undefined,
  opts: WatchOptions = {},
): Promise<void> {
  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  const useClipboard = opts.clipboard || !filePath;

  if (!useClipboard) {
    // ── File-watch mode ─────────────────────────────────────────────────
    const abs = resolve(filePath!);
    if (!existsSync(abs)) {
      process.stderr.write(chalk.red(`zpl watch: file not found: ${abs}\n`));
      process.exit(2);
    }
    let lastContent = "";
    try {
      lastContent = readFileSync(abs, "utf-8").slice(0, READ_MAX);
    } catch (err) {
      process.stderr.write(chalk.red(`zpl watch: cannot read ${abs}: ${(err as Error).message}\n`));
      process.exit(2);
    }

    process.stdout.write(
      chalk.bold(`Watching file ${abs}. `) +
        chalk.gray("Edit + save to re-score. Ctrl+C to stop.\n"),
    );
    // Initial score
    await scoreAndPrint(client, lastContent, "initial", "watch-file");

    let pending: NodeJS.Timeout | null = null;
    const watcher = fsWatch(abs, { persistent: true }, () => {
      // Debounce — editors save in bursts (swap + atomic-rename).
      if (pending) clearTimeout(pending);
      pending = setTimeout(async () => {
        pending = null;
        if (!existsSync(abs)) return; // editor may have replaced the inode
        let current = "";
        try {
          if (statSync(abs).size > READ_MAX) {
            process.stderr.write(chalk.red(`watch: ${abs} exceeds 1 MB cap.\n`));
            return;
          }
          current = readFileSync(abs, "utf-8");
        } catch {
          return; // transient — try again on next event
        }
        if (current === lastContent) return;
        lastContent = current;
        await scoreAndPrint(client, current, abs.split(/[\\/]/).pop()!, "watch-file");
      }, FILE_DEBOUNCE_MS);
    });

    // Keep node alive until SIGINT.
    process.on("SIGINT", () => {
      watcher.close();
      process.stdout.write(chalk.gray("\nStopped.\n"));
      process.exit(0);
    });
    return;
  }

  // ── Clipboard mode (legacy default) ───────────────────────────────────
  process.stdout.write(
    chalk.bold("Watching clipboard. ") +
      chalk.gray("Copy any text to score it. Ctrl+C to stop.\n"),
  );

  let last = "";
  try {
    last = (await clipboard.read()).slice(0, READ_MAX);
  } catch {
    process.stderr.write(
      chalk.red("Clipboard access unavailable. On Linux, install xclip or wl-clipboard.\n"),
    );
    process.exit(1);
  }

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let current = "";
    try {
      current = (await clipboard.read()).slice(0, READ_MAX);
    } catch {
      continue;
    }
    if (!current || current === last) continue;
    last = current;
    await scoreAndPrint(client, current, "clipboard", "watch");
  }
}
