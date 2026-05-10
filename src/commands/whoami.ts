import chalk from "chalk";
import Table from "cli-table3";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";

export interface WhoamiOptions {
  output?: "text" | "json";
}

/**
 * Show the logged-in identity, plan, and quota.
 *
 * v1.0.0 adds `--output json` for agent / scripting consumers — pre-v1 only
 * had a chalk-rendered table that was effectively unparseable from a script.
 */
export async function cmdWhoami(opts: WhoamiOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  const cfg = requireConfig();
  const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl: cfg.engine.base_url });

  let plan = "free";
  let quotaUsed: number | null = null;
  let quotaLimit: number | null = null;

  // /api/user/me may not exist yet — fail gracefully.
  try {
    const me = await client.me();
    if (me) {
      plan = me.plan ?? plan;
      if (typeof me.quota_used === "number") quotaUsed = me.quota_used;
      if (typeof me.quota_limit === "number") quotaLimit = me.quota_limit;
    }
  } catch {
    // Swallow; we'll display config-only data.
  }

  // Detect "from env" sentinel so JSON consumers can tell.
  const fromEnv = cfg.auth.created_at === new Date(0).toISOString();

  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          email: cfg.auth.user_email,
          plan,
          engine_url: cfg.engine.base_url,
          config_created: fromEnv ? null : cfg.auth.created_at,
          source: fromEnv ? "env" : "config-file",
          quota_used: quotaUsed,
          quota_limit: quotaLimit,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const table = new Table({ head: [chalk.bold("Field"), chalk.bold("Value")], style: { head: [] } });
  table.push(
    ["Email", cfg.auth.user_email],
    ["Plan", plan],
    ["Engine", cfg.engine.base_url],
    ["Source", fromEnv ? chalk.yellow("ZPL_API_KEY env var") : "config file"],
  );
  if (!fromEnv) {
    table.push(["Config created", cfg.auth.created_at]);
  }
  if (quotaUsed !== null && quotaLimit !== null) {
    table.push(["Quota (today)", `${quotaUsed.toLocaleString()} / ${quotaLimit.toLocaleString()}`]);
  } else {
    table.push(["Quota", chalk.gray("(remote endpoint not available — try `zpl quota`)")]);
  }
  process.stdout.write(table.toString() + "\n");
}
