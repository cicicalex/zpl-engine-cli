/**
 * `zpl config <subcommand>` — get/set/list/unset/edit values in
 * ~/.zpl/config.toml. Modeled after `git config`, `npm config`, and
 * `kubectl config`.
 *
 * Supported keys (dotted notation):
 *   auth.user_email
 *   engine.base_url        (validated via engine-url-validate before write)
 *   defaults.model
 *
 * INTENTIONALLY NOT supported here:
 *   auth.api_key — would let scripts overwrite the user's key with a typo
 *                  and brick auth. Use `zpl login` (re-runs device flow)
 *                  or `zpl repair` (with backup).
 *   auth.created_at — provenance metadata, never user-editable.
 *
 * `edit` opens the config file in $EDITOR (or notepad on Windows). Useful
 * for power users who'd rather see the whole TOML at once.
 */
import { spawn } from "node:child_process";
import chalk from "chalk";
import Table from "cli-table3";
import {
  readConfig,
  writeConfig,
  getConfigPath,
} from "../config.js";
import { TABLE_STYLE } from "../table-style.js";
import { validateEngineUrl, EngineUrlError } from "../engine-url-validate.js";

/** Keys the user can read AND write. Order matters for `list` output. */
const ALLOWED_KEYS = ["auth.user_email", "engine.base_url", "defaults.model"] as const;

/** Keys the user can READ but cannot WRITE (use other commands instead). */
const READONLY_KEYS = ["auth.api_key", "auth.created_at"] as const;

type Key = (typeof ALLOWED_KEYS)[number] | (typeof READONLY_KEYS)[number];

function getNested(cfg: ReturnType<typeof readConfig>, key: string): string | undefined {
  if (!cfg) return undefined;
  switch (key) {
    case "auth.api_key":
      // For privacy, return a redacted prefix. Never the full key.
      return cfg.auth.api_key ? cfg.auth.api_key.slice(0, 11) + "***" : undefined;
    case "auth.user_email":
      return cfg.auth.user_email;
    case "auth.created_at":
      return cfg.auth.created_at;
    case "engine.base_url":
      return cfg.engine.base_url;
    case "defaults.model":
      return cfg.defaults.model;
    default:
      return undefined;
  }
}

function setNested(
  cfg: ReturnType<typeof readConfig>,
  key: string,
  value: string,
): ReturnType<typeof readConfig> {
  if (!cfg) return null;
  // Trim leading/trailing whitespace from values — common copy-paste hazard
  // that would silently break engine.base_url (extra space) or user_email.
  const v = value.trim();
  switch (key) {
    case "auth.user_email":
      return { ...cfg, auth: { ...cfg.auth, user_email: v } };
    case "engine.base_url":
      // Validate against the host allowlist BEFORE writing — same defence
      // requireConfig() applies on read. Reject obviously dangerous URLs
      // (http://, attacker.com, etc.) at the write site so the user sees
      // the failure immediately rather than after the next API call.
      try {
        const cleaned = validateEngineUrl(v);
        return { ...cfg, engine: { ...cfg.engine, base_url: cleaned } };
      } catch (err) {
        if (err instanceof EngineUrlError) {
          throw new Error(`Cannot set engine.base_url: ${err.message}`);
        }
        throw err;
      }
    case "defaults.model":
      return { ...cfg, defaults: { ...cfg.defaults, model: v } };
    default:
      throw new Error(`Unsupported key: ${key}`);
  }
}

function unsetNested(
  cfg: ReturnType<typeof readConfig>,
  key: string,
): ReturnType<typeof readConfig> {
  if (!cfg) return null;
  // Restore each key to its sensible default rather than removing the field
  // (the parser requires the field to exist for the config to be considered
  // valid). Same defaults as readConfig falls back to.
  switch (key) {
    case "auth.user_email":
      // Email is required by the schema; we refuse to "unset" it. Use
      // `zpl logout` if the user wants to forget the entire identity.
      throw new Error(
        `auth.user_email cannot be unset (required field). Use \`zpl logout\` to remove the entire login.`,
      );
    case "engine.base_url":
      return { ...cfg, engine: { ...cfg.engine, base_url: "https://engine.zeropointlogic.io" } };
    case "defaults.model":
      return { ...cfg, defaults: { ...cfg.defaults, model: "claude-haiku-4-5" } };
    default:
      throw new Error(`Unsupported key: ${key}`);
  }
}

export async function cmdConfigGet(key: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) {
    process.stderr.write(chalk.red(`Not logged in. Run \`zpl login\` first.\n`));
    process.exit(1);
  }
  const all = [...ALLOWED_KEYS, ...READONLY_KEYS];
  if (!all.includes(key as Key)) {
    process.stderr.write(
      chalk.red(`Unknown key: "${key}".\n`) +
        chalk.gray(`Known keys: ${all.join(", ")}\n`),
    );
    process.exit(2);
  }
  const v = getNested(cfg, key);
  if (v === undefined) {
    process.stdout.write("\n"); // empty value — print blank line
  } else {
    process.stdout.write(v + "\n");
  }
}

