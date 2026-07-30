/**
 * Source-level regression guards for the CLI.
 *
 * Why this file exists:
 *   The MCP package has guards that scan its own source for claims and
 *   roundings the numeric contract forbids. The CLI had none — its scale
 *   tests exercise the helpers but nothing stopped a raw
 *   `Math.round(res.ain * 100)` reappearing in a command, or the accuracy
 *   figures removed on 2026-07-30 being pasted back in. The CLI is the
 *   package where both of those actually happened, so it is the one that
 *   most needed the guard.
 *
 *   Design note: the earlier MCP guard failed by being too narrow — it
 *   required the two numbers of the fictional "0.1 to 99.9" range to be
 *   adjacent, so the wording that shipped (markdown emphasis and a
 *   parenthetical between them) slid past and the green test was later
 *   cited as evidence the line was fixed. These patterns allow a bounded
 *   gap, and each is pinned by a positive and a negative case below so
 *   narrowing one again fails loudly.
 *
 *   Comment lines are skipped on purpose. Every rule here is also
 *   *described* in a docstring somewhere in src/ — a guard that flags its
 *   own documentation is a guard nobody keeps.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "src");

/** Integer rounding of an AIN value — drops four of the engine's six decimals. */
const INT_ROUNDING = /Math\.round\([^)]*\bain\s*\*\s*100\s*\)/i;

/** The fictional 0.1–99.9 range. Bounded gap: real wording had 23 chars between. */
const FALSE_RANGE = /0\.1\b[^\n]{0,30}?\b99\.9/;

/** Accuracy / match-rate percentages. The measurements behind them do not exist. */
const UNSUPPORTED_ACCURACY =
  /\b\d{1,3}\s*(?:-|–|to)?\s*\d{0,3}\s*%\s*(?:accuracy|match|match-rate|correct|agreement)/i;

function isComment(line) {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

async function tsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(p)));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

async function scan(pattern) {
  const offenders = [];
  for (const file of await tsFiles(SRC)) {
    const lines = (await readFile(file, "utf-8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      if (pattern.test(line)) {
        offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}


/**
 * AUDIT 2026-07-30: every guard below walks src/ and asserts that the list
 * of offending lines is empty. If src/ were renamed, moved, or partially
 * checked out, that list would be empty because nothing was read — and all
 * of them would report green while checking nothing at all.
 *
 * A test that cannot fail is worse than no test, because someone leans on
 * it. This one fails first and says why.
 */
test("the source tree is actually being read", async () => {
  const files = await tsFiles(SRC);
  assert.ok(
    files.length > 0,
    `no source files found under ${SRC} — every guard below would pass vacuously`,
  );
});

test("no command rounds an AIN value to a whole percent", async () => {
  const offenders = await scan(INT_ROUNDING);
  assert.deepEqual(offenders, [], `AIN precision lost:\n${offenders.join("\n")}`);
});

test("no source advertises the fictional 0.1-99.9 range", async () => {
  const offenders = await scan(FALSE_RANGE);
  assert.deepEqual(offenders, [], `false range claim:\n${offenders.join("\n")}`);
});

test("no source quotes an accuracy or match percentage", async () => {
  const offenders = await scan(UNSUPPORTED_ACCURACY);
  assert.deepEqual(offenders, [], `unsupported accuracy claim:\n${offenders.join("\n")}`);
});

test("each guard matches what it is meant to catch", () => {
  assert.ok(INT_ROUNDING.test("return Math.round(res.ain * 100);"), "int rounding");
  assert.ok(INT_ROUNDING.test("const p = Math.round(result.ain*100)"), "int rounding, no spaces");

  assert.ok(FALSE_RANGE.test("range 0.1 - 99.9"), "plain range");
  assert.ok(FALSE_RANGE.test("from 0.1 to 99.9"), "prose range");
  assert.ok(
    FALSE_RANGE.test("Score: **0.1** (extreme bias) to **99.9** (perfect)"),
    "the wording that actually shipped past the old MCP guard",
  );

  assert.ok(UNSUPPORTED_ACCURACY.test("~85-90% accuracy relative to human intuition"), "range form");
  assert.ok(UNSUPPORTED_ACCURACY.test("93% match with human raters"), "single form");
});

test("guards stay quiet on legitimate nearby text", () => {
  assert.ok(!INT_ROUNDING.test("const pct = ainPercent(res.ain);"), "helper call is fine");
  assert.ok(
    !FALSE_RANGE.test("bias may be 0.1 and, much later in this same long sentence, 99.9"),
    "unbounded gap must not trip the range guard",
  );
  assert.ok(!UNSUPPORTED_ACCURACY.test("100% of the quota"), "quota wording is fine");
  assert.ok(!UNSUPPORTED_ACCURACY.test("uses 20% less memory"), "unrelated percentage is fine");
});

/**
 * The fatal-error path must not force an exit.
 *
 * AUDIT 2026-07-30: dieFormatted ended in `process.exit(1)` and did not exit —
 * it aborted. Every fatal path here runs after a network call, fetch leaves a
 * keep-alive socket open, and calling process.exit() while libuv is mid-close
 * trips an assertion on Windows. The process printed
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
 *
 * after the real message, and exited 127 rather than 1. Scripts checking for 1
 * saw something else, and users saw an assertion that reads as "the tool is
 * broken" rather than "your key is".
 *
 * Setting exitCode and letting the loop drain fixes it — measured, exit 1 in
 * about a second. This guard keeps the forced call from coming back to the one
 * function all 26 fatal call sites route through.
 */
test("dieFormatted sets an exit code rather than forcing an exit", async () => {
  const src = await readFile(join(SRC, "index.ts"), "utf-8");
  // Line-based on purpose. The first version searched for "\n}\n" with
  // indexOf; the file uses CRLF, so it matched nothing and the guard failed on
  // its own parsing rather than on the code it exists to check. A guard that
  // cannot read the file is indistinguishable from one that found a problem.
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("function dieFormatted"));
  assert.ok(start !== -1, "dieFormatted not found — this guard would check nothing");
  const end = lines.findIndex((l, i) => i > start && l === "}");
  assert.ok(end !== -1, "could not find the end of dieFormatted");

  const body = lines.slice(start, end);
  const forced = body
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .filter((l) => /process\.exit\s*\(/.test(l));

  assert.deepEqual(
    forced,
    [],
    `process.exit() inside dieFormatted aborts instead of exiting, because a ` +
      `keep-alive socket is still open at that point:\n${forced.join("\n")}`,
  );
  assert.ok(
    /process\.exitCode\s*=\s*1/.test(body.join("\n")),
    "dieFormatted must still make the process fail — set process.exitCode = 1",
  );
});
