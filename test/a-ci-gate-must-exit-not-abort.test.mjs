/**
 * `zpl pipe` is a CI gate. Its exit codes are its whole contract.
 *
 * AUDIT 2026-08-02. The engine-error path ended in `process.exit(3)`, and it
 * is the one place in that command that runs after a network call — exactly
 * the condition src/index.ts documents as fatal on Windows. fetch leaves a
 * keep-alive socket open, and exit() while libuv is mid-close asserts.
 *
 * Measured against the real engine with an invalid key, three runs of three:
 *
 *   API key invalid. Run `zpl logout` then `zpl login`.
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
 *   exit code 127
 *
 * The file's own header promises 3 for an engine error. A CI step that
 * distinguishes "score below threshold" from "could not check at all" got
 * neither, and the user got an assertion printed after the real message,
 * which reads as "the tool is broken" rather than "your key is". Re-measured
 * after the fix: 3, three of three, no assertion.
 *
 * Two different checks below, and it is worth being exact about what each one
 * can see:
 *
 *   - The STRUCTURAL check is the one that catches this defect. The rule was
 *     already written down in src/index.ts; what was missing was anything
 *     enforcing it here.
 *   - The BEHAVIOURAL checks run the built CLI against a local stub engine.
 *     They hold the exit-code contract, but they cannot see this particular
 *     defect: over plain http the sockets close fast enough that the old code
 *     exited 3 cleanly. Measured, not assumed — the crash needed the real
 *     TLS connection. A test that looks like it covers something it does not
 *     is worse than no test, so this is written down rather than implied.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PIPE_SRC = join(ROOT, "src", "commands", "pipe.ts");
const CLI = join(ROOT, "dist", "index.js");

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_m, b) => b ?? "");

// ── The check that catches the defect ─────────────────────────────────────

test("nothing after the engine call calls process.exit", async () => {
  const code = strip(await readFile(PIPE_SRC, "utf-8"));

  // Anchored on the call itself, not on a line number or a comment. Every
  // exit before this point is a usage error raised before any network work,
  // and those were measured returning 2 correctly.
  const at = code.search(/client\.compute\s*\(/);
  assert.notEqual(
    at,
    -1,
    "the engine call is gone from pipe.ts; this check no longer knows where " +
      "the network work starts",
  );

  const after = code.slice(at);
  // `process.exit(` with the parenthesis: `process.exitCode` is the correct
  // spelling and must not be mistaken for the broken one.
  const offenders = [...after.matchAll(/process\.exit\s*\(/g)];
  assert.equal(
    offenders.length,
    0,
    `${offenders.length} call(s) to process.exit() after the engine call. fetch ` +
      `leaves a keep-alive socket open and exit() while libuv is mid-close ` +
      `aborts on Windows with an assertion, so the process never reaches the ` +
      `exit code this command promises. Set process.exitCode and return.`,
  );
});

test("the engine-error path still reports failure", async () => {
  // The other direction: dropping the exit code entirely would make every
  // engine failure look like a pass to a CI script.
  const code = strip(await readFile(PIPE_SRC, "utf-8"));
  const at = code.search(/client\.compute\s*\(/);
  const after = code.slice(at);
  assert.match(
    after,
    /process\.exitCode\s*=\s*3\s*;/,
    "the engine-error path no longer sets exit code 3, so a failed check is " +
      "indistinguishable from a passed one",
  );
});

// ── The exit-code contract, run end to end ────────────────────────────────

/** A stub engine that answers every request with one status and body. */
function stubEngine(status, body) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function runPipe(port, input, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "pipe", ...args], {
      env: {
        ...process.env,
        ZPL_API_KEY: `zpl_u_${"b".repeat(48)}`,
        ZPL_ENGINE_URL: `http://127.0.0.1:${port}`,
        ZPL_ENGINE_ALLOW_INSECURE_LOCAL: "1",
        ZPL_SKIP_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

const TEXT =
  "This is a measured statement and it is fine. Another measured statement here. " +
  "A third one so the input is long enough to analyse.";

test("an engine refusal exits 3", async () => {
  const { server, port } = await stubEngine(403, { error: "Dimension 15 exceeds plan limit of 9" });
  try {
    const { code, out } = await runPipe(port, TEXT);
    assert.equal(
      code,
      3,
      `exit ${code} on an engine error. The header of pipe.ts promises 3, and a ` +
        `CI step reads that number to tell "below threshold" from "could not ` +
        `check":\n${out}`,
    );
    assert.doesNotMatch(
      out,
      /Assertion failed/,
      `an assertion was printed after the real message, which reads as the tool ` +
        `being broken rather than the request:\n${out}`,
    );
  } finally {
    server.close();
  }
});

test("the refusal reaches the user, not a stack trace", async () => {
  const { server, port } = await stubEngine(403, { error: "Dimension 15 exceeds plan limit of 9" });
  try {
    const { out } = await runPipe(port, TEXT);
    assert.match(
      out,
      /ceiling of 9/,
      `the plan ceiling is missing from what the user sees:\n${out}`,
    );
  } finally {
    server.close();
  }
});

test("a usage error still exits 2", async () => {
  // These run before any network call and were measured correct. They are here
  // so a change to the error path cannot quietly collapse the two codes into
  // one - the distinction is the whole point of the contract.
  const { server, port } = await stubEngine(200, {});
  try {
    const { code } = await runPipe(port, TEXT, ["--output", "bogus"]);
    assert.equal(code, 2, `a usage error exited ${code}, not 2`);
  } finally {
    server.close();
  }
});

test("a healthy call exits 0", async () => {
  const { server, port } = await stubEngine(200, {
    p_output: 0.5,
    ain: 0.82,
    ain_status: "NEUTRAL",
    deviation: 0.01,
    status: "STABLE",
    samples: 1000,
    d: 5,
    bias: 0.5,
    tokens_used: 1,
    compute_ms: 3.2,
  });
  try {
    const { code, out } = await runPipe(port, TEXT);
    assert.equal(code, 0, `a successful check exited ${code}:\n${out}`);
  } finally {
    server.close();
  }
});

test("a score below the threshold exits 1, and it is not the engine-error code", async () => {
  const { server, port } = await stubEngine(200, {
    p_output: 0.5,
    ain: 0.2,
    ain_status: "SIGNIFICANT_BIAS",
    deviation: 0.3,
    status: "STABLE",
    samples: 1000,
    d: 5,
    bias: 0.5,
    tokens_used: 1,
    compute_ms: 3.2,
  });
  try {
    const { code, out } = await runPipe(port, TEXT, ["--threshold", "70"]);
    assert.equal(
      code,
      1,
      `a score below the threshold exited ${code}. 1 and 3 mean different things ` +
        `to a CI step and must not collapse:\n${out}`,
    );
  } finally {
    server.close();
  }
});
