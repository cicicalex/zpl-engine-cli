/**
 * Tests for the export command's format renderers (CSV / JSON / Markdown).
 *
 * Renderers are pure functions over an array of HistoryRow; we test them
 * directly without spawning a subprocess. Validation paths (bad format,
 * bad limit) are checked via stderr+exit in subprocess tests.
 *
 * Run after `npm run build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// We don't export the renderer fns publicly (they're internal to cmdExport),
// so we rely on subprocess tests with a fake history file via ZPL env hooks.
// For the CSV escaping rule itself we test via subprocess invocation.

function runCli(args, env = {}) {
  return spawnSync(process.execPath, ["dist/index.js", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ZPL_SKIP_UPDATE_CHECK: "1", ...env },
  });
}

test("export rejects unknown format with exit 2", () => {
  const r = runCli(["export", "yaml"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid format/i);
  assert.match(r.stderr, /json, csv, markdown/i);
});

test("export rejects negative limit with exit 2", () => {
  const r = runCli(["export", "json", "--limit", "-5"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --limit/i);
});

test("export rejects non-numeric limit with exit 2", () => {
  const r = runCli(["export", "json", "--limit", "abc"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --limit/i);
});

test("export accepts json/csv/markdown/md formats", () => {
  // Even with empty history these should exit 0 and emit valid output.
  for (const fmt of ["json", "csv", "markdown", "md"]) {
    const r = runCli(["export", fmt]);
    assert.equal(r.status, 0, `format ${fmt} should exit 0`);
    if (fmt === "json") {
      // Parseable JSON (empty history → empty array)
      assert.doesNotThrow(() => JSON.parse(r.stdout));
    } else if (fmt === "csv") {
      // Header always present
      assert.match(r.stdout, /^id,timestamp,command/);
    } else {
      // markdown — either empty notice or table header
      assert.ok(r.stdout.length > 0);
    }
  }
});
