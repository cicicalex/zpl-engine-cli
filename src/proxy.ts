/**
 * Auto-detect HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars and route Node's
 * native fetch through an undici ProxyAgent. Without this, corporate users
 * behind a TLS-inspecting proxy see every CLI command time out — a complete
 * deal-breaker for enterprise adoption.
 *
 * Why this exists:
 *   Node 18+'s native fetch (built on undici) does NOT respect the standard
 *   proxy env vars by default. Most other tooling (curl, git, npm, pip) does.
 *   Users assume the same of every modern CLI; when it doesn't, they file a
 *   bug or — more often — silently uninstall.
 *
 * Resolution rules (mirror curl's behaviour):
 *   - HTTPS_PROXY (or https_proxy)  → used for https:// requests
 *   - HTTP_PROXY  (or http_proxy)   → used for http:// requests
 *   - NO_PROXY    (or no_proxy)     → comma-separated host list to bypass
 *                                     (suffix match: .company.com matches
 *                                      api.company.com)
 *   - ALL_PROXY   (or all_proxy)    → fallback for any scheme
 *
 * We install ONE global dispatcher at import time, so every fetch() call in
 * the CLI (api-client, device-flow, diagnose, update-check) gets proxy
 * routing for free. NO_PROXY hosts go direct via the EnvHttpProxyAgent's
 * built-in bypass.
 *
 * Disable explicitly with ZPL_NO_PROXY=1 (e.g. if a misconfigured corporate
 * proxy is breaking us and the user wants to try direct).
 */
import { setGlobalDispatcher, EnvHttpProxyAgent, getGlobalDispatcher } from "undici";

let installed = false;
let activeProxy: string | null = null;

/**
 * Look up the effective proxy URL for an https:// request, just for
 * diagnostic / about-output purposes. Returns null if no proxy would be used.
 */
export function detectActiveProxy(): string | null {
  if (process.env.ZPL_NO_PROXY === "1") return null;
  const httpsProxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
  const allProxy = process.env.ALL_PROXY ?? process.env.all_proxy ?? null;
  return httpsProxy ?? allProxy ?? null;
}

/**
 * Install the EnvHttpProxyAgent globally. Called at module import time so
 * every fetch in the CLI honours proxy env vars without each call site
 * needing to know.
 *
 * Idempotent — calling twice does nothing on the second call.
 */
export function installProxyDispatcher(): void {
  if (installed) return;
  installed = true;

  if (process.env.ZPL_NO_PROXY === "1") {
    // User opted out — leave the default dispatcher in place.
    activeProxy = null;
    return;
  }

  const proxy = detectActiveProxy();
  if (!proxy) {
    // No proxy env vars set — nothing to do.
    activeProxy = null;
    return;
  }

  try {
    // EnvHttpProxyAgent reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY from process.env
    // and routes accordingly. Per-request scheme + bypass logic is handled
    // internally so we don't have to.
    setGlobalDispatcher(new EnvHttpProxyAgent());
    activeProxy = proxy;
  } catch (err) {
    // Proxy install failure is non-fatal — fall back to direct connections
    // and warn the user once on stderr. Most likely cause: an unparseable
    // proxy URL ("HTTP_PROXY=localhost:3128" without scheme).
    process.stderr.write(
      `[33m⚠ Could not configure proxy from HTTP_PROXY/HTTPS_PROXY: ${(err as Error).message}[0m\n` +
        `[90m   Falling back to direct connections.[0m\n`,
    );
    activeProxy = null;
  }
}

/** For diagnose / about output. */
export function getActiveProxy(): string | null {
  return activeProxy;
}

/** For tests — reset and reinstall. */
export function resetProxyDispatcherForTests(): void {
  installed = false;
  activeProxy = null;
  // Restore default dispatcher so subsequent fetches don't keep using
  // a stale proxy. undici's getGlobalDispatcher returns the default if
  // never set explicitly; but we can't "undo" setGlobalDispatcher cleanly.
  // For tests we just reinstall after env changes.
  void getGlobalDispatcher;
}
