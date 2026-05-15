/**
 * RFC-8628-shaped device flow client for ZPL.
 *
 * Sequence:
 *   1. POST /api/auth/cli/start → device_code + user_code + interval_s
 *   2. Open verification_uri_complete in default browser (best-effort, never throws)
 *   3. Poll GET /api/auth/cli/status?device_code=… at interval_s cadence
 *   4. On status=approved return { api_key, user_email, user_plan }
 *
 * Timeout: 10 min hard cap (matches server-side expiry). Transient 5xx during
 * polling does not abort the flow — we keep polling until the deadline.
 *
 * Adapted from mcp/src/setup.ts so the two clients stay in lockstep.
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { USER_AGENT } from "./user-agent.js";

/**
 * Re-exec via `npx -y zpl-engine-cli@latest` and exit. Called when the
 * backend returns 426 Upgrade Required. Stdio is inherited so the new
 * wizard takes over the user's terminal seamlessly.
 *
 * Env override: ZPL_SKIP_AUTOUPGRADE=1 disables this and falls through
 * to a manual upgrade instruction. Default is always to auto-promote.
 *
 * Forwards a conservative subset of the original argv (only known
 * flags) to avoid argv injection from a hostile parent shell.
 */
async function reexecAsLatest(originalArgs: string[]): Promise<never> {
  if (process.env.ZPL_SKIP_AUTOUPGRADE === "1") {
    process.stderr.write(
      "[autoupgrade] ZPL_SKIP_AUTOUPGRADE=1 set — refusing to self-upgrade.\n" +
        "[autoupgrade] Run manually: npx -y zpl-engine-cli@latest setup\n",
    );
    process.exit(1);
  }
  // Forward only known subcommands/flags. Anything else is dropped.
  const ALLOWED_FLAGS = new Set([
    "--force", "--yes", "-y", "--help", "-h", "--version", "-v",
  ]);
  const ALLOWED_SUBCOMMANDS = new Set([
    "setup", "login", "logout", "whoami", "compute", "plans", "quota",
    "check", "diagnose", "consistency", "about",
  ]);
  const forwarded: string[] = [];
  for (const a of originalArgs) {
    if (ALLOWED_SUBCOMMANDS.has(a) || ALLOWED_FLAGS.has(a)) {
      forwarded.push(a);
    }
  }
  const cmd = platform() === "win32" ? "npx.cmd" : "npx";
  const args = ["-y", "zpl-engine-cli@latest", ...forwarded];

  await new Promise<void>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: platform() === "win32",
    });
    child.on("close", (code) => {
      process.exit(typeof code === "number" ? code : 1);
      resolve();
    });
    child.on("error", (err) => {
      process.stderr.write(
        `[autoupgrade] Failed to spawn npx: ${(err as Error).message}\n` +
          `[autoupgrade] Run manually: npx -y zpl-engine-cli@latest setup\n`,
      );
      process.exit(1);
      resolve();
    });
  });
  // unreachable
  process.exit(1);
}

export const DEFAULT_SITE = process.env.ZPL_SITE ?? "https://zeropointlogic.io";
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MAX_INTERVAL_MS = 10_000;
/** RFC 8628 §3.5 says polling SHOULD be at least 5s. We allow 3s as a
 *  reasonable lower bound (most servers behave fine with that), but we
 *  refuse to poll faster than that even if the server returns 1. */
const POLL_MIN_INTERVAL_MS = 3_000;

export interface StartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval_s: number;
  expires_at: string;
}

export interface StatusApproved {
  status: "approved";
  api_key: string;
  user_email: string;
  user_plan?: string;
  client?: string;
}

export interface StatusPending {
  status: "pending" | "approved_consumed";
}

export interface StatusDenied {
  status: "denied" | "expired";
  reason?: string;
}

export type StatusResponse = StatusApproved | StatusPending | StatusDenied;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort open a URL in the user's default browser. Shells out to
 * start/open/xdg-open so we don't need the `open` npm dep.
 *
 * AUDIT 2026-05-14 (HIGH): the Windows branch used `cmd /c start "" <url>`
 * which lets cmd.exe interpret `&`, `|`, `^`, `>` in the URL as shell
 * metacharacters. Pre-fix:
 *   - Legitimate URL containing `&` (query separator) was truncated.
 *   - A compromised CDN or MITM injecting `&calc.exe` after the legit URL
 *     would launch arbitrary processes.
 * Now: validate the URL is a real https:// URL with a known host before
 * passing it to cmd, and use rundll32 which doesn't parse the URL through
 * the shell — it goes straight to ShellExecute via the URL protocol
 * handler.
 */
