/**
 * The engine has four reasons to answer 403. The CLI must not report three of
 * them as a bad API key.
 *
 * AUDIT 2026-07-31. The causes come from the Display impl on AuthError in
 * crates/zpl-api/src/auth.rs, and every call site maps all of them to
 * StatusCode::FORBIDDEN:
 *
 *   API key not found or inactive
 *   Dimension {d} exceeds plan limit of {max}
 *   Token limit exceeded: {used}/{limit} used this month
 *   Internal server error                       <- AuthError::Db, Postgres is unwell
 *
 * Measured against a local mock returning the engine's own bodies, before the
 * fix:
 *
 *   cause                     class              attempts  message
 *   invalid key               ApiAuthError              1  "API key invalid. Run zpl logout..."
 *   dimension over plan       ApiAuthError              1  "API key invalid. Run zpl logout..."
 *   quota exhausted           ApiNetworkError           4  "Network error: Monthly ZPL..."
 *   database down             ApiAuthError              1  "API key invalid. Run zpl logout..."
 *
 * Three of four wrong. A Free user asking for d=25 was told to log out and log
 * back in; they do, it fails identically, and their key was never the problem.
 * A database outage told them the same thing, so the working credentials they
 * wipe get replaced by credentials that fail the same way.
 *
 * The quota row is a second defect in the same function. ApiQuotaExhaustedError
 * extends Error, not ApiQuotaError, so it was absent from the retry loop's
 * terminal list, got retried to exhaustion, and was rewritten as
 * ApiNetworkError on the way out. The careful quota message added in the 12.05
 * audit could never reach a user, and every exhausted-quota call hit the engine
 * four times for a condition that does not clear with time — against a rate
 * limiter that, on the engine side, runs before key extraction.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  ApiClient,
  ApiAuthError,
  ApiQuotaExhaustedError,
  ApiDimensionError,
  ApiEngineInternalError,
} from "../dist/api-client.js";

/** The engine's own wording, verbatim. */
const CAUSES = [
  {
    label: "invalid key",
    body: "API key not found or inactive",
    expect: ApiAuthError,
    mustSay: /logout/i,
  },
  {
    label: "dimension over plan",
    body: "Dimension 25 exceeds plan limit of 9",
    expect: ApiDimensionError,
    mustSay: /ceiling of 9/i,
    mustNotSay: /logout/i,
  },
  {
    label: "quota exhausted",
    body: "Token limit exceeded: 5123/5000 used this month",
    expect: ApiQuotaExhaustedError,
    mustNotSay: /network error/i,
  },
  {
    label: "database down",
    body: "Internal server error",
    expect: ApiEngineInternalError,
    mustSay: /server-side|API key is fine/i,
    mustNotSay: /logout/i,
  },
];

async function withMock(body, fn) {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: body, code: 403 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    process.env.ZPL_ENGINE_ALLOW_INSECURE_LOCAL = "1";
    const client = new ApiClient({
      apiKey: "zpl_u_" + "a".repeat(48),
      baseUrl: `http://127.0.0.1:${port}`,
    });
    let err;
    try {
      await client.compute({ d: 9, bias: 0.5, samples: 100 });
    } catch (e) {
      err = e;
    }
    return await fn({ err, hits: () => hits });
  } finally {
    server.close();
  }
}

for (const c of CAUSES) {
  test(`403 "${c.label}" is reported as ${c.expect.name}`, async () => {
    await withMock(c.body, ({ err }) => {
      assert.ok(err, `${c.label}: no error thrown at all`);
      assert.ok(
        err instanceof c.expect,
        `${c.label}: engine said "${c.body}" and the CLI threw ${err.constructor.name}. ` +
          `Expected ${c.expect.name}. Reporting the wrong cause sends the user to fix ` +
          `something that is not broken.`,
      );
      if (c.mustSay) {
        assert.match(err.message, c.mustSay, `${c.label}: message does not explain the real cause`);
      }
      if (c.mustNotSay) {
        assert.doesNotMatch(
          err.message,
          c.mustNotSay,
          `${c.label}: message still points the user at the wrong thing`,
        );
      }
    });
  });
}

test("no 403 cause is retried — none of them clears with time", async () => {
  // The quota case used to hit the engine four times. A plan ceiling, an
  // exhausted quota, a rejected key and a server that has already decided are
  // all terminal; retrying is pure load, and the engine's rate limiter counts
  // the extra attempts because it runs before key extraction.
  for (const c of CAUSES) {
    await withMock(c.body, ({ hits }) => {
      assert.equal(
        hits(),
        1,
        `${c.label}: the CLI made ${hits()} requests for a condition that cannot ` +
          `clear by retrying.`,
      );
    });
  }
});

test("every 403 class is terminal in the retry loop", async () => {
  // Behavioural above; structural here, so a new class added later is not
  // quietly left out of the list the way ApiQuotaExhaustedError was.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const src = await readFile(join(root, "src", "api-client.ts"), "utf-8");

  const at = src.indexOf("Cloudflare errors are terminal");
  assert.notEqual(at, -1, "the terminal-error block is gone");
  const block = src.slice(at, src.indexOf("lastErr = err as Error", at));

  for (const name of [
    "ApiAuthError",
    "ApiQuotaError",
    "ApiQuotaExhaustedError",
    "ApiDimensionError",
    "ApiEngineInternalError",
    "ApiCloudflareError",
  ]) {
    assert.ok(
      block.includes(name),
      `${name} is not in the retry loop's terminal list, so it will be retried to ` +
        `exhaustion and then rewritten as ApiNetworkError — which is exactly how the ` +
        `quota error stopped reaching users.`,
    );
  }
});
