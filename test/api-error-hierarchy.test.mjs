/**
 * Every error this client raises about the engine must share one base.
 *
 * AUDIT 2026-08-01. Eight `Api*Error` classes each extended `Error` directly,
 * and eight call sites listed the ones they cared about by hand. Adding a class
 * meant remembering all eight lists.
 *
 * `ApiUpgradeRequiredError` was added the same day, for the engine's 426 —
 * which the engine's own version gate names this CLI as knowing how to consume
 * — and it was missed in `zpl pipe`. The exit code was 3 either way, so nothing
 * looked broken; what changed was the message. The unlisted branch falls
 * through to a handler that prefixes "zpl pipe: engine call failed:", and the
 * classes missing from the list are precisely the ones whose entire value is
 * their message. A CI run hitting the upgrade gate got the upgrade
 * instructions buried under a generic prefix.
 *
 * A shared base fixes the class of problem rather than the instance: a site
 * that wants "any error from the engine" says so once, and tomorrow's class is
 * covered the moment it is declared. Sites that deliberately distinguish still
 * can — a subclass satisfies its own instanceof exactly as before.
 *
 * Asserted over the source, because the failure is structural: a class that
 * does not extend the base cannot be caught by a base check, whatever it does
 * at runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = join(ROOT, "src", "api-client.ts");

/** One pass, alternating: a `/*` inside a line comment must not open a block.
 *  The fix's own note names the classes it is about, so a raw scan would read
 *  its own explanation as declarations. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_m, before) => before ?? "");
}

test("every Api*Error extends the shared base", async () => {
  const code = stripComments(await readFile(CLIENT, "utf-8"));

  const declared = [...code.matchAll(/export class (Api\w*Error) extends (\w+)/g)].map((m) => ({
    name: m[1],
    base: m[2],
  }));

  assert.ok(
    declared.length >= 5,
    `only ${declared.length} Api*Error classes found — the scan is not seeing the declarations, ` +
      `so this guard would pass over almost nothing`,
  );

  const base = declared.find((d) => d.name === "ApiError");
  assert.ok(base, "ApiError is gone — the shared base every other class depends on");

  const orphans = declared.filter((d) => d.name !== "ApiError" && d.base !== "ApiError");
  assert.deepEqual(
    orphans.map((o) => `${o.name} extends ${o.base}`),
    [],
    `these error classes do not extend ApiError, so a handler that catches the base will miss ` +
      `them and fall through to whatever generic branch follows: ${orphans
        .map((o) => o.name)
        .join(", ")}`,
  );
});

test("`zpl pipe` catches the base rather than a hand-written list", async () => {
  // Named specifically because this is the site that was wrong, and because a
  // CI gate is where a buried message costs the most: the person reading the
  // log is not the person who can fix the account.
  const code = stripComments(await readFile(join(ROOT, "src", "commands", "pipe.ts"), "utf-8"));

  assert.match(
    code,
    /err instanceof ApiError/,
    "zpl pipe no longer catches ApiError. If it went back to listing classes by hand, the next " +
      "class added will be missed here the same way ApiUpgradeRequiredError was — its message " +
      "wrapped in a generic prefix, on the one command whose output a human may never read " +
      "interactively.",
  );

  const listed = [...code.matchAll(/err instanceof (Api\w+Error)/g)].map((m) => m[1]);
  const handRolled = listed.filter((n) => n !== "ApiError");
  assert.deepEqual(
    handRolled,
    [],
    `zpl pipe still tests individual error classes (${handRolled.join(", ")}) alongside the ` +
      `base. That is the list this guard exists to retire.`,
  );
});
