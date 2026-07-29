/**
 * `zpl pipe` — Unix-style: read text from stdin, score it with the engine,
 *              emit JSON to stdout. Optional `--threshold N` exits 1 when the
 *              AIN score falls below the threshold (CI gate behaviour).
 *
 * v1.0.0 motivation:
 *   The CLI's most important job — and the thing that DIFFERENTIATES it from
 *   the MCP — is letting an external process score AI output without the AI
 *   knowing. The MCP exposes scores to the AI itself, which can then modify
 *   its own output to look better; the CLI is run after the fact (or in
 *   parallel) so the agent never sees the score.
 *
 * Typical flows:
 *
 *   # GitHub Action / pre-commit hook: block sycophantic AI commit messages
 *   git log -1 --pretty=%B | zpl pipe --threshold 60
 *
 *   # Pipe Claude's output, fail the script if it's too biased
 *   claude "explain X" | zpl pipe --threshold 70
 *
 *   # Just get raw JSON for downstream tooling
 *   cat ai-response.txt | zpl pipe --output json
 *
 * Exit codes:
 *   0  — success, score above threshold (or no threshold set)
 *   1  — score below threshold
 *   2  — usage error (no stdin, empty input, threshold out of range)
 *   3  — engine / network error (auth, Cloudflare, etc.)
 */
import chalk from "chalk";
import { requireConfig } from "../config.js";
import {
  ApiClient,
  ApiAuthError,
  ApiCloudflareError,
  ApiNetworkError,
  ApiQuotaError,
} from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { printDisclaimer } from "../disclaimer.js";
import { ainPercent, fmtAin } from "../ain-scale.js";

export interface PipeOptions {
  /** Exit 1 if AIN < threshold. 1-100. */
  threshold?: string;
  /** Output format: text (default, single line) or json. */
  output?: "text" | "json";
  /** Maximum bytes to read from stdin (defence against unbounded streams). */
  maxBytes?: string;
}

/** Cap stdin reads at 1 MB by default — same limit as readTextFileOrDie. */
const DEFAULT_MAX_BYTES = 1_000_000;

async function readStdin(maxBytes: number): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(
      chalk.red("zpl pipe: no data on stdin.\n") +
        chalk.gray(`Usage: echo "text" | zpl pipe [--threshold N] [--output json]\n`),
    );
    process.exit(2);
  }

  process.stdin.setEncoding("utf-8");
  const chunks: string[] = [];
  let total = 0;

  for await (const chunk of process.stdin) {
    total += Buffer.byteLength(chunk as string, "utf-8");
    if (total > maxBytes) {
      process.stderr.write(
        chalk.red(
          `zpl pipe: input exceeds ${(maxBytes / 1_000_000).toFixed(1)} MB limit. ` +
            `Slice the stream first.\n`,
        ),
      );
      process.exit(2);
    }
    chunks.push(chunk as string);
  }

  return chunks.join("");
}

export async function cmdPipe(opts: PipeOptions = {}): Promise<void> {
  // ── Parse + validate options ─────────────────────────────────────────
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  let threshold: number | null = null;
  if (opts.threshold !== undefined) {
    const t = Number.parseInt(opts.threshold, 10);
    if (Number.isNaN(t) || t < 1 || t > 100) {
      process.stderr.write(
        chalk.red(`Invalid --threshold: "${opts.threshold}". Must be an integer 1..100.\n`),
      );
      process.exit(2);
    }
    threshold = t;
  }

  const maxBytes = opts.maxBytes
    ? Math.max(1024, Math.min(10_000_000, Number.parseInt(opts.maxBytes, 10) || DEFAULT_MAX_BYTES))
    : DEFAULT_MAX_BYTES;

  // ── Read stdin ───────────────────────────────────────────────────────
  const text = await readStdin(maxBytes);
  if (text.trim().length < 10) {
    process.stderr.write(
      chalk.red(`zpl pipe: input too short to analyze (need at least 10 non-whitespace chars).\n`),
    );
    process.exit(2);
  }

  // ── Score ────────────────────────────────────────────────────────────
  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });
  const { bias, d, positive, negative, neutral, sentences } = analyzeSentiment(text);

  let res;
  try {
    res = await client.compute({ d, bias, samples: 1000 });
  } catch (err) {
    // Engine errors get exit 3 so a CI script can distinguish "score below
    // threshold" (exit 1) from "couldn't even check" (exit 3).
    if (
      err instanceof ApiAuthError ||
      err instanceof ApiCloudflareError ||
      err instanceof ApiNetworkError ||
      err instanceof ApiQuotaError
    ) {
      process.stderr.write(chalk.red(err.message) + "\n");
      process.exit(3);
    }
    process.stderr.write(chalk.red(`zpl pipe: engine call failed: ${(err as Error).message}\n`));
    process.exit(3);
  }

  // Percentage scale, decimals preserved — see src/ain-scale.ts.
  const ain = ainPercent(res.ain);

  // ── Persist (history) ────────────────────────────────────────────────
  appendHistory({
    command: "pipe",
    input: text,
    score: ain,
    status: res.ain_status,
    tokens: res.tokens_used,
  });

  // ── Render ───────────────────────────────────────────────────────────
  const passed = threshold === null || ain >= threshold;

  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          ain,
          // `ain_status` is the engine's balance-quality enum. `status` is
          // kept as a backwards-compatible alias for pre-1.2.2 consumers —
          // same value, NOT the engine's stability-regime field.
          ain_status: res.ain_status,
          status: res.ain_status,
          threshold,
          passed,
          tokens_used: res.tokens_used,
          input_chars: text.length,
          sentiment: { positive, negative, neutral, sentences, bias },
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    // One-line text mode: easy to grep/awk in shell scripts.
    const verdict = passed ? "PASS" : "FAIL";
    const color = passed ? chalk.green : chalk.red;
    const line = threshold !== null
      ? `AIN=${fmtAin(ain)}/100 ain_status=${res.ain_status} threshold=${threshold} verdict=${verdict} tokens=${res.tokens_used}`
      : `AIN=${fmtAin(ain)}/100 ain_status=${res.ain_status} tokens=${res.tokens_used}`;
    process.stdout.write(color(line) + "\n");
    // Disclaimer only in text mode — JSON consumers parse the output.
    printDisclaimer();
  }

  // ── Exit code ────────────────────────────────────────────────────────
  // process.exitCode (not process.exit) — the engine call uses fetch +
  // AbortSignal.timeout. On Windows, calling exit() while a timer is still
  // in-flight tripped a libuv assertion in src/win/async.c (same fix we
  // applied to update-check + diagnose). exitCode lets the event loop
  // drain naturally before exit.
  if (!passed) process.exitCode = 1;
}
