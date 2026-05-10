/**
 * Health report for `zpl-engine-cli`.
 *
 * Mirrors the `zpl_diagnose` MCP tool: when the user reports "it stopped
 * working" the first thing we want is a deterministic ✓/✗ table covering
 * every layer that can fail. Each check is independent so the report keeps
 * going even if an early one fails.
 *
 * Checks:
 *   1. Config file exists and is parseable
 *   2. API key has a valid format (zpl_u_... or zpl_u_<prefix>_...)
 *   3. Engine HTTP endpoint is reachable (GET /health)
 *   4. Engine accepts the saved key (GET /api/user/me)
 *
 * Exit code: 0 if all checks pass, 1 if any FAIL. WARN does not affect exit.
 */
import chalk from "chalk";
import Table from "cli-table3";
import { readConfig, getConfigPath } from "../config.js";
import { isValidApiKeyFormat, isServiceKey } from "../api-key-format.js";
import { ApiClient, ApiAuthError } from "../api-client.js";

type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const ICON: Record<CheckStatus, string> = {
  PASS: chalk.green("✓"),
  FAIL: chalk.red("✗"),
  WARN: chalk.yellow("!"),
  SKIP: chalk.gray("·"),
};

export async function cmdDiagnose(): Promise<void> {
  const results: CheckResult[] = [];

  // ── Check 1: Config file ─────────────────────────────────────────────
  const cfg = readConfig();
  if (!cfg) {
    results.push({
      name: "Config file",
      status: "FAIL",
      detail: `Not found at ${getConfigPath()}`,
      hint: "Run `zpl login` to authenticate.",
    });
  } else {
    results.push({
      name: "Config file",
      status: "PASS",
      detail: `${getConfigPath()} (created ${cfg.auth.created_at})`,
    });
  }

  // ── Check 2: API key format ──────────────────────────────────────────
  if (!cfg) {
    results.push({
      name: "API key format",
      status: "SKIP",
      detail: "No config to validate",
    });
  } else if (isServiceKey(cfg.auth.api_key)) {
    results.push({
      name: "API key format",
      status: "FAIL",
      detail: "Service key (zpl_s_*) detected — CLI requires user keys (zpl_u_*)",
      hint: "Run `zpl logout` then `zpl login` to issue a user key.",
    });
  } else if (!isValidApiKeyFormat(cfg.auth.api_key)) {
    results.push({
      name: "API key format",
      status: "FAIL",
      detail: "Stored key does not match expected pattern (zpl_u_[prefix_]<48 hex>)",
      hint: "Run `zpl repair --yes` to wipe and re-login.",
    });
  } else {
    // Show the key shape WITHOUT leaking the body. e.g. `zpl_u_cli_*** (52 chars)`
    const safe = redactKey(cfg.auth.api_key);
    results.push({
      name: "API key format",
      status: "PASS",
      detail: `${safe} (${cfg.auth.api_key.length} chars)`,
    });
  }

  // ── Check 3: Engine reachable ────────────────────────────────────────
  const baseUrl = cfg?.engine.base_url ?? "https://engine.zeropointlogic.io";
  let engineReachable = false;
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; zpl-engine-cli/diagnose; +https://github.com/cicicalex/zpl-engine-cli)",
      },
    });
    if (res.ok) {
      engineReachable = true;
      results.push({
        name: "Engine reachable",
        status: "PASS",
        detail: `${baseUrl}/health → ${res.status}`,
      });
    } else {
      results.push({
        name: "Engine reachable",
        status: "FAIL",
        detail: `${baseUrl}/health → ${res.status} ${res.statusText}`,
        hint:
          res.status >= 500
            ? "Engine is having issues. Check status.zeropointlogic.io."
            : "Unexpected response. Try again in a moment.",
      });
    }
  } catch (err) {
    const msg = (err as Error).message;
    results.push({
      name: "Engine reachable",
      status: "FAIL",
      detail: `Network error: ${msg.slice(0, 80)}`,
      hint: "Check your internet connection or firewall.",
    });
  }

  // ── Check 4: Engine accepts the key ──────────────────────────────────
  if (!cfg || !engineReachable) {
    results.push({
      name: "Engine auth",
      status: "SKIP",
      detail: !cfg ? "No key to test" : "Engine unreachable",
    });
  } else {
    try {
      const client = new ApiClient({ apiKey: cfg.auth.api_key, baseUrl });
      const me = await client.me();
      if (me) {
        results.push({
          name: "Engine auth",
          status: "PASS",
          detail: `Authenticated as ${me.email} (plan: ${me.plan})`,
        });
      } else {
        // /api/user/me may not exist on all backends.
        results.push({
          name: "Engine auth",
          status: "WARN",
          detail: "Endpoint /api/user/me unavailable — cannot fully verify auth",
          hint: "Try `zpl check` on a test file to confirm the key works.",
        });
      }
    } catch (err) {
      if (err instanceof ApiAuthError) {
        results.push({
          name: "Engine auth",
          status: "FAIL",
          detail: "Engine rejected the key (401/403)",
          hint:
            "Either the key was revoked or replication is lagging. " +
            "Try `zpl repair --yes` to re-login.",
        });
      } else {
        results.push({
          name: "Engine auth",
          status: "WARN",
          detail: `Auth check inconclusive: ${(err as Error).message.slice(0, 80)}`,
        });
      }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────
  const table = new Table({
    head: [chalk.bold("Check"), chalk.bold(""), chalk.bold("Detail")],
    style: { head: [] },
    colWidths: [22, 4, 80],
    wordWrap: true,
  });
  for (const r of results) {
    table.push([r.name, ICON[r.status], r.detail]);
  }
  process.stdout.write(table.toString() + "\n");

  const fails = results.filter((r) => r.status === "FAIL");
  if (fails.length > 0) {
    process.stdout.write("\n" + chalk.red.bold(`${fails.length} check(s) failed.`) + "\n");
    for (const f of fails) {
      if (f.hint) process.stdout.write(chalk.yellow(`  → ${f.name}: ${f.hint}`) + "\n");
    }
    process.exit(1);
  }

  const warns = results.filter((r) => r.status === "WARN");
  if (warns.length > 0) {
    process.stdout.write("\n" + chalk.yellow.bold(`${warns.length} warning(s).`) + "\n");
    for (const w of warns) {
      if (w.hint) process.stdout.write(chalk.gray(`  → ${w.name}: ${w.hint}`) + "\n");
    }
  } else {
    process.stdout.write("\n" + chalk.green.bold("All checks passed.") + "\n");
  }
}

/**
 * Show a key as `zpl_u_cli_***` — preserve prefix so the user can confirm
 * they're looking at the right key shape, but never show the secret hex body.
 */
function redactKey(key: string): string {
  const m = key.match(/^(zpl_[us]_(?:[a-z]+_)?)/);
  if (m) return `${m[1]}***`;
  return "***";
}
