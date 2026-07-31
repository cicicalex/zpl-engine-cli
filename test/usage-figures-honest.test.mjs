/**
 * No command may print an unmeasured usage figure as measured.
 *
 * AUDIT 2026-07-31, measured against production the day before: 200 tokens were
 * spent on the engine and /api/user/me reported used_this_month: 0 before and
 * after, with source "engine_log". Three separate server-side failures produce
 * that zero and none is distinguishable from a genuinely idle account, so the
 * endpoint now reports how it obtained the figure. Only "engine_log" means it
 * was read.
 *
 * `zpl whoami` was fixed to honour that. `zpl quota` was not - and quota is the
 * command whose entire job is answering "how much have I got left". It printed
 * a confident green "Remaining: 5,000 tokens" while the server had said it
 * could not measure. Its JSON branch already passed `source` through, so the
 * information was in hand and thrown away on the way to the screen.
 *
 * This guard covers both commands rather than the one that was broken, because
 * the first fix covered one command and the second command kept the bug for a
 * day. Any future command that renders these figures has to opt in the same
 * way.
 *
 * The plan's own allowance is deliberately exempt: monthly_quota is a property
 * of the plan, not a measurement, and stays readable when usage cannot be read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Commands that render figures derived from measured usage. */
const RENDERERS = ["whoami.ts", "quota.ts"];

/** One pass, alternating: a `/*` inside a line comment must not open a block. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_m, before) => before ?? "");
}

for (const file of RENDERERS) {
  test(`${file} branches on how the usage figure was obtained`, async () => {
    const code = stripComments(
      await readFile(join(ROOT, "src", "commands", file), "utf-8"),
    );

    assert.match(
      code,
      /\bsource\b/,
      `${file} never reads \`source\`, so it renders whatever number arrived as though ` +
        `the server had measured it. Three different failures send a zero.`,
    );

    // The flag must be derived from the response, not pinned. A constant here
    // is how a client silently goes back to trusting every zero - which is the
    // exact break that slipped through on whoami until the guard was tightened.
    const decl = code.match(/const\s+unknown\s*=\s*([^;]+);/);
    assert.ok(
      decl,
      `${file} has no derived "unknown" state for the usage figures. Without one, a ` +
        `figure the server could not stand behind is printed in the same style as a real one.`,
    );
    assert.match(
      decl[1],
      /\bsource\b/,
      `${file} computes its unknown state as \`${decl[1].trim()}\` — it no longer depends ` +
        `on what the server reported, so the server's honesty stops at the JSON.`,
    );
  });
}

test("only engine_log counts as measured", async () => {
  // Both commands must treat the label the same way. Whitelisting the one good
  // value is the safe direction: a source added server-side later defaults to
  // "not measured" rather than silently being trusted.
  for (const file of RENDERERS) {
    const code = stripComments(
      await readFile(join(ROOT, "src", "commands", file), "utf-8"),
    );
    const decl = code.match(/const\s+unknown\s*=\s*([^;]+);/)[1];

    assert.match(
      decl,
      /engine_log/,
      `${file} decides "unknown" without reference to engine_log. Listing the failure ` +
        `values instead means a new source added on the server is trusted by default, ` +
        `which is the wrong way for this to fail.`,
    );
  }
});
