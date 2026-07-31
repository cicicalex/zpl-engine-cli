/**
 * Engine URL validation — defence against config-file or env-var hijack.
 *
 * Threat model:
 *   - Attacker writes `~/.zpl/config.toml` with `engine.base_url = "http://evil.com"`
 *   - Or sets `ZPL_ENGINE_URL=http://attacker:8080` in a CI shell
 *   - User's API key gets POSTed (Authorization: Bearer ...) to attacker's
 *     server → key stolen → quota burned, paid plans charged on attacker's
 *     workload, possibly identity escalation.
 *
 * Defences enforced here:
 *   1. Scheme MUST be https (rejects http://, file://, data:, etc.)
 *   2. Host MUST be in ENGINE_HOST_ALLOWLIST. Defaults to *.zeropointlogic.io
 *      so a typo in config.toml ("zeropointlogc.io") is caught.
 *   3. No userinfo (no `https://user:pass@host/...`) — strips creds from URL.
 *   4. No URL fragment / query — engine endpoints don't use them.
 *
 * Self-hosters can extend the allowlist via ZPL_ENGINE_HOST_ALLOWLIST
 * (comma-separated). This is documented as an explicit opt-in in the README.
 */

const DEFAULT_ALLOWED_HOSTS = [
  "engine.zeropointlogic.io",
  // Staging + dev, useful during MCP/CLI release rehearsal.
  "engine-staging.zeropointlogic.io",
  "engine-dev.zeropointlogic.io",
  // Localhost variants — only valid when ZPL_ALLOW_LOCALHOST=1 (see below).
];

const LOCALHOST_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * v1.1.1 ALIGNMENT: env var renamed from ZPL_ALLOW_LOCALHOST to
 * ZPL_ENGINE_ALLOW_INSECURE_LOCAL so CLI + MCP use IDENTICAL env var
 * names. The old name is still honoured for backwards compatibility
 * with anyone who set it during the v1.0/v1.1.0 window.
 */
function localhostAllowed(): boolean {
  return (
    process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL === "1" ||
    process.env.ZPL_ALLOW_LOCALHOST === "1"
  );
}

export class EngineUrlError extends Error {
  constructor(reason: string, url: string) {
    super(`Refusing to use engine URL "${url}": ${reason}`);
    this.name = "EngineUrlError";
  }
}

/** Read the optional ZPL_ENGINE_HOST_ALLOWLIST comma-separated env var. */
function readEnvAllowlist(): string[] {
  const raw = process.env.ZPL_ENGINE_HOST_ALLOWLIST?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function effectiveAllowlist(): string[] {
  const list = [...DEFAULT_ALLOWED_HOSTS, ...readEnvAllowlist()];
  // Localhost only allowed if user explicitly opts in. Useful for engine devs
  // running a local instance, but never the default — a typo can't accidentally
  // route traffic to localhost where another process might intercept it.
  if (localhostAllowed()) {
    list.push(...LOCALHOST_HOSTS);
  }
  return list.map((h) => h.toLowerCase());
}

/**
 * Validate + normalise an engine base URL. Throws EngineUrlError if the URL
 * is not safe to send Bearer tokens to. Returns the cleaned URL (no trailing
 * slash, no userinfo, no query, no fragment).
 *
 * Idempotent: calling twice on a clean URL returns the same string.
 */
export function validateEngineUrl(raw: string): string {
  if (!raw || typeof raw !== "string") {
    throw new EngineUrlError("URL is empty or not a string", String(raw));
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EngineUrlError("not a parseable URL", raw);
  }

  // AUDIT 2026-07-31: this check used to be unconditional, and it runs before
  // the allowlist below — so ZPL_ENGINE_ALLOW_INSECURE_LOCAL could never allow
  // anything insecure. localhostAllowed() only adds hostnames to the allowlist,
  // and the allowlist is reached only by URLs that already passed as https, so
  // the one thing the flag exists to permit was rejected two checks earlier.
  //
  // The variable was renamed in v1.1.1 specifically so the CLI and the MCP
  // would share it. The MCP honours it:
  //
  //     if (u.protocol === "http:" && isLocal && ...ALLOW_INSECURE_LOCAL === "1") return;
  //
  // The alignment was done on the name and never on the behaviour, so the same
  // documented flag worked in one client and was dead in the other. Anyone
  // running a local engine - which serves http - could point the MCP at it and
  // not the CLI, and the CLI's own error told them to use https, which a local
  // engine does not speak.
  //
  // Verified by running the built CLI both ways before and after.
  const isLocalHost = LOCALHOST_HOSTS.includes(url.hostname.toLowerCase());
  const localHttpPermitted =
    url.protocol === "http:" && isLocalHost && localhostAllowed();

  if (url.protocol !== "https:" && !localHttpPermitted) {
    throw new EngineUrlError(
      url.protocol === "http:" && isLocalHost
        ? `scheme must be https, got "${url.protocol}". For a local engine set ` +
          `ZPL_ENGINE_ALLOW_INSECURE_LOCAL=1 — the same variable the MCP uses.`
        : `scheme must be https, got "${url.protocol}". HTTP would expose the API key in plain text.`,
      raw,
    );
  }

  if (url.username || url.password) {
    throw new EngineUrlError(
      `URL must not contain userinfo (https://user:pass@host) — credentials in URLs end up in logs.`,
      raw,
    );
  }

  const host = url.hostname.toLowerCase();
  const allowlist = effectiveAllowlist();
  if (!allowlist.includes(host)) {
    throw new EngineUrlError(
      `host "${host}" is not in the allowlist (${allowlist.join(", ")}). ` +
        `Self-hosters: set ZPL_ENGINE_HOST_ALLOWLIST="your-host.com" to add it.`,
      raw,
    );
  }

  // Build a clean URL: scheme + host[:port] + pathname (trim trailing /).
  // No search, no hash, no userinfo.
  const cleaned = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return cleaned;
}

/** Defaults are always safe to use without going through validateEngineUrl. */
export const DEFAULT_ENGINE_URL = "https://engine.zeropointlogic.io";
