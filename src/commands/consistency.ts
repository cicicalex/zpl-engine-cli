import chalk from "chalk";
import { readFileSync, existsSync, statSync } from "node:fs";
import { requireConfig } from "../config.js";
import { ApiClient, ApiAuthError, ApiCloudflareError } from "../api-client.js";
import { analyzeSentiment } from "../sentiment.js";
import { appendHistory } from "../db.js";
import { printDisclaimer } from "../disclaimer.js";

export interface ConsistencyOptions {
  /** Number of passes (string from commander, parsed here). */
  n?: string;
}

/**
 * Probe engine determinism on a given input — or on a batch of inputs.
 *
 * v1.1.6 (bug #8): the website at zeropointlogic.io/cli advertises
 * `zpl consistency ./prompts.yml`, but the implementation pre-1.1.6 always
 * treated the argument as a single literal question string. A user who
 * created a YAML/JSON prompt file and ran the documented example got 5
 * engine calls scoring the filename "./prompts.yml" instead of the prompts
 * inside the file — no error, just wrong results. v1.1.6 detects when the
 * argument is a readable file, parses it (YAML list / JSON array / one
 * prompt per line for .txt) and runs the determinism probe across each
 * prompt.
 *
 * Why this matters:
 *   The engine is a deterministic math function over (d, bias, samples).
 *   Pre-v1 we made N identical calls and pretended this measured agent
 *   consistency — but identical inputs always give identical outputs from
 *   the engine. The honest read is "engine determinism": does the engine
 *   itself drift across N calls? File-mode adds a second, more useful
 *   read: does the engine give similar scores across DIFFERENT but
 *   semantically-related prompts?
 *
 * Limits:
 *   --n capped at 20 (Alex: "maxim 20 de intrebari raspunde"). With file
 *   mode you can effectively run 20 × num_prompts calls in one go.
 */

const MAX_N = 20;
const MIN_N = 2;
const MAX_PROMPTS_FROM_FILE = 100;

interface BatchPrompt {
  prompt: string;
  /** Optional label from the file (e.g. YAML key). */
  label?: string;
}

/**
 * Naive YAML/JSON list parser. We only support flat lists of strings.
 * Anything else gets rejected with a clear error rather than partially
 * consumed.
 */
