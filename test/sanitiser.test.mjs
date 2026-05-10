/**
 * Tests for sanitiseStatus (db.ts) — defensive secret redaction on history.
 *
 * Pre-v1.0.0 the CLI's appendHistory wrote the raw `status` field. The
 * engine doesn't put secrets there today, but we wear seatbelts: if some
 * future error path leaks a key into status (as the MCP did before
 * v3.7.2), we don't want it persisted to ~/.zpl/history.json in clear text.
 *
 * Run after `npm run build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sanitiseStatus } from "../dist/db.js";

const HEX48 = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

test("sanitiseStatus passes through normal status values", () => {
  assert.equal(sanitiseStatus("CERTIFIED_NEUTRAL"), "CERTIFIED_NEUTRAL");
  assert.equal(sanitiseStatus("HIGH_BIAS"), "HIGH_BIAS");
  assert.equal(sanitiseStatus("DETERMINISTIC"), "DETERMINISTIC");
});

test("sanitiseStatus preserves null and undefined", () => {
  assert.equal(sanitiseStatus(null), null);
  assert.equal(sanitiseStatus(undefined), null);
});

test("sanitiseStatus redacts legacy zpl_u_<hex> keys", () => {
  const dirty = `auth failed for zpl_u_${HEX48}`;
  const clean = sanitiseStatus(dirty);
  assert.ok(clean.includes("[REDACTED]"));
  assert.ok(!clean.includes(HEX48));
});

test("sanitiseStatus redacts wizard zpl_u_cli_<hex> keys", () => {
  const dirty = `auth failed for zpl_u_cli_${HEX48}`;
  const clean = sanitiseStatus(dirty);
  assert.ok(clean.includes("[REDACTED]"));
  assert.ok(!clean.includes(HEX48));
});

test("sanitiseStatus redacts wizard zpl_u_mcp_<hex> keys", () => {
  const dirty = `cross-tool key zpl_u_mcp_${HEX48} expired`;
  const clean = sanitiseStatus(dirty);
  assert.ok(clean.includes("[REDACTED]"));
});

test("sanitiseStatus redacts service zpl_s_<hex> keys", () => {
  const dirty = `unexpected service key zpl_s_${HEX48}`;
  const clean = sanitiseStatus(dirty);
  assert.ok(clean.includes("[REDACTED]"));
  assert.ok(!clean.includes(HEX48));
});

test("sanitiseStatus redacts Bearer tokens", () => {
  const dirty = "Authorization: Bearer abc123def456ghi789jklmno";
  const clean = sanitiseStatus(dirty);
  assert.ok(clean.includes("[REDACTED]"));
  assert.ok(!clean.includes("abc123def456ghi789jklmno"));
});

test("sanitiseStatus redacts Anthropic-style sk-ant-* keys", () => {
  // Fake fixture so GitHub secret-scanning doesn't flag this.
  const fakePart = "FAKE_FIXTURE_NOT_A_REAL_KEY_xxx";
  const dirty = `proxy error: sk-ant-api03-${fakePart}`;
  const clean = sanitiseStatus(dirty);
  assert.ok(clean.includes("[REDACTED]"));
  assert.ok(!clean.includes(fakePart));
});

test("sanitiseStatus redacts Groq gsk_* keys", () => {
  const dirty = "gsk_AbC123dEf456GhI789";
  const clean = sanitiseStatus(dirty);
  assert.ok(clean.includes("[REDACTED]"));
  assert.ok(!clean.includes("AbC123dEf456GhI789"));
});

test("sanitiseStatus handles multiple secrets in one string", () => {
  // Bearer regex requires at least 16 chars after Bearer; pad to 20 to be safe.
  const dirty = `key1=zpl_u_${HEX48} key2=zpl_u_cli_${HEX48} bearer=Bearer xyz123abc456defGHI78`;
  const clean = sanitiseStatus(dirty);
  // Three [REDACTED] occurrences.
  assert.equal(clean.match(/\[REDACTED\]/g)?.length, 3);
});
