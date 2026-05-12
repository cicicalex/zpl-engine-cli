#!/usr/bin/env node
// Install proxy dispatcher BEFORE any module that uses fetch — undici reads
// HTTP_PROXY/HTTPS_PROXY/NO_PROXY env vars at this call. If we install later,
// the first fetch (e.g. update-check.ts) would already be issued direct.
import { installProxyDispatcher } from "./proxy.js";
installProxyDispatcher();

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
  ApiQuotaExhaustedError,
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
import { cmdQuota } from "./commands/quota.js";
import { cmdPlans } from "./commands/plans.js";
import { cmdExport } from "./commands/export.js";
import { cmdUpdate } from "./commands/update.js";
import { cmdCompletion } from "./commands/completion.js";
import {
  cmdConfigGet,
  cmdConfigSet,
  cmdConfigUnset,
  cmdConfigList,
  cmdConfigEdit,
} from "./commands/config.js";
import { cmdLogs, type LogTypeFilter } from "./commands/logs.js";
import { checkLatestVersion } from "./update-check.js";

const VERSION = "1.1.6";

/**
 * Sanitise an arbitrary string before showing it to the user / writing to
 * stderr. Mirrors db.ts sanitiseStatus regex set so an engine error that
 * accidentally echoes back the request body (with the Authorization header,
 * or the raw key in a debug message) doesn't leak the secret to:
 *   - the user's terminal scroll-back
 *   - shell history (if they pipe stderr)
 *   - CI logs (almost always world-readable in the org)
 *
 * Defence in depth: the engine should never put secrets in error bodies.
 * If it ever does, this catches the leak before it hits the screen.
 */
