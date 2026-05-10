/**
 * `zpl repair` — wipe local config and start a fresh login.
 *
 * Mirrors `zpl-engine-mcp repair`. Unlike `logout` (which only deletes the
 * file), repair also re-runs the device flow so the user is back to a known
 * good state in one command. Useful when:
 *   - The saved key was revoked server-side
 *   - The config file got corrupted
 *   - Replication lag left a key the engine doesn't yet recognise
 *
 * The default flow asks for confirmation before deleting anything. Pass
 * `--yes` to skip the prompt for non-interactive use (CI, scripts, agents).
 *
 * v1.0.0 fix (Bug #10): pre-v1.0 if the post-wipe device flow failed (timeout,
 * network down, user denied), the user was left with NO config — strictly
 * worse than the broken state they started with. Now we back the config up
 * to ~/.zpl/config.toml.bak before deletion, and on login failure we offer
 * a clear restore command so they can roll back.
 */
import { createInterface } from "node:readline/promises";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import chalk from "chalk";
import { deleteConfig, getConfigPath, readConfig } from "../config.js";
import { cmdLogin } from "./login.js";

export interface RepairOptions {
  /** Skip the "delete config?" prompt. */
  yes?: boolean;
}

function backupPath(): string {
  return getConfigPath() + ".bak";
}

export async function cmdRepair(opts: RepairOptions = {}): Promise<void> {
  const existing = readConfig();

  if (!existing) {
    process.stdout.write(
      chalk.gray(`No existing config at ${getConfigPath()}. Running login.\n\n`),
    );
    await cmdLogin({ force: true });
    return;
  }

  process.stdout.write(
    chalk.yellow(
      `Repair will delete ${getConfigPath()} (currently logged in as ${chalk.bold(
        existing.auth.user_email,
      )}).\n`,
    ),
  );
  process.stdout.write(
    chalk.gray(`A backup will be saved to ${backupPath()} so you can roll back if login fails.\n`),
  );

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        chalk.red(
          "Cannot prompt for confirmation in non-interactive mode. Pass --yes to proceed.\n",
        ),
      );
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Continue? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      process.stdout.write(chalk.gray("Cancelled.\n"));
      return;
    }
  }

  // ── Backup first so we can roll back if the device flow fails ──────
  const bak = backupPath();
  try {
    copyFileSync(getConfigPath(), bak);
    process.stdout.write(chalk.gray(`✓ Backed up to ${bak}\n`));
  } catch (err) {
    // Backup failure is fatal — proceeding without one means a repair gone
    // wrong leaves the user with nothing.
    process.stderr.write(
      chalk.red(
        `Could not back up config: ${(err as Error).message}\n` +
          `Aborting repair to avoid losing your credentials.\n`,
      ),
    );
    process.exit(1);
  }

  const removed = deleteConfig();
  if (removed) {
    process.stdout.write(chalk.green(`✓ Removed ${getConfigPath()}.\n\n`));
  } else {
    // Race: file disappeared between readConfig() and deleteConfig().
    process.stdout.write(chalk.gray("Config already gone.\n\n"));
  }

  process.stdout.write(chalk.bold("Starting fresh login…\n"));
  try {
    await cmdLogin({ force: true });
    // Login succeeded — the new config is in place. We can drop the backup
    // (not strictly necessary, but keeps the dir clean and signals success).
    if (existsSync(bak)) {
      try {
        renameSync(bak, bak + ".old");
      } catch {
        // Best-effort cleanup; not critical if it fails.
      }
    }
  } catch (err) {
    process.stderr.write(
      chalk.red(`\nLogin failed during repair: ${(err as Error).message}\n`) +
        chalk.yellow(
          `\nYour previous config is still backed up at:\n  ${bak}\n\n`,
        ) +
        chalk.gray(
          `To restore, run:\n` +
            (process.platform === "win32"
              ? `  copy "${bak}" "${getConfigPath()}"\n`
              : `  cp "${bak}" "${getConfigPath()}"\n`) +
            `\nOr try \`zpl repair\` again.\n`,
        ),
    );
    process.exit(1);
  }
}
