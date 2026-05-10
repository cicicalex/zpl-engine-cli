/**
 * Regression tests for client-side API key format validation (CLI v0.2.0).
 *
 * Mirrors the MCP test/api-key-format.test.mjs so both clients accept the
 * same shapes. Run after `npm run build` — imports compiled JS from ../dist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  API_KEY_FORMAT,
  SERVICE_KEY_FORMAT,
  isValidApiKeyFormat,
  isServiceKey,
} from "../dist/api-key-format.js";

// 48 hex chars (24 bytes) — matches engine output of crypto.randomBytes(24).toString("hex").
// Use deadbeef pattern so GitHub secret scanning doesn't flag this fixture.
const HEX48 = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

test("regex constants exported", () => {
  assert.ok(API_KEY_FORMAT instanceof RegExp);
  assert.ok(SERVICE_KEY_FORMAT instanceof RegExp);
});

// ---------------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------------

test("accepts legacy direct user key (no prefix)", () => {
  assert.equal(isValidApiKeyFormat(`zpl_u_${HEX48}`), true);
});

test("accepts wizard cli-prefixed key (this is what `zpl login` issues)", () => {
  assert.equal(isValidApiKeyFormat(`zpl_u_cli_${HEX48}`), true);
});

test("accepts wizard mcp-prefixed key (cross-tool: shared key works)", () => {
  assert.equal(isValidApiKeyFormat(`zpl_u_mcp_${HEX48}`), true);
});

test("accepts wizard default-prefixed key", () => {
  assert.equal(isValidApiKeyFormat(`zpl_u_default_${HEX48}`), true);
});

test("accepts future prefix made of lowercase letters", () => {
  // Regex is intentionally permissive on prefix shape ([a-z]+_) so engine
  // can roll out new key types (sdk, web, api) without forcing a CLI update.
  assert.equal(isValidApiKeyFormat(`zpl_u_sdk_${HEX48}`), true);
  assert.equal(isValidApiKeyFormat(`zpl_u_web_${HEX48}`), true);
  assert.equal(isValidApiKeyFormat(`zpl_u_api_${HEX48}`), true);
});

// ---------------------------------------------------------------------------
// Rejected shapes — security boundaries
// ---------------------------------------------------------------------------

test("rejects empty string", () => {
  assert.equal(isValidApiKeyFormat(""), false);
});

test("rejects service key (`zpl_s_...`) — server-side only", () => {
  assert.equal(isValidApiKeyFormat(`zpl_s_${HEX48}`), false);
  assert.equal(isServiceKey(`zpl_s_${HEX48}`), true);
});

test("rejects Stripe-style secret (sk_live_...) — anti-leak", () => {
  // Test fixture deliberately uses repeated 'X' so GitHub secret-scanning
  // doesn't flag it as a real Stripe key.
  assert.equal(isValidApiKeyFormat("sk_live_" + "X".repeat(32)), false);
});

test("rejects Anthropic-style secret (sk-ant-...) — anti-leak", () => {
  assert.equal(isValidApiKeyFormat("sk-ant-api03-FAKE-FIXTURE-NOT-A-KEY"), false);
});

test("rejects key with uppercase hex (regex is lowercase only)", () => {
  assert.equal(
    isValidApiKeyFormat(`zpl_u_ABCDEF0123456789abcdef0123456789abcdef0123456789`),
    false,
  );
});

test("rejects key with prefix containing digits or underscores", () => {
  assert.equal(isValidApiKeyFormat(`zpl_u_cli2_${HEX48}`), false);
  assert.equal(isValidApiKeyFormat(`zpl_u_my_app_${HEX48}`), false);
});

test("rejects key shorter than 48 hex", () => {
  assert.equal(isValidApiKeyFormat(`zpl_u_cli_${HEX48.slice(0, 47)}`), false);
});

test("rejects key longer than 48 hex", () => {
  assert.equal(isValidApiKeyFormat(`zpl_u_cli_${HEX48}0`), false);
});

test("rejects whitespace padding (caller should trim)", () => {
  assert.equal(isValidApiKeyFormat(` zpl_u_${HEX48}`), false);
  assert.equal(isValidApiKeyFormat(`zpl_u_${HEX48} `), false);
  assert.equal(isValidApiKeyFormat(`zpl_u_${HEX48}\n`), false);
});

test("rejects garbage / random input", () => {
  assert.equal(isValidApiKeyFormat("hello"), false);
  assert.equal(isValidApiKeyFormat("zpl_u_"), false);
  assert.equal(isValidApiKeyFormat("zpl_u__" + HEX48), false); // double underscore
});

// ---------------------------------------------------------------------------
// isServiceKey — separate boundary
// ---------------------------------------------------------------------------

test("isServiceKey returns false for user keys", () => {
  assert.equal(isServiceKey(`zpl_u_${HEX48}`), false);
  assert.equal(isServiceKey(`zpl_u_cli_${HEX48}`), false);
});

test("isServiceKey returns true only for zpl_s_ + 48 hex", () => {
  assert.equal(isServiceKey(`zpl_s_${HEX48}`), true);
  assert.equal(isServiceKey(`zpl_s_cli_${HEX48}`), false); // service keys have no prefix variant
  assert.equal(isServiceKey(`zpl_s_${HEX48.slice(0, 47)}`), false);
});
