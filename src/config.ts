/**
 * Read/write ~/.zpl/config.toml. Mode 0600 on POSIX; best-effort on Windows.
 *
 * We hand-roll a tiny TOML writer/reader instead of pulling @iarna/toml because
 * the schema is trivial (string scalars under three flat tables) and every
 * extra dep is extra surface area for `npx zpl-engine-cli login`.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { validateEngineUrl, DEFAULT_ENGINE_URL, EngineUrlError } from "./engine-url-validate.js";
import { isValidApiKeyFormat, isServiceKey } from "./api-key-format.js";

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
  // AUDIT 2026-05-14 (HIGH): write atomically via tmp + fsync + rename.
  // Pre-fix `writeFileSync(path, body)` could leave a truncated file on
  // disk if the process was killed mid-write (Ctrl-C, OOM, parent died).
  // Next `zpl whoami` then read a half-formed config — and worse, a
  // partially-written API key string sat there for any local attacker to
  // read with looser perms than the final 0600 chmod was supposed to set.
  // tmp+fsync+rename is POSIX-atomic for the path swap.
  const tmpPath = path + ".tmp";
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeFileSync(fd, body, { encoding: "utf-8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // chmod tmp before rename (Windows ACL is set on the rename target, but
  // POSIX honours the openSync mode so this is belt-and-suspenders).
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Windows NTFS: no-op
  }
  renameSync(tmpPath, path);
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
  // v1.1.2 BUG #2 FIX: pre-1.1.2 the parser required `[auth]`/`[engine]`/`[defaults]`
  // section headers — only its OWN writeConfig output. But zpl-engine-mcp
  // setup.ts writes a FLAT TOML (api_key/user_email/created_at at top level
  // with no section header), and both packages use ~/.zpl/config.toml as the
  // shared credential store. So a user who set up via `npx zpl-engine-mcp setup`
  // could not use ANY CLI command — `readConfig()` returned null and CLI said
  // "Not logged in".
  //
  // Fix: keys without a section header land in a synthetic "auth" section
  // (the most common case for flat-format configs). Sectioned configs keep
  // working unchanged. Verified compatible with both formats.
  let current = "auth"; // default section so flat configs work
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
    if (kv) {
      const [, k, v] = kv;
      sections[current] = sections[current] ?? {};
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
 * Warn the user if config.toml is world-readable (POSIX only — Windows NTFS
 * doesn't have these perm bits). On Linux/macOS, mode 0o600 means the file
 * can only be read by its owner; a chmod 644 would expose your API key to
 * other accounts on a shared box.
 *
 * We warn but DO NOT auto-chmod — the user may have intentionally set
 * permissions for a reason. Better to surface the issue and let them decide.
 */
function warnIfConfigPermissionsTooOpen(path: string): void {
  if (platform() === "win32") return; // NTFS doesn't have POSIX bits
  try {
    const st = statSync(path);
    const perms = st.mode & 0o777;
    // Anything beyond owner-read+write is too permissive for a credentials file.
    if (perms & 0o077) {
      process.stderr.write(
        `[33m⚠ Warning: ${path} permissions are ${perms.toString(8).padStart(4, "0")} ` +
          `(should be 0600 to keep your API key private).[0m\n` +
          `[90m   Fix: chmod 600 "${path}"[0m\n`,
      );
    }
  } catch {
    // Stat failed — defensive, just skip the check.
  }
}

/**
 * Validate + normalise the engine base URL via the host allowlist. Pre-v1
 * we accepted any URL on faith, which meant a corrupt config or hostile
 * env var could redirect Bearer-token traffic to attacker.com. Now we
 * reject anything not on the allowlist (default: *.zeropointlogic.io).
 *
 * Returns the cleaned URL or throws. We treat URL failure as a fatal config
 * error (exit on use) — silently falling back to the default would mask a
 * real attack.
 */
function safeEngineBaseUrl(raw: string | undefined): string {
  const candidate = raw?.trim() || DEFAULT_ENGINE_URL;
  try {
    return validateEngineUrl(candidate);
  } catch (err) {
    if (err instanceof EngineUrlError) {
      // Surface the rejection to stderr so the user sees WHY their URL was
      // overridden, then fall back to the production default. We DO fall back
      // (rather than crash) so a misconfigured ZPL_ENGINE_URL doesn't brick
      // every command — the user can still get work done while they fix it.
      process.stderr.write(
        `[31m✗ Insecure engine URL ignored: ${err.message}[0m\n` +
          `[90m   Falling back to ${DEFAULT_ENGINE_URL}[0m\n`,
      );
    }
    return DEFAULT_ENGINE_URL;
  }
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
 * v1.0.0 security:
 *   - ZPL_API_KEY is trimmed and format-validated; bogus values fail loud
 *     instead of producing a 401 from the engine 30 seconds later.
 *   - engine.base_url is run through validateEngineUrl on BOTH paths to
 *     defend against hostile env vars / config files.
 *   - On POSIX, config.toml mode is checked and the user is warned if it's
 *     world-readable.
 */
export function requireConfig(): ZplConfig {
  // Env var fallback first — explicit override beats whatever's on disk.
  const envKey = process.env.ZPL_API_KEY?.trim();
  if (envKey) {
    // Reject service keys (server-side only) and malformed env vars BEFORE
    // they reach the Authorization header. A typo'd env key surfaces here
    // with an actionable error instead of a confusing 401 from the engine.
    if (isServiceKey(envKey)) {
      const err = new Error(
        "ZPL_API_KEY is a service key (zpl_s_*). CLI requires a user key (zpl_u_*). " +
          "Get one from `zpl login` or zeropointlogic.io/dashboard/api-keys.",
      );
      (err as NodeJS.ErrnoException).code = "EBADKEY";
      throw err;
    }
    if (!isValidApiKeyFormat(envKey)) {
      const err = new Error(
        "ZPL_API_KEY does not match the expected format " +
          "(zpl_u_<48 hex> or zpl_u_<prefix>_<48 hex>). " +
          "Check for trailing whitespace or stray characters.",
      );
      (err as NodeJS.ErrnoException).code = "EBADKEY";
      throw err;
    }
    return {
      auth: {
        api_key: envKey,
        user_email: process.env.ZPL_USER_EMAIL?.trim() || "env@local",
        created_at: new Date(0).toISOString(), // sentinel — "from env, not file"
      },
      engine: {
        base_url: safeEngineBaseUrl(process.env.ZPL_ENGINE_URL),
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

  // POSIX permission check — only warn, don't auto-fix or refuse to load.
  warnIfConfigPermissionsTooOpen(getConfigPath());

  // Validate the URL the user has on disk. If it was hijacked by an attacker
  // (or just typo'd), fall back to the production default with a stderr
  // warning. The auth + defaults sections are kept as-is.
  return {
    ...cfg,
    engine: {
      base_url: safeEngineBaseUrl(cfg.engine.base_url),
    },
  };
}

// Re-export for tests / diagnostics.
export { dirname };
