/**
 * Nothing this package publishes may advertise a version other than the one
 * being published.
 *
 * AUDIT 2026-08-01, measured the morning of the deploy. npm serves 1.2.1; the
 * tree is at 1.3.0 and unpublished. Three surfaces disagreed with it:
 *
 *   package.json version    1.3.0
 *   package.json description  led with "v1.1.6: fixed an inverted-bias
 *                             regression..." — release notes for a version two
 *                             minors old, and one with no changelog entry at all
 *   package-lock.json root  1.0.0, in two places
 *   CHANGELOG.md            1.3.0's breaking stdout change filed under
 *                             [Unreleased], below the [1.3.0] heading
 *
 * The description is the one that costs something. npm renders it on the
 * package page and in search results, it cannot be edited without publishing
 * again, and a customer reading it learns what changed in 1.1.6 while
 * installing 1.3.0. The fix was to stop putting release notes there at all —
 * an evergreen description cannot go stale, and CHANGELOG.md is where notes
 * belong.
 *
 * The changelog one is the one that breaks scripts. `zpl pipe` now prints
 * `ain_status=` where it printed `status=`, and AIN moved from an integer to
 * two decimals. Both are in the 1.3.0 code — `src/ain-scale.ts` does not exist
 * at tag v1.2.1 — so filing them as unreleased means anyone whose CI greps
 * `status=` gets no warning from the notes for the release that breaks them.
 *
 * The lock is the mild one: measured, `npm ci --dry-run` exits 0 with the root
 * version stale, and package-lock is not in `files` so it never ships. Checked
 * anyway — a guard that exempts the harmless surface is where the next drift
 * lands.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function readJson(name) {
  let raw;
  try {
    raw = await readFile(join(ROOT, name), "utf-8");
  } catch (err) {
    assert.fail(`${name} could not be read (${err.code}) — this guard would otherwise check nothing`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    assert.fail(`${name} is not valid JSON: ${err.message}`);
  }
}

const pkg = await readJson("package.json");
const VERSION = pkg.version;

/**
 * Version-shaped tokens in prose.
 *
 * Two forms count: three components (1.1.6), or a `v` prefix on two (v4.1).
 * Both are what actually went stale. A bare two-component number is left alone
 * so ordinary prose — "1.5 seconds", "0.5 bias" — does not read as a release,
 * and runs of four or more components are addresses rather than versions.
 */
function versionTokens(text) {
  const out = [];
  for (const m of text.matchAll(/(v?)(\d+(?:\.\d+)+)/gi)) {
    const parts = m[2].split(".");
    if (parts.length > 3) continue;
    if (parts.length === 3 || (parts.length === 2 && m[1])) out.push(m[2]);
  }
  return out;
}

test("package.json carries a real semver version", () => {
  assert.match(
    VERSION ?? "",
    /^\d+\.\d+\.\d+(?:-[\w.]+)?$/,
    `package.json version is ${JSON.stringify(VERSION)}; every assertion below compares against it`,
  );
});

test("the npm description does not advertise a different version", () => {
  const desc = pkg.description ?? "";
  assert.ok(desc.length > 0, "package.json has no description — npm would show the package with none");

  const wrong = versionTokens(desc).filter((v) => v !== VERSION);
  assert.deepEqual(
    wrong,
    [],
    `the npm description names ${wrong.join(", ")} while this package publishes as ${VERSION}. ` +
      `npm renders this on the package page and in search results and it cannot be edited without ` +
      `publishing again. Keep the description evergreen and put release notes in CHANGELOG.md, ` +
      `where they do not have to be maintained in two places.`,
  );
});

test("the lock file's root version matches the manifest", async () => {
  const lock = await readJson("package-lock.json");
  assert.equal(lock.version, VERSION, `package-lock.json root version is ${lock.version}, package is ${VERSION}`);
  assert.equal(
    lock.packages?.[""]?.version,
    VERSION,
    `package-lock.json packages[""].version is ${lock.packages?.[""]?.version}, package is ${VERSION}`,
  );
});

test("the changelog documents this version, and nothing shipping is filed as unreleased", async () => {
  let changelog;
  try {
    changelog = await readFile(join(ROOT, "CHANGELOG.md"), "utf-8");
  } catch (err) {
    assert.fail(`CHANGELOG.md could not be read (${err.code})`);
  }

  const headings = [...changelog.matchAll(/^##\s*\[([^\]]+)\]/gm)].map((m) => m[1]);

  assert.ok(
    headings.includes(VERSION),
    `CHANGELOG.md has no "## [${VERSION}]" entry. Headings present: ${headings.slice(0, 6).join(", ")}`,
  );

  // An [Unreleased] section is normal mid-development. It is not normal when it
  // sits BELOW the heading for the version being published: everything under it
  // is code that ships in that release while its notes say otherwise. That is
  // exactly how 1.3.0's stdout change came to be undocumented.
  const unreleasedAt = headings.indexOf("Unreleased");
  const versionAt = headings.indexOf(VERSION);
  assert.ok(
    unreleasedAt === -1 || unreleasedAt < versionAt,
    `CHANGELOG.md files an [Unreleased] section below the [${VERSION}] heading. Anything under it ` +
      `is in the build that publishes as ${VERSION}, so its notes claim those changes have not ` +
      `shipped. Fold it into the release, or move it above the heading if it genuinely is not ` +
      `going out.`,
  );
});