function sanitiseErrorMessage(s: string): string {
  return s
    .replace(/zpl_[us]_(?:[a-z]+_)?[a-f0-9]{20,}/gi, "[REDACTED-ZPL-KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "[REDACTED-SK-KEY]")
    .replace(/gsk_[A-Za-z0-9_-]+/gi, "[REDACTED-GSK-KEY]");
}

function dieFormatted(err: unknown, verbose: boolean): never {
  // Wrap each writer so secret-shaped strings inside any error message get
  // redacted before they reach the terminal / shell history / CI logs.
  const writeErr = (s: string) => process.stderr.write(sanitiseErrorMessage(s));

  if (err instanceof ApiAuthError) {
    writeErr(chalk.red(err.message) + "\n");
  } else if (err instanceof ApiQuotaExhaustedError) {
    // Yellow not red — the user's setup is fine, they just need to upgrade.
    // The multi-line message already contains plan ladder + /pricing link.
    writeErr(chalk.yellow(err.message) + "\n");
  } else if (err instanceof ApiQuotaError) {
    writeErr(chalk.yellow(err.message) + "\n");
  } else if (err instanceof ApiCloudflareError) {
    // Yellow not red: the engine is fine, this is upstream WAF noise.
    writeErr(chalk.yellow(err.message) + "\n");
  } else if (err instanceof ApiNetworkError) {
    writeErr(chalk.red(err.message) + "\n");
  } else if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOCONFIG" || code === "EBADKEY") {
      writeErr(chalk.red(err.message) + "\n");
    } else {
      writeErr(chalk.red(`Error: ${err.message}`) + "\n");
      if (verbose && err.stack) writeErr(chalk.gray(err.stack) + "\n");
    }
  } else {
    writeErr(chalk.red("Unknown error.") + "\n");
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
  .description("Show the logged-in user, plan, and quota")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .action(async (opts: { output?: string }) => {
    try {
      await cmdWhoami({ output: opts.output as "text" | "json" | undefined });
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
  .command("check [file]")
  .description(
    "Score a file (or stdin) for bias / neutrality. Examples:\n" +
      '  zpl check file.txt\n' +
      '  echo "..." | zpl check\n' +
      '  echo "..." | zpl check -o json | jq .ain',
  )
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .option(
    "--max-bytes <n>",
    "max bytes to read from stdin (1024..10MB; default 1MB)",
  )
  .action(async (file: string | undefined, opts: { output?: string; maxBytes?: string }) => {
    try {
      await cmdCheck(file, opts as { output?: "text" | "json"; maxBytes?: string });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("watch [file]")
  .description(
    "Watch and score continuously. With <file>: re-score on disk save.\n" +
      "Without args: watch the clipboard. Ctrl+C to stop.",
  )
  .option("--clipboard", "Force clipboard mode (default when no file given)")
  .action(async (file: string | undefined, opts: { clipboard?: boolean }) => {
    try {
      await cmdWatch(file, opts);
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
  .description(
    "Compare two text versions. Default: whole-file delta. --lines: paragraph-by-paragraph drift.",
  )
  .option("--lines", "Score line-by-line and surface which lines drifted")
  .option("--max-lines <n>", "Cap on lines scored when --lines is on (2..200, default 40)")
  .action(async (before: string, after: string, opts: { lines?: boolean; maxLines?: string }) => {
    try {
      await cmdDiff(before, after, opts);
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

program
  .command("quota")
  .description("Show tokens used this month + remaining")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .action(async (opts: { output?: string }) => {
    try {
      await cmdQuota({ output: opts.output as "text" | "json" | undefined });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("plans")
  .description("List all ZPL plans + monthly token quotas + prices")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .action(async (opts: { output?: string }) => {
    try {
      await cmdPlans({ output: opts.output as "text" | "json" | undefined });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("export <format>")
  .option("--with-config", "Include config summary (no API key) in the export bundle")
  .description("Export local history to stdout (json | csv | markdown). Pipe to a file.")
  .option("-l, --limit <n>", "max entries to export (default: all)")
  .action(async (format: string, opts: { limit?: string; withConfig?: boolean }) => {
    try {
      await cmdExport(format, { limit: opts.limit, withConfig: opts.withConfig });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("update")
  .description("Check for a new version and tell you how to install it (--apply runs npm install)")
  .option("--apply", "actually run `npm install -g zpl-engine-cli@latest` (skip on shared boxes)")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .action(async (opts: { apply?: boolean; output?: string }) => {
    try {
      await cmdUpdate({
        apply: Boolean(opts.apply),
        output: opts.output as "text" | "json" | undefined,
      });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("completion <shell>")
  .description("Print a tab-completion script for bash | zsh | fish | powershell")
  .action(async (shell: string) => {
    try {
      await cmdCompletion(shell);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

const configCmd = program
  .command("config")
  .description("Get/set/list config values in ~/.zpl/config.toml");

configCmd
  .command("get <key>")
  .description("Print one value (e.g. `zpl config get engine.base_url`)")
  .action(async (key: string) => {
    try {
      await cmdConfigGet(key);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

configCmd
  .command("set <key> <value>")
  .description("Set a value (engine URL is host-allowlist validated)")
  .action(async (key: string, value: string) => {
    try {
      await cmdConfigSet(key, value);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

configCmd
  .command("unset <key>")
  .description("Revert a value to its built-in default")
  .action(async (key: string) => {
    try {
      await cmdConfigUnset(key);
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

configCmd
  .command("list")
  .description("Show all config keys + values (api_key shown redacted)")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .action(async (opts: { output?: string }) => {
    try {
      await cmdConfigList({ output: opts.output as "text" | "json" | undefined });
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

configCmd
  .command("edit")
  .description("Open ~/.zpl/config.toml in $EDITOR (or notepad on Windows)")
  .action(async () => {
    try {
      await cmdConfigEdit();
    } catch (err) {
      dieFormatted(err, Boolean(program.opts().verbose));
    }
  });

program
  .command("logs")
  .description("Show recent CLI activity from the local log (privacy: input is hashed)")
  .option("-l, --limit <n>", "max entries to show (default 50, max 500)")
  .option("-o, --output <fmt>", "output format: text (default) or json", "text")
  .option("-t, --type <filter>", "filter by event type: all | auth | scoring", "all")
  .action(async (opts: { limit?: string; output?: string; type?: string }) => {
    try {
      await cmdLogs({
        limit: opts.limit,
        output: opts.output as "text" | "json" | undefined,
        type: opts.type as LogTypeFilter | undefined,
      });
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

  // Tell commander to throw on unknown command / unknown option / missing
  // required arg instead of writing "error: ..." to stderr and exiting 0.
  // Pre-v1 `zpl nonexistent` and `zpl plans --bogus` BOTH exited 0,
  // breaking POSIX convention and silently passing CI scripts that
  // expect non-zero on usage errors. exitOverride lets us catch and
  // exit 2 (EX_USAGE).
  //
  // commander's exitOverride() only affects the command it's called on,
  // NOT child subcommands — so we walk the command tree after wiring all
  // subcommands and apply exitOverride to each. Without this, a bogus
  // option on a subcommand (e.g. `zpl plans --bogus`) writes to stderr
  // and exits 0, which is exactly the bug we're fixing.
  function applyExitOverrideRecursive(cmd: Command): void {
    cmd.exitOverride();
    for (const sub of cmd.commands) applyExitOverrideRecursive(sub);
  }
  applyExitOverrideRecursive(program);

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Commander throws CommanderError for built-in cases (--help, --version,
    // unknown command, etc.). For --help and --version it sets exitCode=0;
    // for everything else 1. Honor whatever it set; just don't crash.
    type CommanderErrorLike = { code?: string; exitCode?: number; message?: string };
    const ce = err as CommanderErrorLike;
    if (ce && typeof ce.code === "string" && ce.code.startsWith("commander.")) {
      // Successful built-in (--help, --version): commander already wrote
      // the relevant output to stdout and exitCode is set to 0.
      if (ce.code === "commander.help" || ce.code === "commander.version" || ce.code === "commander.helpDisplayed") {
        process.exitCode = 0;
        return;
      }
      // Bad usage (unknown command, unknown option, missing arg): map to
      // POSIX EX_USAGE (sysexits.h says 64; many CLIs use 2 instead).
      // Stick with 2 — same as commander's default and most CLIs.
      process.exitCode = ce.exitCode ?? 2;
      return;
    }
    dieFormatted(err, Boolean(program.opts().verbose));
  }
})();