const SAFE_HOST_SUFFIXES = ["zeropointlogic.io"];
function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return SAFE_HOST_SUFFIXES.some(
      (base) => u.hostname === base || u.hostname.endsWith("." + base),
    );
  } catch {
    return false;
  }
}

export function openInBrowser(url: string): void {
  if (!isSafeUrl(url)) {
    // Refuse to launch anything for an unsafe URL — caller already prints
    // it for manual paste, the user sees the URL but no process spawns.
    return;
  }
  try {
    const plat = platform();
    if (plat === "win32") {
      // rundll32 url.dll,FileProtocolHandler bypasses cmd.exe parsing
      // entirely. The URL is passed directly to ShellExecute, which
      // treats it as a single argument to the registered handler.
      spawn(
        "rundll32",
        ["url.dll,FileProtocolHandler", url],
        { detached: true, stdio: "ignore" },
      ).unref();
    } else if (plat === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Silently ignore — caller prints the URL for manual paste.
  }
}

export async function startDeviceFlow(site: string, deviceName: string): Promise<StartResponse> {
  const res = await fetch(`${site}/api/auth/cli/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client: "cli", device_name: deviceName }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Server-side force-update gate. If we're below the configured
    // minimum, the backend returns 426 with the upgrade command.
    // Re-exec via npx@latest so the user doesn't copy-paste anything.
    if (res.status === 426) {
      const body = (await res.json().catch(() => ({}))) as {
        upgrade_command?: string;
        minimum_version?: string;
        current_version?: string;
        message?: string;
      };
      process.stderr.write(
        `\nzpl-engine-cli v${body.current_version ?? ""} is below the supported floor (v${body.minimum_version ?? ""}).\n`,
      );
      if (body.message) process.stderr.write(`${body.message}\n`);
      process.stderr.write(`Auto-upgrading via ${body.upgrade_command ?? "npx -y zpl-engine-cli@latest"}…\n\n`);
      await reexecAsLatest(process.argv.slice(2));
      process.exit(1); // unreachable; safety net
    }
    const body = await res.text().catch(() => "");
    throw new Error(`Could not start login (${res.status}). ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as Partial<StartResponse>;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error("Auth server returned an unexpected response. Try again.");
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    verification_uri_complete: data.verification_uri_complete,
    // Server suggests interval, but we floor at POLL_MIN_INTERVAL_MS to
    // protect the engine from accidental DOS (e.g. server bug returns 0)
    // and ceiling at 30s so the user's terminal doesn't sit "frozen" too
    // long between polls.
    interval_s: Math.max(POLL_MIN_INTERVAL_MS / 1000, Math.min(30, data.interval_s ?? 5)),
    expires_at: data.expires_at ?? new Date(Date.now() + POLL_TIMEOUT_MS).toISOString(),
  };
}

async function pollOnce(site: string, deviceCode: string): Promise<StatusResponse> {
  const url = `${site}/api/auth/cli/status?device_code=${encodeURIComponent(deviceCode)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  // 429 = we polled too fast. Sleep one cycle and try again.
  if (res.status === 429) return { status: "pending" };
  // Transient 5xx → treat as pending so the outer loop keeps going.
  if (res.status >= 500) return { status: "pending" };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Auth status returned ${res.status}. ${body.slice(0, 200)}`);
  }
  return (await res.json()) as StatusResponse;
}

export interface WaitOptions {
  onTick?: (secondsLeft: number) => void;
}

export async function waitForApproval(
  site: string,
  start: StartResponse,
  opts: WaitOptions = {},
): Promise<StatusApproved> {
  // Defence in depth: even if startDeviceFlow's clamp was bypassed somehow,
  // never poll faster than POLL_MIN_INTERVAL_MS to protect engine.
  const intervalMs = Math.max(
    POLL_MIN_INTERVAL_MS,
    Math.min(POLL_MAX_INTERVAL_MS, start.interval_s * 1000),
  );
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let status: StatusResponse;
    try {
      status = await pollOnce(site, start.device_code);
    } catch {
      // Transient error — keep polling until deadline.
      continue;
    }
    if (status.status === "approved") return status as StatusApproved;
    if (status.status === "denied") throw new Error("Authorization denied.");
    if (status.status === "expired") throw new Error("Login timed out.");
    opts.onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    // pending / approved_consumed → loop
  }

  throw new Error("Login timed out (10 min). Run: zpl login");
}

export function buildApproveUrl(start: StartResponse): string {
  if (start.verification_uri_complete) return start.verification_uri_complete;
  const sep = start.verification_uri.includes("?") ? "&" : "?";
  return `${start.verification_uri}${sep}code=${encodeURIComponent(start.user_code)}`;
}
