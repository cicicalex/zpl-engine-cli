import chalk, { type ChalkInstance } from "chalk";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { readTextFileOrDie } from "../file-utils.js";
import { printDisclaimer } from "../disclaimer.js";
import { ainPercent, fmtAin } from "../ain-scale.js";

export interface CheckOptions {
  /** Output format. */
  output?: "text" | "json";
  /** Cap on bytes when reading stdin (defence against unbounded streams). */
  maxBytes?: string;
}

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

function statusColor(ain: number): ChalkInstance {
  if (ain >= 60) return chalk.green;
  if (ain >= 40) return chalk.yellow;
  return chalk.red;
}

/** Default cap: 1 MB. Same as `pipe`. */
const DEFAULT_MAX_BYTES = 1_000_000;

async function readStdin(maxBytes: number): Promise<string> {
  if (process.stdin.isTTY) {
    // Caller forgot to pass a file AND there's no piped input — fatal.
    process.stderr.write(
      chalk.red("zpl check: no file argument and no stdin.\n") +
        chalk.gray(
          `Usage:\n` +
            `  zpl check <file>             score the contents of <file>\n` +
            `  echo "text" | zpl check      score whatever is piped in\n`,
        ),
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
          `zpl check: input exceeds ${(maxBytes / 1_000_000).toFixed(1)} MB limit.\n`,
        ),
      );
      process.exit(2);
    }
    chunks.push(chunk as string);
  }
  return chunks.join("");
}

export async function runCheck(
  text: string,
  label: string,
  output: "text" | "json" = "text",
): Promise<CheckResult> {
  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  const { bias, d, positive, negative, neutral, sentences } = analyzeSentiment(text);
  const result = await client.compute({ d, bias, samples: 1000 });
  // Percentage scale, decimals preserved — see src/ain-scale.ts.
  const ain = ainPercent(result.ain);
  const verdict = verdictFor(ain);

  appendHistory({
    command: "check",
    input: text,
    score: ain,
    status: result.ain_status,
    tokens: result.tokens_used,
  });

  if (output === "json") {
    // Stable shape — keys match the docs example `jq .ain`.
    process.stdout.write(
      JSON.stringify(
        {
          ain,
          // `ain_status` is the engine's balance-quality enum. `status` is
          // kept as a backwards-compatible alias for pre-1.2.2 consumers —
          // it carries the SAME value, not the engine's stability-regime
          // field (which this command does not surface).
          ain_status: result.ain_status,
          status: result.ain_status,
          verdict,
          input_chars: text.length,
          sentiment: { positive, negative, neutral, sentences, bias },
          tokens_used: result.tokens_used,
          source: label,
        },
        null,
        2,
      ) + "\n",
    );
    return { ain, status: result.ain_status, verdict, tokens: result.tokens_used };
  }

  const color = statusColor(ain);
  process.stdout.write(`${chalk.bold(label)}  ${chalk.gray(`(${text.length} chars)`)}\n`);
  process.stdout.write(`  AIN      ${color.bold(fmtAin(ain) + "/100")}  ${color(result.ain_status)}\n`);
  process.stdout.write(`  Verdict  ${color(verdict)}\n`);
  process.stdout.write(
    `  Signal   ${chalk.gray(`pos=${positive} neg=${negative} neutral=${neutral} sentences=${sentences}`)}\n`,
  );
  process.stdout.write(`  Bias     ${chalk.gray(bias.toFixed(2))}\n`);
  process.stdout.write(`  Tokens   ${chalk.gray(String(result.tokens_used))}\n`);
  printDisclaimer();

  return { ain, status: result.ain_status, verdict, tokens: result.tokens_used };
}

/**
 * `zpl check [file]` — score text from a file argument OR from stdin.
 *
 * v1.1.6 fix (bugs #7 + #9): the website at zeropointlogic.io/cli has
 * advertised stdin support since launch (`echo "..." | zpl check | jq .ain`)
 * but the implementation required a file argument and emitted text only.
 * This rewrite makes the file argument optional, falls back to stdin when
 * absent, and adds `--output json` so the documented `jq` pipeline works.
 */
export async function cmdCheck(
  filePath: string | undefined,
  opts: CheckOptions = {},
): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(
      chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`),
    );
    process.exit(2);
  }

  const maxBytes = opts.maxBytes
    ? Math.max(1024, Math.min(10_000_000, Number.parseInt(opts.maxBytes, 10) || DEFAULT_MAX_BYTES))
    : DEFAULT_MAX_BYTES;

  let text: string;
  let label: string;
  if (filePath) {
    text = readTextFileOrDie(filePath);
    label = filePath;
  } else {
    text = await readStdin(maxBytes);
    label = "<stdin>";
  }

  if (text.trim().length < 10) {
    process.stderr.write(
      chalk.red(
        `zpl check: input too short to analyze (need at least 10 non-whitespace chars).\n`,
      ),
    );
    process.exit(2);
  }

  await runCheck(text, label, output as "text" | "json");
}
