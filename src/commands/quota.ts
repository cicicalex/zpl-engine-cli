/**
 * `zpl quota` — show how many tokens the user has used + how many remain
 *               in the current billing period.
 *
 * Designed to be the answer to the most common support question after a
 * couple of days of usage: "how much do I have left?". Cheap to call
 * (no engine compute, just reads /api/user/me) so users can check it
 * before kicking off a big batch.
 *
 * v1.0.0 caveat: /api/user/me is the same endpoint whoami uses. If the
 * backend doesn't return quota_used / quota_limit yet, we degrade
 * gracefully — same as whoami.
 */
import chalk from "chalk";
import Table from "cli-table3";
import { requireConfig } from "../config.js";
import { ApiClient, ApiAuthError } from "../api-client.js";
import { TABLE_STYLE } from "../table-style.js";

export interface QuotaOptions {
  output?: "text" | "json";
}

export async function cmdQuota(opts: QuotaOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  let plan = "free";
  let used: number | null = null;
  let limit: number | null = null;

  try {
    const me = await client.me();
    if (me) {
      plan = me.plan ?? plan;
      if (typeof me.quota_used === "number") used = me.quota_used;
      if (typeof me.quota_limit === "number") limit = me.quota_limit;
    }
  } catch (err) {
    // Auth fail is terminal — bubble up to dieFormatted.
    if (err instanceof ApiAuthError) throw err;
    // Anything else: fall through to "unavailable" output.
  }

  // Compute derived metrics if both used + limit are present.
  const remaining = used !== null && limit !== null ? Math.max(0, limit - used) : null;
  const percentUsed =
    used !== null && limit !== null && limit > 0 ? Math.round((used / limit) * 100) : null;

  // ── JSON output ──────────────────────────────────────────────────────
  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          plan,
          used,
          limit,
          remaining,
          percent_used: percentUsed,
          available: used !== null && limit !== null,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // ── Text output ──────────────────────────────────────────────────────
  if (used === null || limit === null) {
    process.stdout.write(
      chalk.yellow(`Quota information unavailable on the engine.\n`) +
        chalk.gray(
          `The /api/user/me endpoint did not return quota_used / quota_limit.\n` +
            `Plan from config: ${chalk.bold(plan)}\n`,
        ),
    );
    return;
  }

  // Pick a colour based on how much headroom is left.
  const usageColor =
    percentUsed !== null && percentUsed >= 90
      ? chalk.red
      : percentUsed !== null && percentUsed >= 70
        ? chalk.yellow
        : chalk.green;

  const table = new Table({
    head: [chalk.bold("Field"), chalk.bold("Value")],
    style: TABLE_STYLE,
  });
  table.push(
    ["Plan", chalk.bold(plan)],
    ["Used", `${used.toLocaleString()} tokens`],
    ["Limit", `${limit.toLocaleString()} tokens`],
    ["Remaining", usageColor.bold(`${(remaining ?? 0).toLocaleString()} tokens`)],
    ["Used %", usageColor.bold(`${percentUsed}%`)],
  );
  process.stdout.write(table.toString() + "\n");

  // Friendly nudge if user is running low.
  if (percentUsed !== null && percentUsed >= 90) {
    process.stdout.write(
      "\n" +
        chalk.yellow(
          `You're close to the limit. Run \`zpl plans\` to see upgrade options.\n`,
        ),
    );
  }
}
