/**
 * Read/write ~/.zpl/config.toml. Mode 0600 on POSIX; best-effort on Windows.
 *
 * We hand-roll a tiny TOML writer/reader instead of pulling @iarna/toml because
 * the schema is trivial (string scalars under three flat tables) and every
 * extra dep is extra surface area for `npx zpl-engine-cli login`.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface ZplConfig {
  auth: {
    api_key: string;
    user_email: string;
    created_at: string;
  };
  engine: {
    base_url: string;
  };
  defaults: {
    model: string;
  };
}

export function getConfigDir(): string {
  return join(homedir(), ".zpl");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.toml");
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows NTFS: no-op
  }
}

/** Escape a value for TOML basic-string literal context. */
function tomlString(v: string): string {
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

export function writeConfig(cfg: ZplConfig): void {
  ensureConfigDir();
  const path = getConfigPath();
  const body =
    `# zpl-engine-cli config. mode 600. Do not share.\n` +
    `\n` +
    `[auth]\n` +
    `api_key = ${tomlString(cfg.auth.api_key)}\n` +
    `user_email = ${tomlString(cfg.auth.user_email)}\n` +
    `created_at = ${tomlString(cfg.auth.created_at)}\n` +
    `\n` +
    `[engine]\n` +
    `base_url = ${tomlString(cfg.engine.base_url)}\n` +
    `\n` +
    `[defaults]\n` +
    `model = ${tomlString(cfg.defaults.model)}\n`;
  writeFileSync(path, body, { encoding: "utf-8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows NTFS: no-op
  }
}

export function readConfig(): ZplConfig | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return parseToml(raw);
}

export function deleteConfig(): boolean {
  const path = getConfigPath();
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal TOML reader for our flat schema: [section] key = "string" lines.
 * Does not support arrays, nested tables, dotted keys, or multiline strings.
 * Any line we can't parse is silently skipped — the reader is defensive.
 */
function parseToml(src: string): ZplConfig | null {
  const sections: Record<string, Record<string, string>> = {};
  let current = "";
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      current = sec[1]!.trim();
      sections[current] = sections[current] ?? {};
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (kv && current) {
      const [, k, v] = kv;
      sections[current]![k!] = v!
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  const auth = sections["auth"];
  const engine = sections["engine"];
  const defaults = sections["defaults"];
  if (!auth?.api_key || !auth?.user_email) return null;
  return {
    auth: {
      api_key: auth.api_key,
      user_email: auth.user_email,
      created_at: auth.created_at ?? new Date().toISOString(),
    },
    engine: {
      base_url: engine?.base_url ?? "https://engine.zeropointlogic.io",
    },
    defaults: {
      model: defaults?.model ?? "claude-haiku-4-5",
    },
  };
}

/**
 * Throws with a user-friendly message if no usable credentials are present.
 *
 * Resolution order (highest precedence first):
 *   1. ZPL_API_KEY environment variable — for CI / Docker / one-off scripts
 *      where running an interactive `zpl login` doesn't fit. The email is
 *      faked to "env@local" so commands that print "logged in as X" don't
 *      crash; engine endpoints that need a real email will still 401, which
 *      is the correct behaviour.
 *   2. ~/.zpl/config.toml on disk — what `zpl login` writes.
 *
 * v1.0.0 added the env var fallback. Pre-v1 a CI run had to either ship a
 * pre-baked config.toml (annoying) or run `zpl login` (impossible in
 * non-interactive). Now `ZPL_API_KEY=zpl_u_... zpl pipe` Just Works.
 */
export function requireConfig(): ZplConfig {
  // Env var fallback first — explicit override beats whatever's on disk.
  const envKey = process.env.ZPL_API_KEY?.trim();
  if (envKey) {
    return {
      auth: {
        api_key: envKey,
        user_email: process.env.ZPL_USER_EMAIL?.trim() || "env@local",
        created_at: new Date(0).toISOString(), // sentinel — "from env, not file"
      },
      engine: {
        base_url: process.env.ZPL_ENGINE_URL?.trim() || "https://engine.zeropointlogic.io",
      },
      defaults: {
        model: process.env.ZPL_DEFAULT_MODEL?.trim() || "claude-haiku-4-5",
      },
    };
  }

  const cfg = readConfig();
  if (!cfg) {
    const err = new Error(
      "Not logged in. Run `zpl login` first, or set ZPL_API_KEY env var (CI/Docker).",
    );
    (err as NodeJS.ErrnoException).code = "ENOCONFIG";
    throw err;
  }
  return cfg;
}

// Re-export for tests / diagnostics.
export { dirname };
