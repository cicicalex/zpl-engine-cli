import chalk from "chalk";
import Table from "cli-table3";
import { requireConfig } from "../config.js";
import { ApiClient, ApiAuthError } from "../api-client.js";
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

  // AUDIT 2026-07-30: this was `.catch(() => null)` with the comment "Silent
  // on failure", and it swallowed the one failure that must not be silent.
  //
  // `me()` re-throws ApiAuthError deliberately so callers can tell a rejected
  // key from an outage. Discarding it meant a dead key rendered as
  // "ZPL Main /api/user/me unreachable — try again later" plus a fabricated
  // `plan: free` — telling the user to wait for a server that is fine, and
  // pointing them away from the only thing that fixes it.
  //
  // Same shape quota.ts uses: auth failures are fatal, everything else keeps
  // the config-only rendering, which is genuinely useful during an outage.
  let me;
  try {
    me = await client.me();
  } catch (err) {
    if (err instanceof ApiAuthError) throw err;
    me = null;
  }

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
    const { remaining, used_this_month, monthly_quota, bonus_balance, source } = me.tokens;

    // AUDIT 2026-07-31, measured: 200 tokens were spent on the engine and this
    // table still printed "0 / 50.000.000 used". Three separate failures on the
    // server produce a zero that is indistinguishable from a real one, and the
    // API now says which happened. Printing the zero anyway, in cyan, next to a
    // confident "remaining", would waste that.
    //
    // The limit is enforced by the engine on every request whatever this says,
    // so a wrong zero is not a cosmetic problem: it is the only warning anyone
    // gets before being refused.
    // AUDIT 2026-07-31, tightened: this listed the two failure values. That
    // trusts anything else by default, so a `source` added on the server later
    // would be rendered as a measurement without anyone deciding it should be.
    // Whitelisting the single value that means "read from the engine" fails the
    // safe way instead - a new label reads as not-measured until someone says
    // otherwise. `zpl quota` was written this way and the two disagreed.
    const unknown = source !== "engine_log";

    table.push(["Tokens remaining", unknown ? chalk.yellow("unknown") : chalk.cyan(remaining.toLocaleString())]);

    if (unknown) {
      table.push([
        "  ↳ monthly quota",
        chalk.yellow(`? / ${monthly_quota.toLocaleString()} used`),
      ]);
      table.push([
        "  ↳ why",
        chalk.gray(
          source === "engine_user_not_found"
            ? "the account service could not match you engine-side — usage not read"
            : "usage came from a cached copy, not the engine — may be stale",
        ),
      ]);
    } else {
      table.push([
        "  ↳ monthly quota",
        `${used_this_month.toLocaleString()} / ${monthly_quota.toLocaleString()} used`,
      ]);
    }

    table.push(["  ↳ bonus balance", bonus_balance > 0 ? chalk.green(bonus_balance.toLocaleString()) : "0"]);
  } else {
    table.push(["Tokens", chalk.gray("(ZPL Main /api/user/me unreachable — try again later)")]);
  }
  process.stdout.write(table.toString() + "\n");
}
