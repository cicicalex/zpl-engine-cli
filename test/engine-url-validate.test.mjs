/**
 * Tests for engine-url-validate.ts — the host-allowlist that defends Bearer
 * tokens against being POSTed to attacker.com via a hijacked config or env.
 *
 * Run after `npm run build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateEngineUrl,
  EngineUrlError,
  DEFAULT_ENGINE_URL,
} from "../dist/engine-url-validate.js";

// ── Accepted shapes ─────────────────────────────────────────────────

test("accepts the production engine URL", () => {
  assert.equal(
    validateEngineUrl("https://engine.zeropointlogic.io"),
    "https://engine.zeropointlogic.io",
  );
});

test("accepts staging + dev engine URLs", () => {
  assert.equal(
    validateEngineUrl("https://engine-staging.zeropointlogic.io"),
    "https://engine-staging.zeropointlogic.io",
  );
  assert.equal(
    validateEngineUrl("https://engine-dev.zeropointlogic.io"),
    "https://engine-dev.zeropointlogic.io",
  );
});

test("strips trailing slash for canonical form", () => {
  assert.equal(
    validateEngineUrl("https://engine.zeropointlogic.io/"),
    "https://engine.zeropointlogic.io",
  );
  assert.equal(
    validateEngineUrl("https://engine.zeropointlogic.io///"),
    "https://engine.zeropointlogic.io",
  );
});

test("preserves a sub-path", () => {
  assert.equal(
    validateEngineUrl("https://engine.zeropointlogic.io/v1"),
    "https://engine.zeropointlogic.io/v1",
  );
});

test("DEFAULT_ENGINE_URL is itself accepted (sanity)", () => {
  assert.equal(validateEngineUrl(DEFAULT_ENGINE_URL), DEFAULT_ENGINE_URL);
});

// ── Rejected shapes — the security boundary ─────────────────────────

test("rejects http:// (no plain HTTP for Bearer tokens)", () => {
  assert.throws(
    () => validateEngineUrl("http://engine.zeropointlogic.io"),
    EngineUrlError,
  );
});

test("rejects file:// scheme", () => {
  assert.throws(() => validateEngineUrl("file:///etc/passwd"), EngineUrlError);
});

test("rejects data: scheme", () => {
  assert.throws(() => validateEngineUrl("data:text/plain,foo"), EngineUrlError);
});

test("rejects URL with userinfo (credentials in URL leak to logs)", () => {
  assert.throws(
    () => validateEngineUrl("https://user:pass@engine.zeropointlogic.io"),
    EngineUrlError,
  );
});

test("rejects unknown host (no attacker.com)", () => {
  assert.throws(
    () => validateEngineUrl("https://attacker.com"),
    EngineUrlError,
  );
});

test("rejects typo'd host (zeropointlogc.io)", () => {
  assert.throws(
    () => validateEngineUrl("https://engine.zeropointlogc.io"),
    EngineUrlError,
  );
});

test("rejects empty / non-string", () => {
  assert.throws(() => validateEngineUrl(""), EngineUrlError);
  assert.throws(() => validateEngineUrl(null), EngineUrlError);
  assert.throws(() => validateEngineUrl(undefined), EngineUrlError);
});

test("rejects non-URL garbage", () => {
  assert.throws(() => validateEngineUrl("not a url"), EngineUrlError);
  assert.throws(() => validateEngineUrl("engine.zeropointlogic.io"), EngineUrlError);
});

test("rejects localhost by default (allows only with ZPL_ALLOW_LOCALHOST=1)", () => {
  // Make sure it's not set
  delete process.env.ZPL_ALLOW_LOCALHOST;
  assert.throws(
    () => validateEngineUrl("https://localhost:8080"),
    EngineUrlError,
  );
});

test("ZPL_ALLOW_LOCALHOST=1 lets localhost through", () => {
  process.env.ZPL_ALLOW_LOCALHOST = "1";
  try {
    assert.equal(
      validateEngineUrl("https://localhost:8080"),
      "https://localhost:8080",
    );
    assert.equal(
      validateEngineUrl("https://127.0.0.1:8080"),
      "https://127.0.0.1:8080",
    );
  } finally {
    delete process.env.ZPL_ALLOW_LOCALHOST;
  }
});

test("ZPL_ENGINE_HOST_ALLOWLIST adds custom hosts (self-host opt-in)", () => {
  process.env.ZPL_ENGINE_HOST_ALLOWLIST = "self-host.example, alt.example";
  try {
    assert.equal(
      validateEngineUrl("https://self-host.example"),
      "https://self-host.example",
    );
    assert.equal(
      validateEngineUrl("https://alt.example"),
      "https://alt.example",
    );
    // Unrelated host still rejected
    assert.throws(
      () => validateEngineUrl("https://other.example"),
      EngineUrlError,
    );
  } finally {
    delete process.env.ZPL_ENGINE_HOST_ALLOWLIST;
  }
});

test("EngineUrlError carries the offending URL in its message", () => {
  try {
    validateEngineUrl("http://attacker.com");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof EngineUrlError);
    assert.match(err.message, /http:\/\/attacker\.com/);
  }
});

test("validation is idempotent on already-clean URLs", () => {
  const clean = validateEngineUrl("https://engine.zeropointlogic.io");
  assert.equal(validateEngineUrl(clean), clean);
});
