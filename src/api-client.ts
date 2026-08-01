/**
 * Thin fetch wrapper around engine.zeropointlogic.io.
 * - Bearer auth from the stored config key.
 * - Retries 3x with exponential backoff on 5xx / network errors only.
 * - Never retries 4xx (auth failure must surface immediately).
 * - Translates 401/429/5xx into typed exceptions the command layer can format.
 * - Detects Cloudflare HTML interstitials (200 + text/html OR 4xx + HTML body)
 *   and surfaces ApiCloudflareError instead of crashing on res.json().
 */

import { USER_AGENT, readPkgVersion } from "./user-agent.js";

export interface ComputeRequest {
  d: number;
  bias: number;
  samples?: number;
}

export interface ComputeResponse {
  d: number;
  bias: number;
  p_output: number;
  ain: number;
  ain_status: string;
  deviation: number;
  status: string;
  samples: number;
  tokens_used: number;
  compute_ms: number;
}

export class ApiAuthError extends Error {
  constructor() {
    super("API key invalid. Run `zpl logout` then `zpl login`.");
    this.name = "ApiAuthError";
  }
}

/**
 * The plan's dimension ceiling was exceeded.
 *
 * AUDIT 2026-07-31: the engine emits four distinct causes behind 403 — see the
 * Display impl on AuthError in crates/zpl-api/src/auth.rs — and the CLI mapped
 * three of them to ApiAuthError. Measured against a local mock returning the
 * engine's own bodies:
 *
 *   API key not found or inactive        -> ApiAuthError   correct
 *   Dimension 25 exceeds plan limit of 9 -> ApiAuthError   wrong
 *   Token limit exceeded: 5123/5000      -> ApiNetworkError, after 4 attempts
 *   Internal server error                -> ApiAuthError   wrong
 *
 * So a Free user asking for d=25 was told "API key invalid. Run zpl logout then
 * zpl login." They log out, log back in, and it fails identically — their key
 * was never the problem.
 */
export class ApiDimensionError extends Error {
  public requested?: number;
  public max?: number;
  constructor(requested?: number, max?: number) {
    // No upgrade suggestion when the ceiling is already the engine's own
    // maximum. 100 is a hard constant in the engine, not a plan limit, and the
    // top plan grants exactly that — telling someone to buy their way past it
    // is advice no amount of money can follow. The same wrong sentence was
    // removed from both SDKs earlier in this audit.
    const detail =
      requested !== undefined && max !== undefined
        ? `Dimension ${requested} is above your plan's ceiling of ${max}.`
        : `That dimension is above your plan's ceiling.`;
    const advice =
      max !== undefined && max >= 100
        ? `100 is the engine's own maximum, so no plan goes higher — use a smaller dimension.`
        : `Use a smaller dimension, or raise the ceiling at https://zeropointlogic.io/pricing`;
    super(`${detail} ${advice}`);
    this.name = "ApiDimensionError";
    this.requested = requested;
    this.max = max;
  }
}

/**
 * The engine reported an internal failure behind a 403.
 *
 * AuthError::Db renders as "Internal server error" and every call site maps it
 * to FORBIDDEN, so a database outage arrives as a 403. Reporting that as a bad
 * key sends the user to wipe working credentials over a server problem they
 * cannot affect, and the credentials they replace will fail the same way.
 */
export class ApiEngineInternalError extends Error {
  constructor(detail?: string) {
    super(
      `The engine reported an internal error${detail ? `: ${detail}` : ""}. ` +
        `Your API key is fine — this is server-side. Try again shortly; if it persists, ` +
        `check https://zeropointlogic.io/status`,
    );
    this.name = "ApiEngineInternalError";
  }
}

export class ApiQuotaError extends Error {
  public resetAt?: string;
  constructor(resetAt?: string) {
    super(
      resetAt
        ? `Rate limit exceeded. Resets at ${resetAt}.`
        : `Rate limit exceeded. Try again shortly.`,
    );
    this.name = "ApiQuotaError";
    this.resetAt = resetAt;
  }
}

/**
 * Monthly token quota exhausted (engine 403 with body
 * "Token limit exceeded: X/Y used this month").
 *
 * Distinct from ApiAuthError so the user sees an upgrade prompt instead of
 * being told to run `zpl logout && zpl login` — which the pre-v1.1.4 CLI
 * did, sending users on a wild goose chase. (audit complet 12.05.)
 *
 * Distinct from ApiQuotaError (which is per-minute rate limiting and
 * suggests a short retry).
 */
