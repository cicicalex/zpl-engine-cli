#!/usr/bin/env node
/**
 * zpl-engine-cli entry point.
 *
 * v0.2.0 commands:
 *   zpl login [--force]   - device-flow login (memory-aware: detects existing config)
 *   zpl logout            - delete local config
 *   zpl whoami            - show logged-in user + plan + quota
 *   zpl diagnose          - health report (config + key + engine + auth)
 *   zpl repair [--yes]    - wipe config + auto-relogin
 *   zpl check <file>      - score a file for bias / neutrality
 *   zpl watch             - watch the clipboard, score each paste
 *   zpl consistency <q>   - run N consistency passes, report variance
 *   zpl compare <a> <b>   - compare two files side by side
 *   zpl diff <before> <after> - semantic delta between texts
 *   zpl history           - show last 20 scored runs
 *
 * Errors bubble up here where we translate API client exceptions into a
 * single-line red message on stderr + exit code 1. Stack traces are only
 * printed in --verbose mode; day-to-day users don't need to see them.
 */
import { Command } from "commander";
import chalk from "chalk";
import {
  ApiAuthError,
  ApiQuotaError,
  ApiNetworkError,
  ApiCloudflareError,
} from "./api-client.js";
import { cmdLogin } from "./commands/login.js";
import { cmdLogout } from "./commands/logout.js";
import { cmdWhoami } from "./commands/whoami.js";
import { cmdDiagnose } from "./commands/diagnose.js";
import { cmdRepair } from "./commands/repair.js";
import { cmdCheck } from "./commands/check.js";
import { cmdWatch } from "./commands/watch.js";
import { cmdConsistency } from "./commands/consistency.js";
import { cmdCompare } from "./commands/compare.js";
import { cmdDiff } from "./commands/diff.js";
import { cmdHistory } from "./commands/history.js";
import { cmdPipe } from "./commands/pipe.js";
import { cmdAbout } from "./commands/about.js";
import { checkLatestVersion } from "./update-check.js";

const VERSION = "1.0.0";

function dieFormatted(err: unknown, verbose: boolean): never {
  if (err instanceof ApiAuthError) {
    process.stderr.write(chalk.red(err.message) + "\n");
  } else if (err instanceof ApiQuotaError) {
    process.stderr.write(chalk.yellow(err.message) + "\n");
  } else if (err instanceof ApiCloudflareError) {
    // Yellow not red: the engine is fine, this is upstream WAF noise.
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
  .description("Log in via device flow (opens browser). Detects existing login.")
  .option("-f, --force", "skip the 'already logged in' prompt and re-run device flow")
  .action(async (opts: { force?: boolean }) => {
    try {
      await cmdLogin({ force: Boolean(opts.force) });
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
  .command("diagnose")
  .description("Run a health report (config + key + engine + auth)")
  .action(async () => {
    try {
      await cmdDiagnose();
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("repair")
  .description("Wipe local config and start a fresh login")
  .option("-y, --yes", "skip the confirmation prompt (non-interactive)")
  .action(async (opts: { yes?: boolean }) => {
    try {
      await cmdRepair({ yes: Boolean(opts.yes) });
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

program
  .command("pipe")
  .description("Score text from stdin. --threshold N exits 1 if AIN < N (CI gate).")
  .option("-t, --threshold <n>", "exit 1 if AIN score is below this value (1-100)")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .option("--max-bytes <n>", "max bytes to read from stdin (default 1000000)")
  .action(async (opts: { threshold?: string; output?: string; maxBytes?: string }) => {
    try {
      await cmdPipe({
        threshold: opts.threshold,
        output: opts.output as "text" | "json" | undefined,
        maxBytes: opts.maxBytes,
      });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("about")
  .description("What is ZPL, what does this CLI do, where to learn more")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .action(async (opts: { output?: string }) => {
    try {
      await cmdAbout({ output: opts.output as "text" | "json" | undefined });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

// Main async flow: run the version check first, then commander.
// The version check is best-effort (non-blocking on network failure) but
// forces upgrade on major version mismatch — same policy as the MCP.
//
// We use `process.exitCode = N; return;` instead of `process.exit(N)` to give
// libuv time to drain pending handles (e.g. the AbortSignal.timeout from the
// npm fetch in update-check.ts). On Windows, exit() while a timer is still
// in-flight asserts inside src/win/async.c. Setting exitCode is the safe
// alternative — Node exits cleanly when the event loop finally drains.
(async () => {
  const upgradeCheck = await checkLatestVersion(VERSION);
  if (upgradeCheck === "block") {
    process.exitCode = 1;
    return;
  }

  // No args → show help + onboarding hint.
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.stdout.write(
      "\n" + chalk.gray("Tip: run ") + chalk.cyan("`zpl login`") + chalk.gray(" to get started.\n"),
    );
    process.exitCode = 0;
    return;
  }

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    dieFormatted(err, Boolean(program.opts().verbose));
  }
})();
