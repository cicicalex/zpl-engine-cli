import chalk from "chalk";
import Table from "cli-table3";
import { requireConfig } from "../config.js";
import { ApiClient } from "../api-client.js";

export async function cmdWhoami(): Promise<void> {
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

  const table = new Table({ head: [chalk.bold("Field"), chalk.bold("Value")], style: { head: [] } });
  table.push(
    ["Email", cfg.auth.user_email],
    ["Plan", plan],
    ["Engine", cfg.engine.base_url],
    ["Config created", cfg.auth.created_at],
  );
  if (quotaUsed !== null && quotaLimit !== null) {
    table.push(["Quota (today)", `${quotaUsed} / ${quotaLimit}`]);
  } else {
    table.push(["Quota", chalk.gray("(remote endpoint not available)")]);
  }
  process.stdout.write(table.toString() + "\n");
}
