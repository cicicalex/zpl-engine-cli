/**
 * The README must document the verdict bands the CLI actually emits.
 *
 * AUDIT 2026-08-01. `verdictFor()` in src/commands/check.ts was rewritten to
 * use the engine's six bands, and README.md still described the four-way band
 * it replaced — `highly balanced` / `moderately balanced` / `noticeable bias` /
 * `heavily biased`, none of which the CLI can produce any more.
 *
 * That matters more than a stale doc usually would: README.md is in
 * package.json's `files` array, so it is the npm landing page and it freezes
 * inside the 1.3.0 tarball. A published README cannot be corrected without
 * publishing again.
 *
 * The bands are read out of the source rather than listed here, so moving a
 * threshold fails this test instead of quietly re-opening the gap.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** One pass, alternating: a `/*` inside a line comment must not open a block. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_m, before) => before ?? "");
}

/** The (threshold, phrase) pairs `verdictFor` returns, in source order. */
async function bandsFromSource() {
  const raw = await readFile(join(ROOT, "src", "commands", "check.ts"), "utf-8");
  const code = stripComments(raw);

  // Whole name, not a prefix. indexOf("function verdictFor") also matches
  // `function verdictForRenamed`, so renaming the function left this guard
  // happily parsing a function that no longer feeds the output — proven by
  // breaking it, which is the only way that kind of hole shows up.
  const decl = code.match(/\bfunction\s+verdictFor\s*\(/);
  assert.ok(decl, "verdictFor is gone from check.ts — this guard is checking nothing");
  const at = decl.index;
  const body = code.slice(at, code.indexOf("\n}", at));

  const bands = [...body.matchAll(/if\s*\(\s*ain\s*>=\s*(\d+)\s*\)\s*return\s*"([^"]+)"/g)].map((m) => ({
    min: Number(m[1]),
    phrase: m[2],
  }));
  const fallback = body.match(/return\s*"([^"]+)"\s*;\s*$/m);
  assert.ok(fallback, "verdictFor has no final fallback return");
  bands.push({ min: 0, phrase: fallback[1] });

  assert.ok(bands.length >= 3, `only ${bands.length} bands parsed out of verdictFor`);
  return bands;
}

test("every verdict the CLI can print appears in the README", async () => {
  const bands = await bandsFromSource();
  const readme = await readFile(join(ROOT, "README.md"), "utf-8");

  const missing = bands.filter((b) => !readme.includes(b.phrase)).map((b) => b.phrase);
  assert.deepEqual(
    missing,
    [],
    `the CLI can print ${missing.join(", ")} and the README never mentions ${
      missing.length === 1 ? "it" : "them"
    }. README.md ships inside the npm tarball, so a wrong one is permanent for that version.`,
  );
});

test("the README does not document verdicts the CLI cannot produce", async () => {
  const bands = await bandsFromSource();
  const readme = await readFile(join(ROOT, "README.md"), "utf-8");
  const real = new Set(bands.map((b) => b.phrase));

  // The retired wording, named explicitly. A general scan for "adjective +
  // balanced/bias" would flag ordinary prose; these four are what the file
  // actually claimed, and what a reader would have tried to match on.
  const RETIRED = ["highly balanced", "moderately balanced", "noticeable bias", "heavily biased"];

  const stillClaimed = RETIRED.filter((phrase) => {
    if (real.has(phrase)) return false; // reinstated on purpose

    // Checked per PARAGRAPH, not per line. Prose that explains the change is
    // allowed to name the retired strings; prose that presents them as current
    // output is not. The first version of this split on newlines and flagged
    // the very paragraph documenting the change — markdown wraps, so "used to
    // be" sat on one line and two of the four names on the next. A guard that
    // fires on the sentence explaining the fix is reading its own footprint.
    const paragraphs = readme.split(/\n\s*\n/).filter((p) => p.includes(phrase));
    return paragraphs.some((p) => !/used to|no longer|previously|old strings|replaced|not match/i.test(p));
  });

  assert.deepEqual(
    stillClaimed,
    [],
    `the README still presents ${stillClaimed.join(", ")} as current CLI output. verdictFor now ` +
      `returns ${[...real].join(", ")}. Anyone scripting against the documented strings gets no ` +
      `match, and the README is frozen in the published tarball.`,
  );
});