export async function cmdConfigSet(key: string, value: string): Promise<void> {
  if (!ALLOWED_KEYS.includes(key as (typeof ALLOWED_KEYS)[number])) {
    if ((READONLY_KEYS as readonly string[]).includes(key)) {
      process.stderr.write(
        chalk.red(`Cannot set "${key}" via \`zpl config set\` — it's read-only here.\n`) +
          chalk.gray(
            key === "auth.api_key"
              ? `Use \`zpl login\` (device flow) or \`zpl repair\` (with backup).\n`
              : `It's managed automatically.\n`,
          ),
      );
      process.exit(2);
    }
    process.stderr.write(
      chalk.red(`Unknown key: "${key}".\n`) +
        chalk.gray(`Settable keys: ${ALLOWED_KEYS.join(", ")}\n`),
    );
    process.exit(2);
  }
  const cfg = readConfig();
  if (!cfg) {
    process.stderr.write(chalk.red(`Not logged in. Run \`zpl login\` first.\n`));
    process.exit(1);
  }
  const updated = setNested(cfg, key, value);
  if (!updated) {
    process.stderr.write(chalk.red(`Could not update config.\n`));
    process.exit(1);
  }
  writeConfig(updated);
  process.stdout.write(chalk.green(`✓ Set ${key} = ${getNested(updated, key)}\n`));
}

export async function cmdConfigUnset(key: string): Promise<void> {
  if (!ALLOWED_KEYS.includes(key as (typeof ALLOWED_KEYS)[number])) {
    process.stderr.write(
      chalk.red(`Unknown / unsettable key: "${key}".\n`) +
        chalk.gray(`Unsettable keys: ${ALLOWED_KEYS.join(", ")}\n`),
    );
    process.exit(2);
  }
  const cfg = readConfig();
  if (!cfg) {
    process.stderr.write(chalk.red(`Not logged in. Run \`zpl login\` first.\n`));
    process.exit(1);
  }
  let updated;
  try {
    updated = unsetNested(cfg, key);
  } catch (err) {
    process.stderr.write(chalk.red(`${(err as Error).message}\n`));
    process.exit(2);
  }
  if (!updated) {
    process.stderr.write(chalk.red(`Could not update config.\n`));
    process.exit(1);
  }
  writeConfig(updated);
  process.stdout.write(chalk.green(`✓ Unset ${key} (reverted to default)\n`));
}

export interface ConfigListOptions {
  output?: "text" | "json";
}

export async function cmdConfigList(opts: ConfigListOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  const cfg = readConfig();
  if (!cfg) {
    process.stderr.write(chalk.red(`Not logged in. Run \`zpl login\` first.\n`));
    process.exit(1);
  }

  const all = [...ALLOWED_KEYS, ...READONLY_KEYS];
  const entries = all.map((k) => ({ key: k, value: getNested(cfg, k) ?? "" }));

  if (output === "json") {
    process.stdout.write(
      JSON.stringify({ config_path: getConfigPath(), entries }, null, 2) + "\n",
    );
    return;
  }

  const table = new Table({
    head: [chalk.bold("Key"), chalk.bold("Value")],
    style: TABLE_STYLE,
    colWidths: [22, 56],
    wordWrap: true,
  });
  for (const e of entries) {
    const ro = (READONLY_KEYS as readonly string[]).includes(e.key);
    table.push([ro ? chalk.gray(e.key) : e.key, e.value]);
  }
  process.stdout.write(table.toString() + "\n");
  process.stdout.write(chalk.gray(`Config path: ${getConfigPath()}\n`));
  process.stdout.write(chalk.gray(`Read-only keys (grey): use \`zpl login\` or \`zpl repair\` instead of \`config set\`.\n`));
}

export async function cmdConfigEdit(): Promise<void> {
  if (!readConfig()) {
    process.stderr.write(chalk.red(`Not logged in. Run \`zpl login\` first.\n`));
    process.exit(1);
  }
  // EDITOR / VISUAL is the standard env var. Default to notepad on Windows
  // (always available) and nano elsewhere (more universal than vi for newcomers).
  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "nano");

  process.stdout.write(chalk.gray(`Opening ${getConfigPath()} in ${editor}…\n`));
  const child = spawn(editor, [getConfigPath()], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(chalk.red(`Could not launch editor: ${err.message}\n`));
      process.exitCode = 1;
      resolve();
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        process.stderr.write(chalk.yellow(`Editor exited with code ${code}.\n`));
      }
      // Re-read to validate the file is still parseable.
      const after = readConfig();
      if (!after) {
        process.stderr.write(
          chalk.red(
            `⚠ Config file is no longer parseable after editing. ` +
              `Run \`zpl repair\` to recover.\n`,
          ),
        );
        process.exitCode = 1;
      } else {
        process.stdout.write(chalk.green(`✓ Config saved.\n`));
      }
      resolve();
    });
  });
}
