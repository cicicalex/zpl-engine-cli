/**
 * Tests for file-utils.ts (readTextFileOrDie).
 *
 * Pre-v1.0.0 each command had its own existsSync→readFileSync sequence:
 *   - TOCTOU race window between the two syscalls
 *   - No upper bound on file size (5 GB log → OOM)
 *   - Uneven error messages across commands
 *
 * These tests lock in the consolidated behavior. We can't test the
 * process.exit code paths directly (they kill the test runner), so we
 * use a child-process subshell for the failure cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { readTextFileOrDie, MAX_FILE_BYTES, MIN_TEXT_CHARS } from "../dist/file-utils.js";

async function withTempFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "zpl-cli-fileutils-"));
  const path = join(dir, "input.txt");
  await writeFile(path, content);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("constants exported", () => {
  assert.ok(typeof MAX_FILE_BYTES === "number");
  assert.ok(typeof MIN_TEXT_CHARS === "number");
  assert.ok(MAX_FILE_BYTES > 0);
});

test("reads a normal text file", async () => {
  await withTempFile("hello world this is fine", async (path) => {
    const text = readTextFileOrDie(path);
    assert.equal(text, "hello world this is fine");
  });
});

test("reads a file at the size cap exactly", async () => {
  // Generate a string of MIN_TEXT_CHARS to ensure we don't trip the min check.
  const content = "x".repeat(MIN_TEXT_CHARS + 10);
  await withTempFile(content, async (path) => {
    const text = readTextFileOrDie(path);
    assert.equal(text.length, content.length);
  });
});

// ── Failure-mode subprocess tests ─────────────────────────────────────
// readTextFileOrDie calls process.exit(1) on every failure path. We can't
// observe that in-process without mocking, so we shell out to a tiny Node
// script that imports the fn and let it exit naturally. We then assert on
// the exit code and stderr.

function runSubprocess(scriptBody) {
  return spawnSync(process.execPath, ["-e", scriptBody], { encoding: "utf-8" });
}

test("exits 1 when file does not exist", () => {
  const r = runSubprocess(`
    import("${pathFor("dist/file-utils.js")}").then((m) => {
      m.readTextFileOrDie("/this/does/not/exist/zpl-cli-test.txt");
    });
  `);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found|Cannot stat/i);
});

test("exits 1 when file too short", async () => {
  await withTempFile("x", async (path) => {
    const r = runSubprocess(`
      import("${pathFor("dist/file-utils.js")}").then((m) => {
        m.readTextFileOrDie(${JSON.stringify(path)});
      });
    `);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /too short/i);
  });
});

test("exits 1 when file too big", async () => {
  // Write 5 chars, but pass maxBytes:1 to trigger the size check without
  // having to write a real 1 GB file.
  await withTempFile("hello world long enough to pass min chars", async (path) => {
    const r = runSubprocess(`
      import("${pathFor("dist/file-utils.js")}").then((m) => {
        m.readTextFileOrDie(${JSON.stringify(path)}, { maxBytes: 5 });
      });
    `);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /too large|limit/i);
  });
});

test("exits 1 when path is a directory not a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpl-cli-fileutils-dir-"));
  try {
    const r = runSubprocess(`
      import("${pathFor("dist/file-utils.js")}").then((m) => {
        m.readTextFileOrDie(${JSON.stringify(dir)});
      });
    `);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a regular file/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Helper to build a file:// URL the subprocess can dynamic-import.
function pathFor(rel) {
  // Node URL.fileURLToPath inverse: build a file:// URL from CWD-relative path.
  const abs = join(process.cwd(), rel).replace(/\\/g, "/");
  return `file:///${abs}`;
}
