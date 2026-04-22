#!/usr/bin/env node
/**
 * zpl-engine-cli entry point. Commander sets up the nine commands spec'd in
 * docs/superpowers/specs/2026-04-17-zpl-engine-cli-device-flow-design.md §5.
 *
 * Errors bubble up here where we translate API client exceptions into a
 * single-line red message on stderr + exit code 1. Stack traces are only
 * printed in --verbose mode; day-to-day users don't need to see them.
 */
import { Command } from "commander";
import chalk from "chalk";
import { ApiAuthError, ApiQuotaError, ApiNetworkError } from "./api-client.js";
import { cmdLogin } from "./commands/login.js";
import { cmdLogout } from "./commands/logout.js";
import { cmdWhoami } from "./commands/whoami.js";
import { cmdCheck } from "./commands/check.js";
import { cmdWatch } from "./commands/watch.js";
import { cmdConsistency } from "./commands/consistency.js";
import { cmdCompare } from "./commands/compare.js";
import { cmdDiff } from "./commands/diff.js";
import { cmdHistory } from "./commands/history.js";
import { checkLatestVersion } from "./update-check.js";

const VERSION = "0.1.3";

function dieFormatted(err: unknown, verbose: boolean): never {
  if (err instanceof ApiAuthError) {
    process.stderr.write(chalk.red(err.message) + "\n");
  } else if (err instanceof ApiQuotaError) {
    process.stderr.write(chalk.yellow(err.message) + "\n");
  } else if (err instanceof ApiNetworkError) {
    process.stderr.write(chalk.red(err.message) + "\n");
  } else if (err instanceof Error) {
    if ((err as NodeJS.ErrnoException).code === "ENOCONFIG") {
      process.stderr.write(chalk.red(err.message) + "\n");
    } else {
      process.stderr.write(chalk.red(`Error: ${err.message}`) + "\n");
      if (verbose && err.stack) process.stderr.write(chalk.gray(err.stack) + "\n");
    }
  } else {
    process.stderr.write(chalk.red("Unknown error.") + "\n");
  }
  process.exit(1);
}

const program = new Command();

program
  .name("zpl")
  .description("ZPL Engine CLI — score AI output for bias, sycophancy, and consistency.")
  .version(VERSION)
  .option("-v, --verbose", "print full error stack traces");

program
  .command("login")
  .description("Log in via device flow (opens browser)")
  .action(async () => {
    try {
      await cmdLogin();
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("logout")
  .description("Remove local credentials")
  .action(async () => {
    try {
      await cmdLogout();
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("whoami")
  .description("Show the logged-in user and plan")
  .action(async () => {
    try {
      await cmdWhoami();
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("check <file>")
  .description("Score a file for bias / neutrality")
  .action(async (file: string) => {
    try {
      await cmdCheck(file);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("watch")
  .description("Watch the clipboard and score each new paste (Ctrl+C to stop)")
  .action(async () => {
    try {
      await cmdWatch();
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("consistency <question>")
  .description("Run N consistency passes on the same input and report variance")
  .option("-n, --n <count>", "number of passes", "5")
  .action(async (question: string, opts: { n?: string }) => {
    try {
      await cmdConsistency(question, opts);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("compare <a> <b>")
  .description("Compare two files side by side")
  .action(async (a: string, b: string) => {
    try {
      await cmdCompare(a, b);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("diff <before> <after>")
  .description("Semantic delta between before/after texts (improved / worsened / unchanged)")
  .action(async (before: string, after: string) => {
    try {
      await cmdDiff(before, after);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("history")
  .description("Show the last 20 scored runs")
  .action(async () => {
    try {
      await cmdHistory();
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

// Main async flow: run the version check first, then commander.
// The version check is best-effort (non-blocking on network failure) but
// forces upgrade on major version mismatch — same policy as the MCP.
(async () => {
  const upgradeCheck = await checkLatestVersion(VERSION);
  if (upgradeCheck === "block") {
    process.exit(1);
  }

  // No args → show help + onboarding hint.
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.stdout.write(
      "\n" + chalk.gray("Tip: run ") + chalk.cyan("`zpl login`") + chalk.gray(" to get started.\n"),
    );
    process.exit(0);
  }

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    dieFormatted(err, Boolean(program.opts().verbose));
  }
})();
