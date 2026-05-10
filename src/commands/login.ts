import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import {
  DEFAULT_SITE,
  buildApproveUrl,
  openInBrowser,
  startDeviceFlow,
  waitForApproval,
} from "../device-flow.js";
import { writeConfig, getConfigPath, readConfig } from "../config.js";
import { isValidApiKeyFormat, isServiceKey } from "../api-key-format.js";
import { ApiClient } from "../api-client.js";

export interface LoginOptions {
  /** Skip the "already logged in" prompt and re-run the device flow. */
  force?: boolean;
}

/**
 * Memory-aware login.
 *
 * v0.2.0: ported the same UX from `npx zpl-engine-mcp setup` — if a config
 * already exists we tell the user who they're logged in as and ask if they
 * want to re-login. Defaults to NO so accidentally typing `zpl login` twice
 * doesn't burn through device-flow rate limits. Pass `--force` to bypass.
 *
 * After login, runs a smoke test against /api/user/me to catch the rare
 * "engine hasn't received the new key yet" case (replication lag). The test
 * is non-fatal — we warn the user and tell them to retry in 30s rather than
 * leaving them with a saved-but-not-working config.
 */
export async function cmdLogin(opts: LoginOptions = {}): Promise<void> {
  // ── 1. Memory check ──────────────────────────────────────────────────
  if (!opts.force) {
    const existing = readConfig();
    if (existing) {
      process.stdout.write(
        chalk.green(
          `\nAlready logged in as ${chalk.bold(existing.auth.user_email)}.\n`,
        ),
      );
      process.stdout.write(
        chalk.gray(`Config at ${getConfigPath()}\n`),
      );
      process.stdout.write(
        chalk.gray(`Run ${chalk.cyan("zpl whoami")} to see plan + quota.\n\n`),
      );

      // stdin not a TTY → assume non-interactive (CI/scripts) and exit cleanly
      // rather than hanging waiting for input. `--force` is the escape hatch
      // for non-interactive re-login.
      if (!process.stdin.isTTY) {
        process.stdout.write(
          chalk.gray(`(Pass ${chalk.cyan("--force")} to re-login.)\n`),
        );
        return;
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`Re-login on this device? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write(chalk.gray("Keeping existing login.\n"));
        return;
      }
      process.stdout.write(chalk.yellow("\nStarting fresh login flow…\n"));
    }
  }

  // ── 2. Device flow ───────────────────────────────────────────────────
  const site = DEFAULT_SITE;
  const deviceName = hostname();

  let start;
  try {
    start = await startDeviceFlow(site, deviceName);
  } catch (err) {
    process.stderr.write(chalk.red(`Could not start login: ${(err as Error).message}\n`));
    process.exit(1);
  }

  const approveUrl = buildApproveUrl(start);
  process.stdout.write("\n");
  process.stdout.write(chalk.bold("Your code:\n\n"));
  process.stdout.write(`    ${chalk.cyan.bold(start.user_code)}\n\n`);
  process.stdout.write(`Opening ${chalk.gray(approveUrl)}\n`);
  process.stdout.write(chalk.gray("(If your browser does not open, paste the URL above.)\n\n"));

  openInBrowser(approveUrl);

  let approved;
  try {
    approved = await waitForApproval(site, start);
  } catch (err) {
    process.stderr.write(chalk.red(`${(err as Error).message}\n`));
    process.exit(1);
  }

  // ── 3. Format validation (defence in depth) ──────────────────────────
  // Engine is authoritative, but if we somehow get back a malformed key the
  // smoke test below would just produce a noisy 401. Surface the bad input
  // up front with an actionable message.
  if (isServiceKey(approved.api_key)) {
    process.stderr.write(
      chalk.red(
        "Engine returned a service key (zpl_s_*). CLI requires a user key (zpl_u_*). Contact support.\n",
      ),
    );
    process.exit(1);
  }
  if (!isValidApiKeyFormat(approved.api_key)) {
    process.stderr.write(
      chalk.red(
        "Engine returned a key in an unexpected format. CLI cannot save it safely. Try again or contact support.\n",
      ),
    );
    process.exit(1);
  }

  // ── 4. Persist config ────────────────────────────────────────────────
  writeConfig({
    auth: {
      api_key: approved.api_key,
      user_email: approved.user_email,
      created_at: new Date().toISOString(),
    },
    engine: { base_url: "https://engine.zeropointlogic.io" },
    defaults: { model: "claude-haiku-4-5" },
  });

  const plan = approved.user_plan ?? "free";
  process.stdout.write(
    chalk.green(`\nLogged in as ${chalk.bold(approved.user_email)} (plan: ${plan}).\n`),
  );
  process.stdout.write(chalk.gray(`Config saved to ${getConfigPath()}\n`));

  // ── 5. Smoke test (non-fatal) ────────────────────────────────────────
  // The website confirms the key the moment the device-flow approval lands,
  // but the engine reads from a follower DB which can lag a second or two.
  // Hit /api/user/me once to confirm. If it 401s we still keep the config
  // (the wizard authorized it; we trust that) but warn the user so they
  // don't blame us when the next command also 401s for ~30s.
  process.stdout.write(chalk.gray("\nVerifying key with engine…\n"));
  try {
    const client = new ApiClient({
      apiKey: approved.api_key,
      baseUrl: "https://engine.zeropointlogic.io",
    });
    const me = await client.me();
    if (me) {
      process.stdout.write(chalk.green("✓ Engine accepted the key.\n"));
    } else {
      // /api/user/me may not exist yet on the backend. Soft pass.
      process.stdout.write(
        chalk.gray("  (Engine /api/user/me not available — skipping verification.)\n"),
      );
    }
  } catch (err) {
    const msg = (err as Error).message;
    process.stdout.write(
      chalk.yellow(
        `⚠ Engine did not accept the key yet: ${msg}\n` +
          `  This is usually replication lag. Retry ${chalk.cyan("zpl whoami")} in ~30s.\n`,
      ),
    );
  }
}
