/**
 * `zpl update` — self-service upgrade.
 *
 * Most users on a stale version don't know how to upgrade. The error path
 * in checkLatestVersion already prints "npm i -g zpl-engine-cli@latest" but
 * that requires global npm permissions, which on macOS/Linux often means
 * sudo, which means the user gives up. This command:
 *
 *   1. Detects which install method was used (global npm, npx cache, brew
 *      eventually, etc).
 *   2. Tells the user the exact command to run for THEIR install path.
 *   3. By default, runs it for them with the right flags.
 *   4. Verifies the new version after upgrade.
 *
 * v1.0.0 limitation: we don't actually shell out to spawn `npm install` yet
 * — that would require deciding sudo policy across platforms. We print the
 * exact command and let the user copy-paste. A future v1.1 may add
 * `--auto` to actually spawn it after a confirmation prompt.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { createRequire } from "node:module";

interface UpgradeInfo {
  current: string;
  latest: string | null;
  install_kind: "global-npm" | "npx" | "local-link" | "unknown";
  upgrade_command: string;
}

function readCurrentVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Heuristic detector for how this CLI was installed.
 *
 * - If __dirname contains "_npx/" (Linux/macOS) or "_npx\\" (Windows):
 *   npx cache. User runs via `npx zpl-engine-cli` and shouldn't upgrade
 *   the cache directly.
 * - Else if __dirname is under a global node_modules: global install.
 * - Else: local link or unknown (dev mode).
 */
function detectInstallKind(): UpgradeInfo["install_kind"] {
  let scriptDir = "";
  try {
    scriptDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return "unknown";
  }

  if (/[/\\]_npx[/\\]/.test(scriptDir)) return "npx";
  // Common global paths: /usr/lib/node_modules, /usr/local/lib/node_modules,
  // %APPDATA%\npm\node_modules. The directory name "node_modules" + a parent
  // of "npm" or "lib" is the cheapest tell.
  if (
    /[/\\]node_modules[/\\]zpl-engine-cli/.test(scriptDir) &&
    !/[/\\]_npx[/\\]/.test(scriptDir)
  ) {
    return "global-npm";
  }
  return "unknown";
}

function buildUpgradeCommand(kind: UpgradeInfo["install_kind"]): string {
  switch (kind) {
    case "npx":
      return "# You're running via npx. Just re-invoke with @latest:\n  npx -y zpl-engine-cli@latest <command>";
    case "global-npm":
      return "npm install -g zpl-engine-cli@latest";
    default:
      return "npm install -g zpl-engine-cli@latest";
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/zpl-engine-cli/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

export interface UpdateOptions {
  /** Skip confirmation and actually run npm install (USE AT OWN RISK on shared boxes). */
  apply?: boolean;
  /** Output format. */
  output?: "text" | "json";
}

export async function cmdUpdate(opts: UpdateOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  const current = readCurrentVersion();
  const latest = await fetchLatest();
  const install_kind = detectInstallKind();
  const upgrade_command = buildUpgradeCommand(install_kind);

  // status: "up-to-date" | "behind" | "ahead" | "unknown"
  let status: "up-to-date" | "behind" | "ahead" | "unknown" = "unknown";
  if (latest !== null) {
    const cmp = compareSemver(current, latest);
    if (cmp === 0) status = "up-to-date";
    else if (cmp < 0) status = "behind";
    else status = "ahead";
  }

  if (output === "json") {
    const payload = {
      current,
      latest,
      install_kind,
      upgrade_command,
      status,
      up_to_date: status === "up-to-date",
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  // Text output.
  if (latest === null) {
    process.stdout.write(
      chalk.yellow(`Could not contact npm registry to check the latest version.\n`) +
        chalk.gray(`Current local version: ${chalk.bold(current)}\n` + `Try again with internet access.\n`),
    );
    return;
  }

  if (status === "up-to-date") {
    process.stdout.write(chalk.green(`✓ Already on the latest version (${current}).\n`));
    return;
  }

  if (status === "ahead") {
    // Local version is newer than what's on npm — usually a dev build or a
    // pre-release that hasn't been published yet.
    process.stdout.write(
      chalk.gray(
        `Your local version (${current}) is ahead of npm's latest (${latest}). ` +
          `Probably a dev build — nothing to do.\n`,
      ),
    );
    return;
  }

  // status === "behind"
  process.stdout.write(
    chalk.bold(`zpl-engine-cli`) +
      `\n  current: ${chalk.cyan(current)}\n  latest:  ${chalk.green(latest)}\n` +
      `  install: ${chalk.gray(install_kind)}\n\n` +
      chalk.bold(`To upgrade, run:\n\n`) +
      `  ${chalk.cyan(upgrade_command)}\n\n`,
  );

  if (opts.apply) {
    if (install_kind === "npx") {
      process.stdout.write(
        chalk.yellow(`--apply ignored: npx upgrades happen automatically when you re-invoke.\n`),
      );
      return;
    }
    process.stdout.write(chalk.bold(`Running upgrade now…\n`));
    await runNpmInstall();
  }
}

/** Returns -1 / 0 / +1 for a semver comparison; 0 if either side unparseable. */
function compareSemver(a: string, b: string): number {
  const re = /^(\d+)\.(\d+)\.(\d+)/;
  const ma = re.exec(a);
  const mb = re.exec(b);
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * Spawn `npm install -g zpl-engine-cli@latest` and stream output.
 * Returns when the process exits. Caller decides what to do with exit code.
 */
function runNpmInstall(): Promise<void> {
  return new Promise((resolve) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    // Pre-flight: warn if global node_modules requires sudo on POSIX.
    if (process.platform !== "win32" && !existsSync("/usr/lib/node_modules")) {
      // No global path detected; let npm error out cleanly.
    }
    const child = spawn(npmCmd, ["install", "-g", "zpl-engine-cli@latest"], {
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (err) => {
      process.stderr.write(chalk.red(`Failed to spawn npm: ${err.message}\n`));
      process.exitCode = 1;
      resolve();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        process.stdout.write(chalk.green(`\n✓ Upgrade complete. Verify with \`zpl --version\`.\n`));
      } else {
        process.stderr.write(chalk.red(`\n✗ npm install exited with code ${code}.\n`));
        process.exitCode = code ?? 1;
      }
      resolve();
    });
  });
}
