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
 */
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { deleteConfig, getConfigPath, readConfig } from "../config.js";
import { cmdLogin } from "./login.js";

export interface RepairOptions {
  /** Skip the "delete config?" prompt. */
  yes?: boolean;
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

  const removed = deleteConfig();
  if (removed) {
    process.stdout.write(chalk.green(`✓ Removed ${getConfigPath()}.\n\n`));
  } else {
    // Race: file disappeared between readConfig() and deleteConfig().
    process.stdout.write(chalk.gray("Config already gone.\n\n"));
  }

  process.stdout.write(chalk.bold("Starting fresh login…\n"));
  await cmdLogin({ force: true });
}
