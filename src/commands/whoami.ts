import chalk from "chalk";
import Table from "cli-table3";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";
import { TABLE_STYLE } from "../table-style.js";

export interface WhoamiOptions {
  output?: "text" | "json";
}

/**
 * Show the logged-in identity, plan, and quota.
 *
 * v1.1.7: now talks to zeropointlogic.io/api/user/me (ZPL Main proxy),
 * which combines monthly plan quota + tokensBonus + engine usage_log
 * into a single shape. Pre-v1.1.7 we hit engine.zeropointlogic.io for
 * this and got 404, so `Quota` always read "endpoint not available".
 */
export async function cmdWhoami(opts: WhoamiOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  // Pull full account view from ZPL Main. Silent on failure.
  const me = await client.me().catch(() => null);

  // Detect "from env" sentinel so JSON consumers can tell.
  const fromEnv = cfg.auth.created_at === new Date(0).toISOString();

  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          email: me?.user.email ?? cfg.auth.user_email,
          name: me?.user.name ?? null,
          role: me?.user.role ?? null,
          plan: me?.user.plan ?? "free",
          plan_name: me?.user.plan_name ?? null,
          engine_url: cfg.engine.base_url,
          config_created: fromEnv ? null : cfg.auth.created_at,
          source: fromEnv ? "env" : "config-file",
          tokens: me?.tokens ?? null,
          limits: me?.limits ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const table = new Table({ head: [chalk.bold("Field"), chalk.bold("Value")], style: TABLE_STYLE });
  table.push(
    ["Email", me?.user.email ?? cfg.auth.user_email],
    ["Plan", `${me?.user.plan ?? "free"}${me?.user.plan_name ? ` (${me.user.plan_name})` : ""}`],
    ["Engine", cfg.engine.base_url],
    ["Source", fromEnv ? chalk.yellow("ZPL_API_KEY env var") : "config file"],
  );
  if (!fromEnv) {
    table.push(["Config created", cfg.auth.created_at]);
  }
  if (me?.tokens) {
    const { remaining, used_this_month, monthly_quota, bonus_balance } = me.tokens;
    table.push(
      ["Tokens remaining", chalk.cyan(remaining.toLocaleString())],
      [
        "  ↳ monthly quota",
        `${used_this_month.toLocaleString()} / ${monthly_quota.toLocaleString()} used`,
      ],
      ["  ↳ bonus balance", bonus_balance > 0 ? chalk.green(bonus_balance.toLocaleString()) : "0"],
    );
  } else {
    table.push(["Tokens", chalk.gray("(ZPL Main /api/user/me unreachable — try again later)")]);
  }
  process.stdout.write(table.toString() + "\n");
}
