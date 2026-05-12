/**
 * `zpl quota` — show how many tokens the user has used + how many remain
 *               in the current billing period.
 *
 * Designed to be the answer to the most common support question after a
 * couple of days of usage: "how much do I have left?". Cheap to call
 * (no engine compute, just reads zeropointlogic.io/api/user/me) so users
 * can check it before kicking off a big batch.
 *
 * v1.1.7: now talks to the ZPL Main proxy at zeropointlogic.io which
 * combines monthly plan quota + tokensBonus + engine usage_log. Pre-v1.1.7
 * we hit engine.zeropointlogic.io (which never shipped /api/user/me) and
 * always rendered "unavailable".
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

  let me;
  try {
    me = await client.me();
  } catch (err) {
    if (err instanceof ApiAuthError) throw err;
    me = null;
  }

  // ── JSON output ──────────────────────────────────────────────────────
  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          plan: me?.user.plan ?? "free",
          plan_name: me?.user.plan_name ?? null,
          used: me?.tokens.used_this_month ?? null,
          monthly_quota: me?.tokens.monthly_quota ?? null,
          bonus_balance: me?.tokens.bonus_balance ?? null,
          remaining: me?.tokens.remaining ?? null,
          total_available_this_cycle: me?.tokens.total_available_this_cycle ?? null,
          percent_used: me?.tokens.percent_used ?? null,
          available: me !== null,
          source: me?.tokens.source ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // ── Text output ──────────────────────────────────────────────────────
  if (!me) {
    process.stdout.write(
      chalk.yellow(`Quota information unavailable.\n`) +
        chalk.gray(
          `zeropointlogic.io/api/user/me did not respond. ` +
            `Check connectivity, or try again later.\n`,
        ),
    );
    return;
  }

  const t = me.tokens;
  const percent = t.percent_used;
  const usageColor = percent >= 90 ? chalk.red : percent >= 70 ? chalk.yellow : chalk.green;

  const table = new Table({
    head: [chalk.bold("Field"), chalk.bold("Value")],
    style: TABLE_STYLE,
  });
  table.push(
    ["Plan", chalk.bold(`${me.user.plan} (${me.user.plan_name})`)],
    ["Used this month", `${t.used_this_month.toLocaleString()} tokens`],
    ["Monthly quota", `${t.monthly_quota.toLocaleString()} tokens`],
    ["Bonus balance", t.bonus_balance > 0 ? chalk.green(`${t.bonus_balance.toLocaleString()} tokens`) : "0"],
    ["Remaining", usageColor.bold(`${t.remaining.toLocaleString()} tokens`)],
    ["Cycle total available", `${t.total_available_this_cycle.toLocaleString()} tokens`],
    ["Used %", usageColor.bold(`${percent}%`)],
  );
  process.stdout.write(table.toString() + "\n");

  if (t.bonus_balance > 0) {
    process.stdout.write(
      "\n" +
        chalk.gray(
          `Note: bonus tokens (e.g. May 2026 promo, one-off packs) are consumed FIRST, then your monthly plan quota.\n`,
        ),
    );
  }

  if (percent >= 90) {
    process.stdout.write(
      "\n" +
        chalk.yellow(`You're close to the limit. Run \`zpl plans\` to see upgrade options.\n`),
    );
  }
}