export class ApiQuotaExhaustedError extends Error {
  public tokensUsed?: number;
  public tokensLimit?: number;
  constructor(tokensUsed?: number, tokensLimit?: number) {
    const usage =
      tokensUsed !== undefined && tokensLimit !== undefined
        ? ` (${tokensUsed} / ${tokensLimit} tokens used this month)`
        : "";
    super(
      [
        `Monthly ZPL Engine quota exceeded${usage}.`,
        ``,
        `Upgrade at https://zeropointlogic.io/pricing`,
        `  • Basic   $10/mo   10,000 tokens`,
        `  • Pro     $29/mo   50,000 tokens`,
        `  • GamePro $69/mo  150,000 tokens`,
        ``,
        `Or buy a one-off pack: https://zeropointlogic.io/dashboard/billing`,
        ``,
        `Your quota resets on the first of next month.`,
      ].join("\n"),
    );
    this.name = "ApiQuotaExhaustedError";
    this.tokensUsed = tokensUsed;
    this.tokensLimit = tokensLimit;
  }
}

export class ApiNetworkError extends Error {
  constructor(msg: string) {
    super(`Network error: ${msg}`);
    this.name = "ApiNetworkError";
  }
}

/**
 * Cloudflare returned an HTML challenge page instead of letting us through.
 * This usually means our User-Agent or IP got flagged. Surface a clear,
 * actionable error rather than crashing on `res.json()` against HTML.
 *
 * The cf-ray ID is gold for support — it lets the Cloudflare dashboard
 * locate the exact request and tell you which rule fired.
 */
export class ApiCloudflareError extends Error {
  public cfRay?: string;
  constructor(cfRay: string | undefined) {
    super(
      `Cloudflare blocked the request${cfRay ? ` (cf-ray: ${cfRay})` : ""}. ` +
        `If this persists, retry in a moment or report the cf-ray ID at zeropointlogic.io/support.`,
    );
    this.name = "ApiCloudflareError";
    this.cfRay = cfRay;
  }
}

/**
 * True if `body` looks like a Cloudflare challenge HTML page.
 * We check the first 500 chars to avoid hauling huge HTML into memory.
 */
export function looksLikeCloudflareHtml(body: string, contentType: string | null): boolean {
  if (contentType && contentType.toLowerCase().includes("text/html")) return true;
  const head = body.slice(0, 500).toLowerCase();
  return (
    head.includes("<!doctype html") ||
    head.includes("<html") ||
    head.includes("cf-mitigated") ||
    head.includes("just a moment") ||  // CF challenge title
    head.includes("attention required")  // CF block page
  );
}

export interface ApiClientOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  verbose?: boolean;
}

/**
 * How long to wait for each engine route, in milliseconds.
 *
 * AUDIT 2026-08-01: every deadline here used to sit BELOW the engine's own
 * ceiling for the same route - compute 15s against 30s, sweep 30s against 60s.
 * That ordering is the expensive way round. The engine deducts tokens before it
 * starts computing and refunds only when its own timeout or blocking task
 * fails; a client that gives up first leaves the request future to be dropped
 * on disconnect, with the deduction committed and no refund path reached.
 *
 * Measured: a sweep at d=48 with samples=50000 takes about 52 seconds
 * server-side - past the old 30s abort, inside the engine's 60s ceiling. Each
 * abandoned attempt cost 19 x 150 = 2850 tokens and returned nothing.
 *
 * Waiting past the engine turns that into a 504 the engine itself issues, which
 * does refund. Values are the engine's ceiling plus headroom for the network,
 * not round numbers - if the engine's ceilings move these have to move with
 * them, which is what the guard checks.
 */
const ENGINE_COMPUTE_CEILING_MS = 30_000;
const ENGINE_SWEEP_CEILING_MS = 60_000;
const NETWORK_HEADROOM_MS = 5_000;

// This client sends every route through one request() path, so it uses the
// slowest ceiling. The compute figure is kept for the guard, which checks both
// against the engine rather than trusting either number here.
export const DEADLINE_COMPUTE_MS = ENGINE_COMPUTE_CEILING_MS + NETWORK_HEADROOM_MS;
const DEADLINE_SWEEP_MS = ENGINE_SWEEP_CEILING_MS + NETWORK_HEADROOM_MS;

