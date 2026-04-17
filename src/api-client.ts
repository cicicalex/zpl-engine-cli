/**
 * Thin fetch wrapper around engine.zeropointlogic.io.
 * - Bearer auth from the stored config key.
 * - Retries 3x with exponential backoff on 5xx / network errors only.
 * - Never retries 4xx (auth failure must surface immediately).
 * - Translates 401/429/5xx into typed exceptions the command layer can format.
 */

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

export class ApiNetworkError extends Error {
  constructor(msg: string) {
    super(`Network error: ${msg}`);
    this.name = "ApiNetworkError";
  }
}

export interface ApiClientOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  verbose?: boolean;
}

export class ApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly verbose: boolean;

  constructor(opts: ApiClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 3;
    this.verbose = opts.verbose ?? false;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      // Cloudflare Bot Fight Mode 403s any non-Mozilla UA. Keep this in
      // lockstep with device-flow.ts USER_AGENT and mcp/src/setup.ts.
      "User-Agent":
        "Mozilla/5.0 (compatible; zpl-engine-cli/0.1.2; +https://github.com/cicicalex/zpl-engine-cli)",
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
          signal: AbortSignal.timeout(20_000),
        });

        // Auth errors are terminal.
        if (res.status === 401 || res.status === 403) throw new ApiAuthError();
        if (res.status === 429) {
          const reset = res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after") ?? undefined;
          throw new ApiQuotaError(reset);
        }

        // Transient 5xx → retry.
        if (res.status >= 500 && res.status < 600) {
          lastErr = new Error(`Engine returned ${res.status}`);
        } else if (!res.ok) {
          // Other 4xx: surface body.
          const body = await res.text().catch(() => "");
          throw new Error(`Engine error ${res.status}: ${body.slice(0, 200) || res.statusText}`);
        } else {
          return (await res.json()) as T;
        }
      } catch (err) {
        if (err instanceof ApiAuthError || err instanceof ApiQuotaError) throw err;
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
   * Optional account endpoint — may not exist yet on the backend.
   * Commands should treat a network/404 error here as non-fatal and fall back to config-only data.
   */
  async me(): Promise<{ email: string; plan: string; quota_used?: number; quota_limit?: number } | null> {
    try {
      return await this.request("/api/user/me", { method: "GET" });
    } catch (err) {
      if (err instanceof ApiAuthError) throw err;
      return null;
    }
  }
}