function parsePromptFile(path: string): BatchPrompt[] {
  const raw = readFileSync(path, "utf-8");
  const ext = path.toLowerCase().split(".").pop() ?? "";

  // JSON: expect a top-level array of strings or {prompt, label?} objects.
  if (ext === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Could not parse ${path} as JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${path}: expected a top-level JSON array of prompts.`);
    }
    return parsed.map((item, i) => {
      if (typeof item === "string") return { prompt: item };
      if (item && typeof item === "object" && typeof (item as { prompt?: unknown }).prompt === "string") {
        return {
          prompt: (item as { prompt: string }).prompt,
          label: (item as { label?: string }).label,
        };
      }
      throw new Error(
        `${path}[${i}]: each item must be a string or {prompt: string, label?: string}.`,
      );
    });
  }

  // YAML: support `- "prompt"` and `- prompt: "..."` patterns. We don't
  // pull in a full YAML library to keep the bin slim; the format is small
  // enough to parse by hand.
  if (ext === "yml" || ext === "yaml") {
    const lines = raw.split(/\r?\n/);
    const prompts: BatchPrompt[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m1 = trimmed.match(/^-\s+["']?(.+?)["']?\s*$/);
      const m2 = trimmed.match(/^-\s+prompt:\s+["']?(.+?)["']?\s*$/);
      if (m2) prompts.push({ prompt: m2[1] });
      else if (m1) prompts.push({ prompt: m1[1] });
    }
    if (prompts.length === 0) {
      throw new Error(
        `${path}: no prompts found. Use a YAML list like:\n  - First prompt\n  - Second prompt`,
      );
    }
    return prompts;
  }

  // Plain text: one prompt per non-empty line.
  if (ext === "txt" || ext === "") {
    const prompts: BatchPrompt[] = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((p) => ({ prompt: p }));
    if (prompts.length === 0) {
      throw new Error(`${path}: file is empty (no non-comment lines).`);
    }
    return prompts;
  }

  throw new Error(
    `${path}: unsupported extension "${ext}". Use .json, .yml, .yaml, or .txt`,
  );
}

/**
 * Try to interpret `arg` as a path to a readable, small file.
 * Returns the file path if so, else null. We require the path to exist AND
 * have a recognised extension AND be < 1 MB so that a user who literally
 * asks "Is `/etc/hosts` accurate?" doesn't accidentally trigger file mode.
 */
function asReadableFile(arg: string): string | null {
  if (!/\.(ya?ml|json|txt)$/i.test(arg)) return null;
  if (!existsSync(arg)) return null;
  try {
    const st = statSync(arg);
    if (!st.isFile() || st.size > 1_000_000) return null;
  } catch {
    return null;
  }
  return arg;
}

async function runOneProbe(
  client: ApiClient,
  question: string,
  label: string,
  n: number,
): Promise<{ scores: number[]; tokens: number[] }> {
  const { bias, d } = analyzeSentiment(question);

  process.stdout.write(
    chalk.bold(`Probing engine determinism on "${label}" — ${n} runs (d=${d}, bias=${bias.toFixed(2)})\n`),
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
      if (err instanceof ApiAuthError || err instanceof ApiCloudflareError) throw err;
      process.stderr.write(chalk.red(`  Pass ${i + 1}/${n} failed: ${(err as Error).message}\n`));
    }
  }
  return { scores, tokens };
}

function summarise(scores: number[], tokens: number[], label: string): void {
  if (scores.length < 2) {
    process.stderr.write(chalk.red(`\n${label}: fewer than 2 passes succeeded — cannot compute variance.\n`));
    return;
  }
  const meanAin = scores.reduce((a, b) => a + b, 0) / scores.length;
  const ainVariance = scores.reduce((s, x) => s + (x - meanAin) ** 2, 0) / scores.length;
  const ainStdDev = Math.sqrt(ainVariance);
  const meanTokens = tokens.reduce((a, b) => a + b, 0) / tokens.length;
  const tokensVariance = tokens.reduce((s, x) => s + (x - meanTokens) ** 2, 0) / tokens.length;
  const tokensStdDev = Math.sqrt(tokensVariance);
  const totalTokens = tokens.reduce((a, b) => a + b, 0);

  const ainDeterministic = ainStdDev === 0;
  const ainLabel = ainDeterministic
    ? chalk.green("✓ DETERMINISTIC")
    : chalk.yellow(`⚠ DRIFT (stdDev=${ainStdDev.toFixed(2)})`);

  process.stdout.write(
    `\n${chalk.bold(label)}\n` +
      `  AIN     mean=${meanAin.toFixed(2)}  stdDev=${ainStdDev.toFixed(2)}  ${ainLabel}\n` +
      `  Tokens  mean=${meanTokens.toFixed(1)}  stdDev=${tokensStdDev.toFixed(2)}  total=${chalk.gray(String(totalTokens))}\n`,
  );

  if (!ainDeterministic) {
    process.stdout.write(
      chalk.yellow(
        `  Drift detected — engine load-balancer routing differently OR an A/B test. Report at zeropointlogic.io/support.\n`,
      ),
    );
  }
}

export async function cmdConsistency(
  inputArg: string,
  opts: ConsistencyOptions = {},
): Promise<void> {
  const rawN = opts.n ?? "5";
  const parsedN = Number.parseInt(rawN, 10);
  if (Number.isNaN(parsedN) || parsedN < MIN_N || parsedN > MAX_N) {
    process.stderr.write(
      chalk.red(`Invalid --n value: "${rawN}". Must be an integer between ${MIN_N} and ${MAX_N}.\n`),
    );
    process.exit(2);
  }
  const n = parsedN;

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  // ── File mode (bug #8 fix) ─────────────────────────────────────────────
  const filePath = asReadableFile(inputArg);
  if (filePath) {
    let prompts: BatchPrompt[];
    try {
      prompts = parsePromptFile(filePath);
    } catch (err) {
      process.stderr.write(chalk.red(`zpl consistency: ${(err as Error).message}\n`));
      process.exit(2);
    }
    if (prompts.length > MAX_PROMPTS_FROM_FILE) {
      process.stderr.write(
        chalk.red(
          `zpl consistency: ${filePath} has ${prompts.length} prompts; cap is ${MAX_PROMPTS_FROM_FILE}. ` +
            `Trim the file or split it.\n`,
        ),
      );
      process.exit(2);
    }
    process.stdout.write(
      chalk.bold(`Batch mode: ${prompts.length} prompts × ${n} passes each\n`) +
        chalk.gray(
          `Engine is deterministic on the same (d, bias) — same prompt should give same AIN.\n` +
            `Cross-prompt variance shows how similarly the engine scores related-but-different inputs.\n\n`,
        ),
    );

    const allScoresAcrossPrompts: number[] = [];
    let totalTokens = 0;
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const label = p.label || `${i + 1}: ${p.prompt.slice(0, 60)}${p.prompt.length > 60 ? "..." : ""}`;
      if (p.prompt.trim().length < 10) {
        process.stdout.write(chalk.yellow(`  Skipping "${label}" — too short.\n`));
        continue;
      }
      try {
        const { scores, tokens } = await runOneProbe(client, p.prompt, label, n);
        summarise(scores, tokens, label);
        if (scores.length > 0) {
          const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
          allScoresAcrossPrompts.push(mean);
        }
        totalTokens += tokens.reduce((a, b) => a + b, 0);
        process.stdout.write("\n");
      } catch (err) {
        if (err instanceof ApiAuthError || err instanceof ApiCloudflareError) throw err;
        process.stderr.write(chalk.red(`  "${label}" failed: ${(err as Error).message}\n`));
      }
    }

    // Cross-prompt summary
    if (allScoresAcrossPrompts.length >= 2) {
      const meanAcross = allScoresAcrossPrompts.reduce((a, b) => a + b, 0) / allScoresAcrossPrompts.length;
      const varAcross =
        allScoresAcrossPrompts.reduce((s, x) => s + (x - meanAcross) ** 2, 0) / allScoresAcrossPrompts.length;
      const stdAcross = Math.sqrt(varAcross);
      process.stdout.write(
        chalk.bold(`Cross-prompt summary (${allScoresAcrossPrompts.length} prompts)\n`) +
          `  Mean AIN across prompts: ${meanAcross.toFixed(2)}\n` +
          `  Spread (stdDev):         ${stdAcross.toFixed(2)}\n` +
          `  Total tokens:            ${totalTokens}\n`,
      );
    }

    appendHistory({
      command: "consistency-batch",
      input: `${filePath} (${prompts.length} prompts)`,
      score: Math.round(allScoresAcrossPrompts.reduce((a, b) => a + b, 0) / Math.max(allScoresAcrossPrompts.length, 1)),
      status: "BATCH",
      tokens: totalTokens,
    });
    printDisclaimer();
    return;
  }

  // ── String mode (legacy + default) ─────────────────────────────────────
  if (inputArg.trim().length < 10) {
    process.stderr.write(
      chalk.red(`Question is too short to analyze (minimum 10 characters).\n`) +
        chalk.gray(
          `Tip: pass a path to a .json / .yml / .txt file to score a batch of prompts.\n`,
        ),
    );
    process.exit(2);
  }

  process.stdout.write(
    chalk.gray(
      `Note: this measures engine reproducibility for the same input.\n` +
        `For agent consistency, call the agent N times yourself and use \`zpl pipe\` on each output.\n\n`,
    ),
  );
  const { scores, tokens } = await runOneProbe(client, inputArg, inputArg.slice(0, 60), n);
  summarise(scores, tokens, inputArg.slice(0, 60));

  appendHistory({
    command: "consistency",
    input: inputArg,
    score: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    status: scores.length >= 2 && new Set(scores).size === 1 ? "DETERMINISTIC" : "DRIFT",
    tokens: tokens.reduce((a, b) => a + b, 0),
  });
  printDisclaimer();
}
