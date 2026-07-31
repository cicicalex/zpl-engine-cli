/**
 * The method stays unpublished.
 *
 * This package is on npm as zpl-engine-cli. Its source, its README and its package.json
 * description are all world-readable the moment it is published, and unlike a
 * website they cannot be edited afterwards — a version that ships with the
 * derivation in it stays downloadable forever.
 *
 * AUDIT 2026-07-31: the website gained this rule today, and the first version
 * of it there used a scanner that skipped comment lines. Writing the
 * derivation into a `//` comment sailed straight past. A comment ships exactly
 * like the code around it, and it is the likeliest place for something to be
 * parked "just for now", so nothing is skipped here.
 *
 * Scanned at the time of writing: nothing in this package, the CLI, or either
 * SDK carried it. This exists so that stays true rather than being rechecked
 * by hand.
 *
 * src/ only — this file states the patterns it forbids, and a guard that
 * flags its own documentation is a guard someone deletes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "src");

/**
 * The derivation, in the spellings someone would actually write: code, prose,
 * and the unicode multiplication sign a copy-paste from a document brings in.
 */
const DERIVATION =
  /1\s*-\s*(?:Math\.)?abs\s*\(?\s*2\s*[*×⋅]?\s*[*]?\s*p|1\s*-\s*\|\s*2\s*[*×⋅]?\s*p/i;

async function sourceFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("the source tree is actually being read", async () => {
  const files = await sourceFiles(SRC);
  assert.ok(files.length > 5, `only ${files.length} files under ${SRC} — this would pass vacuously`);
});

test("no source file carries the derivation, comments included", async () => {
  const offenders = [];
  for (const file of await sourceFiles(SRC)) {
    const lines = (await readFile(file, "utf-8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (DERIVATION.test(line)) {
        offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `the method must not ship inside a published package:\n${offenders.join("\n")}`,
  );
});

test("no published surface carries it either", async () => {
  const names = ["README.md", "package.json"];
  const offenders = [];
  let scanned = 0;
  for (const name of names) {
    let text;
    try {
      text = await readFile(join(ROOT, name), "utf-8");
    } catch {
      continue;
    }
    scanned++;
    text.split(/\r?\n/).forEach((line, i) => {
      if (DERIVATION.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.ok(scanned > 0, "no published files were read — this would pass vacuously");
  assert.deepEqual(
    offenders,
    [],
    `npm renders these; the method must not be in them:\n${offenders.join("\n")}`,
  );
});

test("the pattern catches how it would really be written", () => {
  assert.ok(DERIVATION.test("  // ain = 1 - Math.abs(2 * p_output - 1)"), "comment");
  assert.ok(DERIVATION.test("const ain = 1 - Math.abs(2 * p - 1);"), "code");
  assert.ok(DERIVATION.test("ain = 1 - |2p - 1|"), "prose");
  assert.ok(DERIVATION.test("AIN = 1 - abs(2 × p_output - 1)"), "pasted from a document");
});

test("the pattern leaves ordinary arithmetic and plain prose alone", () => {
  assert.ok(!DERIVATION.test("const remaining = 1 - used / total;"), "unrelated subtraction");
  assert.ok(!DERIVATION.test("const pct = 1 - ratio;"), "unrelated subtraction");
  assert.ok(
    !DERIVATION.test("p_output is the balance the engine measured; 0.500 is equilibrium"),
    "describing the field is allowed — that is documented on purpose",
  );
  assert.ok(
    !DERIVATION.test("ain is symmetric about equilibrium and cannot express direction"),
    "stating the behaviour is allowed; stating the expression is not",
  );
});
