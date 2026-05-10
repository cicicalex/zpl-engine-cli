/**
 * Client-side API key format validation (defence-in-depth).
 *
 * Engine is the authoritative validator. This module fails fast on obvious
 * garbage and prevents accidentally leaking unrelated secrets (e.g. Stripe
 * keys) in the Authorization header. Ported verbatim from the MCP package
 * (engine-mcp/src/api-key-format.ts) so both clients accept the same shapes.
 *
 * v0.2.0 (CLI): Accept wizard-issued keys with type prefixes — engine emits
 * `zpl_u_cli_<hex>` for keys created via `npx zpl-engine-cli login`. Previous
 * code did no validation at all, so a corrupted config would survive until
 * the first API request and surface as a generic 401.
 *
 * Accepted formats:
 *   - `zpl_u_<48 hex>`              (legacy direct keys)
 *   - `zpl_u_<prefix>_<48 hex>`     (wizard keys: prefix is lowercase letters)
 *
 * Rejected formats:
 *   - `zpl_s_...`                   (service keys — server-side only)
 *   - anything else (Stripe sk_, Anthropic sk-ant-, etc.)
 *
 * Engine emits prefixes: 'zpl_u_', 'zpl_u_default_', 'zpl_u_cli_', 'zpl_u_mcp_'.
 * Regex allows any future `[a-z]+_` prefix without a code change.
 */

/** Matches user keys: `zpl_u_` + optional `<lowercase prefix>_` + 48 hex. */
export const API_KEY_FORMAT = /^zpl_u_(?:[a-z]+_)?[a-f0-9]{48}$/;

/** Matches service keys: `zpl_s_` + 48 hex. Rejected by CLI (server-side only). */
export const SERVICE_KEY_FORMAT = /^zpl_s_[a-f0-9]{48}$/;

/** True if `key` is a valid user API key shape. */
export function isValidApiKeyFormat(key: string): boolean {
  return API_KEY_FORMAT.test(key);
}

/** True if `key` is a service key (rejected — must use user key in CLI). */
export function isServiceKey(key: string): boolean {
  return SERVICE_KEY_FORMAT.test(key);
}
