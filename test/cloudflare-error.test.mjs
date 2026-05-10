/**
 * Tests for the Cloudflare HTML detector + ApiCloudflareError.
 *
 * Pre-v0.2.0 the api-client did `await res.json()` on any 200 response.
 * If Cloudflare served an HTML interstitial (which DOES happen with
 * Bot Fight Mode + an unfamiliar User-Agent), the JSON parse threw
 * `SyntaxError: Unexpected token < in JSON at position 0` — a useless
 * error for the end user. v0.2.0 detects HTML up-front and surfaces a
 * typed `ApiCloudflareError` with the cf-ray ID for support triage.
 *
 * Run after `npm run build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiCloudflareError,
  looksLikeCloudflareHtml,
} from "../dist/api-client.js";

// ---------------------------------------------------------------------------
// HTML detector
// ---------------------------------------------------------------------------

test("detects body starting with <!DOCTYPE html>", () => {
  assert.equal(looksLikeCloudflareHtml("<!DOCTYPE html>...", null), true);
});

test("detects body starting with <html", () => {
  assert.equal(looksLikeCloudflareHtml("<html lang='en'>...", null), true);
});

test("detects Cloudflare 'Just a moment' challenge", () => {
  const body = "<title>Just a moment...</title>";
  assert.equal(looksLikeCloudflareHtml(body, null), true);
});

test("detects Cloudflare 'Attention Required' block page", () => {
  const body = "<title>Attention Required! | Cloudflare</title>";
  assert.equal(looksLikeCloudflareHtml(body, null), true);
});

test("detects cf-mitigated marker in body", () => {
  const body = "<!-- cf-mitigated: true -->";
  assert.equal(looksLikeCloudflareHtml(body, null), true);
});

test("trusts Content-Type header even without HTML markers in body", () => {
  // Some upstreams return text/html with non-standard body. Trust the header.
  assert.equal(looksLikeCloudflareHtml("just plain text", "text/html; charset=utf-8"), true);
});

test("does NOT flag JSON bodies", () => {
  assert.equal(looksLikeCloudflareHtml('{"ok":true}', "application/json"), false);
  assert.equal(looksLikeCloudflareHtml('{"d":9,"bias":3,"ain":75.0}', null), false);
});

test("does NOT flag plain-text non-HTML responses", () => {
  assert.equal(looksLikeCloudflareHtml("OK", "text/plain"), false);
  assert.equal(looksLikeCloudflareHtml("", null), false);
});

test("Content-Type is case-insensitive (TEXT/HTML, Text/Html, etc)", () => {
  assert.equal(looksLikeCloudflareHtml("body", "TEXT/HTML"), true);
  assert.equal(looksLikeCloudflareHtml("body", "Text/Html"), true);
});

// ---------------------------------------------------------------------------
// ApiCloudflareError shape
// ---------------------------------------------------------------------------

test("ApiCloudflareError carries cf-ray ID when provided", () => {
  const err = new ApiCloudflareError("8f1a2b3c4d5e6f7g-FRA");
  assert.equal(err.name, "ApiCloudflareError");
  assert.equal(err.cfRay, "8f1a2b3c4d5e6f7g-FRA");
  assert.match(err.message, /cf-ray: 8f1a2b3c4d5e6f7g-FRA/);
});

test("ApiCloudflareError handles missing cf-ray gracefully", () => {
  const err = new ApiCloudflareError(undefined);
  assert.equal(err.cfRay, undefined);
  assert.match(err.message, /Cloudflare blocked/);
  // Should NOT contain the literal word "undefined" in the user-facing message
  assert.doesNotMatch(err.message, /undefined/);
});

test("ApiCloudflareError directs user to support with cf-ray", () => {
  const err = new ApiCloudflareError("test-ray-123");
  assert.match(err.message, /zeropointlogic\.io\/support/);
});
