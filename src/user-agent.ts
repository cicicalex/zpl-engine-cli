/**
 * Shared User-Agent string for ALL outbound HTTP from the CLI.
 *
 * Why this lives in its own module: pre-v1.0.0 we had three independent UA
 * strings — one in api-client.ts, one in device-flow.ts, and one in
 * commands/diagnose.ts. Diagnose's UA was different from the real one, which
 * meant diagnose could report "Engine reachable: ✓" while every actual
 * `zpl check` request 403'd because the api-client UA hit a Cloudflare rule
 * that the diagnose UA didn't.
 *
 * Cloudflare Bot Fight Mode on zeropointlogic.io silently 403s any UA that
 * doesn't start with "Mozilla/". Node's default fetch UA ("node") and any
 * plain "zpl-engine-cli/<ver>" hit the challenge page. Mozilla/5.0 +
 * (compatible; <our tool>) — the same convention bingbot and slackbot use —
 * clears the challenge while staying identifiable in our access logs.
 *
 * Keep this in lockstep with mcp/src/setup.ts USER_AGENT — both clients
 * sharing one Mozilla envelope keeps WAF rules simpler on the engine side.
 */

import { createRequire } from "node:module";

// Read version from package.json so the UA always tracks the published
// version without needing a manual update on every release.
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();

export const USER_AGENT = `Mozilla/5.0 (compatible; zpl-engine-cli/${VERSION}; +https://github.com/cicicalex/zpl-engine-cli)`;