export class ApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly verbose: boolean;

  constructor(opts: ApiClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    // Clamp maxRetries to [0, 5]. Pre-v1.0.0 a typo like `maxRetries: 99999`
    // (or env var ZPL_MAX_RETRIES=-1 once we wire that up) could either spin
    // forever or short-circuit to no retries silently. 5 is enough headroom
    // for a flaky network without DOS-ing the engine on a real outage.
    const requested = opts.maxRetries ?? 3;
    this.maxRetries = Math.max(0, Math.min(5, Number.isFinite(requested) ? requested : 3));
    this.verbose = opts.verbose ?? false;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      // Cloudflare Bot Fight Mode 403s any non-Mozilla UA. The UA string
      // lives in src/user-agent.ts so api-client, device-flow, and diagnose
      // all use the SAME envelope — diagnose's "✓ engine reachable" then
      // actually predicts whether real requests will pass the WAF.
      "User-Agent": USER_AGENT,
      // ADR 0002 (zpl-engine-sdk/docs/adr/0002-x-zpl-client-headers.md):
      // structured client identity for engine telemetry. Independent of
      // User-Agent free text — middleware can reliably partition traffic
      // by X-ZPL-Client. Engine persists into usage_log.client_type /
      // .client_version when the engine-side change ships. Harmless until then.
      "X-ZPL-Client": "cli",
      "X-ZPL-Client-Version": readPkgVersion(),
    };
  }

  private log(msg: string): void {
    if (this.verbose) process.stderr.write(`[api] ${msg}\n`);
  }

  /**
   * Execute a request with retry. Retries transient failures (network + 5xx),
   * never retries 4xx — bad auth should surface immediately so the user can
   * re-run login rather than silently burning backoff time.
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.log(`${init.method ?? "GET"} ${url} (attempt ${attempt + 1})`);
      try {
        const res = await fetch(url, {
          ...init,
          headers: { ...this.headers(), ...(init.headers as Record<string, string> ?? {}) },
          // Sweep is the slowest route this client reaches, so the deadline is
          // set from the engine's 60s ceiling. A shorter one abandoned paid work.
          signal: AbortSignal.timeout(DEADLINE_SWEEP_MS),
        });

        // Auth errors are terminal — but 403 might also be a Cloudflare
        // challenge (retry / change UA) or a monthly quota exhaustion
        // (upgrade plan), which have totally different fixes from a real
        // auth failure (re-login). Inspect the body before deciding.
        if (res.status === 403) {
          const body = await res.text().catch(() => "");
          if (looksLikeCloudflareHtml(body, res.headers.get("content-type"))) {
            throw new ApiCloudflareError(res.headers.get("cf-ray") ?? undefined);
          }
          // Engine returns 403 with body "Token limit exceeded: X/Y used
          // this month" on monthly quota exhaustion. Surface as a distinct
          // error class so the user sees an upgrade prompt instead of
          // being told to re-login (which won't help). (audit 12.05.)
          if (/token limit exceeded/i.test(body)) {
            const m = body.match(/(\d+)\s*\/\s*(\d+)/);
            const used = m ? Number(m[1]) : undefined;
            const limit = m ? Number(m[2]) : undefined;
            throw new ApiQuotaExhaustedError(used, limit);
          }
          // The engine's other two 403 causes, which used to land on
          // ApiAuthError and send the user to re-authenticate over a plan
          // ceiling or a database outage. Matched on the engine's own wording:
          // "Dimension {d} exceeds plan limit of {max}" and "Internal server
          // error" (AuthError::Db).
          const dim = body.match(/dimension\s+(\d+)\s+exceeds\s+plan\s+limit\s+of\s+(\d+)/i);
          if (dim) {
            throw new ApiDimensionError(Number(dim[1]), Number(dim[2]));
          }
          if (/internal server error/i.test(body)) {
            throw new ApiEngineInternalError();
          }
          throw new ApiAuthError();
        }
        if (res.status === 401) throw new ApiAuthError();
        if (res.status === 429) {
          const reset = res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after") ?? undefined;
          throw new ApiQuotaError(reset);
        }

        // Transient 5xx → retry.
        if (res.status >= 500 && res.status < 600) {
          lastErr = new Error(`Engine returned ${res.status}`);
        } else if (!res.ok) {
          // Other 4xx: surface body. Detect HTML responses so we don't crash
          // trying to JSON.parse a Cloudflare interstitial down the line.
          const body = await res.text().catch(() => "");
          if (looksLikeCloudflareHtml(body, res.headers.get("content-type"))) {
            throw new ApiCloudflareError(res.headers.get("cf-ray") ?? undefined);
          }
          throw new Error(`Engine error ${res.status}: ${body.slice(0, 200) || res.statusText}`);
        } else {
          // Even a 200 can be HTML if the request never reached the engine
          // (Cloudflare interstitial returned 200 + HTML). Defend against it
          // before we feed HTML to JSON.parse.
          const ct = res.headers.get("content-type") ?? "";
          if (ct.toLowerCase().includes("text/html")) {
            // Drain body to release the connection cleanly, then surface CF.
            await res.text().catch(() => "");
            throw new ApiCloudflareError(res.headers.get("cf-ray") ?? undefined);
          }
          return (await res.json()) as T;
        }
      } catch (err) {
        // Cloudflare errors are terminal — retrying just hammers the same WAF.
        // The user has to either wait or change UA/IP; neither helps in a loop.
        //
        // AUDIT 2026-07-31: ApiQuotaExhaustedError was missing from this list.
        // It extends Error, not ApiQuotaError, so it fell through to `lastErr`,
        // the loop retried it, and after maxRetries the throw below rewrote it
        // as ApiNetworkError. Measured against a local mock returning the
        // engine's own 403 body:
        //
        //   quota exhausted -> ApiNetworkError, 4 engine hits, 3.5s
        //   message: "Network error: Monthly ZPL Engine quota exceeded (...)"
        //
        // So the careful quota handling added in the 12.05 audit could never
        // reach the user - `err instanceof ApiQuotaExhaustedError` was
        // unreachable outside this function - and a caller who is out of tokens
        // hammered the engine four times for a condition that does not clear.
        // The engine's rate limiter runs before key extraction, so those extra
        // attempts count against the per-IP limit as well.
        //
        // Everything here is terminal for the same reason: no amount of
        // retrying changes a plan ceiling, an exhausted quota, a bad key, or a
        // server that has already decided.
        if (
          err instanceof ApiAuthError ||
          err instanceof ApiQuotaError ||
          err instanceof ApiQuotaExhaustedError ||
          err instanceof ApiDimensionError ||
          err instanceof ApiEngineInternalError ||
          err instanceof ApiCloudflareError ||
          // AUDIT 2026-08-01: an aborted request is terminal. The engine charged
          // for the call before it started computing, so re-sending bills again
          // for work that may still be running. Same reasoning as the quota
          // classes above, and the more expensive case of the two.
          (err as Error)?.name === "TimeoutError" ||
          (err as Error)?.name === "AbortError"
        )
          throw err;
        lastErr = err as Error;
      }

      // Exponential backoff: 500ms, 1s, 2s (capped at 4s)
      if (attempt < this.maxRetries) {
        const delay = Math.min(500 * 2 ** attempt, 4000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw new ApiNetworkError(lastErr?.message ?? "unknown failure");
  }

  async compute(req: ComputeRequest): Promise<ComputeResponse> {
    return this.request<ComputeResponse>("/compute", {
      method: "POST",
      body: JSON.stringify({
        d: req.d,
        bias: req.bias,
        samples: req.samples ?? 1000,
      }),
    });
  }

  /**
   * Account endpoint — lives on ZPL Main (zeropointlogic.io), NOT on the
   * engine. v1.1.7: switched from `engine.zeropointlogic.io/api/user/me`
   * (which 404'd because the engine never shipped that route) to
   * `zeropointlogic.io/api/user/me` (added 2026-05-12).
   *
   * The new endpoint combines:
   *   - the user record (email, plan, role)
   *   - the engine.usage_log SUM for the current calendar month
   *   - the May 2026 promo tokensBonus
   * and returns ONE consistent number per field so `zpl whoami` and
   * `zpl quota` can render real values instead of "endpoint unavailable".
   *
   * Override with $ZPL_ACCOUNT_BASE_URL if you point at a staging copy.
   * Bare network/404 errors stay non-fatal — commands fall back to
   * config-only data so the CLI keeps working even when ZPL Main is down.
   */
  async me(): Promise<MeResponse | null> {
    const accountBase =
      process.env.ZPL_ACCOUNT_BASE_URL ??
      // Default = ZPL Main, NOT the engine.
      "https://zeropointlogic.io";

    try {
      const url = `${accountBase.replace(/\/$/, "")}/api/user/me`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) throw new ApiAuthError();
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) return null;
      return (await res.json()) as MeResponse;
    } catch (err) {
      if (err instanceof ApiAuthError) throw err;
      return null;
    }
  }
}

/** Shape returned by zeropointlogic.io/api/user/me (added 2026-05-12). */
export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    plan: string;
    plan_name: string;
    created_at: string | null;
  };
  tokens: {
    remaining: number;
    used_this_month: number;
    monthly_quota: number;
    bonus_balance: number;
    total_available_this_cycle: number;
    percent_used: number;
    /**
     * How the usage figure above was obtained.
     *
     * AUDIT 2026-07-31: `engine_user_not_found` was added server-side because
     * the branch that produces it used to report `engine_log` with a zero,
     * without having read anything — indistinguishable from a real zero. Only
     * `engine_log` means the number was actually measured.
     */
    source: "engine_log" | "engine_user_not_found" | "user_table_fallback";
  };
  limits: {
    max_d: number;
    max_keys: number;
    grpc_calls_per_minute: number;
  };
  pricing: {
    monthly_usd: number;
  };
}
