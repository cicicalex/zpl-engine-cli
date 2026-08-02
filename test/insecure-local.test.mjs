/**
 * ZPL_ENGINE_ALLOW_INSECURE_LOCAL must actually allow something insecure.
 *
 * AUDIT 2026-07-31: it never did in the CLI. The https check ran
 * unconditionally and before the allowlist, and localhostAllowed() only added
 * hostnames to that allowlist — which is reached only by URLs that already
 * passed as https. So the single thing the flag exists to permit, an http URL
 * on loopback, was rejected two checks earlier and the flag could not change it.
 *
 * The variable was renamed in v1.1.1 for the stated purpose of sharing it with
 * the MCP, and the MCP honours it:
 *
 *     if (u.protocol === "http:" && isLocal && ...ALLOW_INSECURE_LOCAL === "1") return;
 *
 * The alignment was done on the name and never on the behaviour. Anyone running
 * a local engine — which serves http — could point the MCP at it and not the
 * CLI, and the CLI's error told them to use https, which a local engine does
 * not speak. That is also why this went unnoticed: the failure looks like a
 * configuration mistake by the user.
 *
 * The security property is the reason this is a matrix and not one assertion.
 * Loosening a scheme check is exactly where a fix turns into a hole, so remote
 * http must stay refused with the flag set, and so must http on the real engine
 * host — the flag is for loopback, not for downgrading production.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readSibling, whySkipped } from "./sibling-repo.mjs";
import { validateEngineUrl, EngineUrlError } from "../dist/engine-url-validate.js";

// AUDIT 2026-08-02: an absolute path on one machine, and the read below
// swallowed a missing file into a silent pass. Resolved relative to this repo
// now, overridable by environment, and absence is reported as a skip.
const MCP_URL_TS = ["zpl-engine-mcp", "src", "engine-url.ts"];

/** Run fn with the flag set or cleared, then restore. */
function withFlag(on, fn) {
  const prev = process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL;
  if (on) process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL = "1";
  else delete process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL;
    else process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL = prev;
  }
}

test("with the flag set, http on loopback is accepted", () => {
  for (const url of ["http://127.0.0.1:9", "http://localhost:8080", "http://[::1]:3000"]) {
    withFlag(true, () => {
      assert.equal(
        validateEngineUrl(url),
        url,
        `${url} is still refused with ZPL_ENGINE_ALLOW_INSECURE_LOCAL=1. The flag ` +
          `permits nothing, which is the whole of what it is for.`,
      );
    });
  }
});

test("without the flag, http on loopback is still refused", () => {
  // Measured while breaking this deliberately: two independent layers refuse
  // it. Removing `&& localhostAllowed()` from the scheme check alone does not
  // change the behaviour, because the allowlist below does not contain
  // 127.0.0.1 unless the same flag is set, so the URL is refused a few lines
  // later for a different reason. Both layers have to go for this to fail,
  // which is the correct shape for the property and is recorded here so nobody
  // reads a passing break test as a weak assertion.
  withFlag(false, () => {
    assert.throws(
      () => validateEngineUrl("http://127.0.0.1:9"),
      EngineUrlError,
      "loopback http is accepted with no flag — a typo now routes the API key to " +
        "whatever is listening locally",
    );
  });
});

test("the flag does not loosen anything beyond loopback", () => {
  // Where a scheme fix turns into a hole.
  withFlag(true, () => {
    for (const url of [
      "http://evil.example.com",
      "http://engine.zeropointlogic.io",
      "http://127.0.0.1.evil.com",
      "http://notlocalhost",
    ]) {
      assert.throws(
        () => validateEngineUrl(url),
        EngineUrlError,
        `${url} is accepted with the flag set. The flag is for a local engine, not ` +
          `for downgrading anything else to plaintext — the API key travels in the header.`,
      );
    }
  });
});

test("https is unaffected by the flag, in both directions", () => {
  for (const on of [true, false]) {
    withFlag(on, () => {
      assert.equal(
        validateEngineUrl("https://engine.zeropointlogic.io"),
        "https://engine.zeropointlogic.io",
        `the production URL broke with the flag ${on ? "set" : "unset"}`,
      );
    });
  }
});

test("the MCP still honours the same variable, so the two have not diverged again", async (t) => {
  // The point of the rename was one variable across both clients. Checking the
  // CLI alone would let the MCP drop it and call that fine.
  const mcp = await readSibling("clients", ...MCP_URL_TS);
  if (mcp === null) {
    t.skip(whySkipped("clients", ...MCP_URL_TS));
    return;
  }

  // Strings and comments removed first. The MCP's rejection branch names the
  // variable inside its own error text — "For local engine only: http://127.0.0.1
  // with ZPL_ENGINE_ALLOW_INSECURE_LOCAL=1" — and the first version of this
  // assertion matched that instead of the code. Replacing the real condition
  // with `if (false)` left the sentence intact and this test reported clean.
  // Advice about a flag is not the flag being honoured.
  const code = mcp
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  assert.match(
    code,
    /protocol === ""[\s\S]{0,80}ZPL_ENGINE_ALLOW_INSECURE_LOCAL/,
    "the MCP no longer allows http on loopback under ZPL_ENGINE_ALLOW_INSECURE_LOCAL. " +
      "The variable was renamed in v1.1.1 so both clients would share it; if the MCP " +
      "dropped it, the CLI is now the odd one out instead.",
  );
});
