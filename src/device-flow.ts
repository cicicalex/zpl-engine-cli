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

export const DEFAULT_SITE = process.env.ZPL_SITE ?? "https://zeropointlogic.io";
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MAX_INTERVAL_MS = 10_000;

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
 */
export function openInBrowser(url: string): void {
  try {
    const plat = platform();
    if (plat === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
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
    headers: { "Content-Type": "application/json", "User-Agent": "zpl-cli/0.1.0" },
    body: JSON.stringify({ client: "cli", device_name: deviceName }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
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
    interval_s: Math.max(1, Math.min(30, data.interval_s ?? 2)),
    expires_at: data.expires_at ?? new Date(Date.now() + POLL_TIMEOUT_MS).toISOString(),
  };
}

async function pollOnce(site: string, deviceCode: string): Promise<StatusResponse> {
  const url = `${site}/api/auth/cli/status?device_code=${encodeURIComponent(deviceCode)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "zpl-cli/0.1.0" },
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
  const intervalMs = Math.min(POLL_MAX_INTERVAL_MS, start.interval_s * 1000);
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
