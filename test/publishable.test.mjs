/**
 * What `npm publish` would actually put on the registry.
 *
 * AUDIT 2026-08-01, measured the morning of the deploy, on the CLI:
 *
 *   package.json  main   dist/index.js
 *   package.json  files  ["dist/", "README.md", "LICENSE"]
 *   .gitignore    line 2 dist/
 *   package.json  scripts   no prepublishOnly, no prepack, no prepare
 *
 * So the tarball contains whatever happens to be sitting in dist/ when the
 * publish command runs. From a clean clone that is nothing. Measured with
 * `npm pack --dry-run` after moving dist/ aside:
 *
 *   with dist present:  108 files, 436.8 kB
 *   without dist:         3 files,  11.3 kB
 *
 * Three files: README, LICENSE, package.json. `main` points at a path the
 * tarball does not contain, so `npx zpl-engine-cli` fails to resolve its entry
 * point. And npm does not let you republish a version, so the fix would be a
 * version burn on every package published that way.
 *
 * All three npm packages had the same hole. It only stayed invisible because
 * `npm test` runs `npm run build` first, so any machine that had run the tests
 * happened to have a populated dist/.
 *
 * Second rule here, same publish, same permanence: `engines.node` said ">=18"
 * while undici@7.25.0 - imported at startup by src/proxy.ts:29, which
 * src/index.ts loads before anything that touches fetch - declares
 * ">=20.18.1". A published engines range cannot be corrected either.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));

const HOOKS = ["prepublishOnly", "prepack", "prepare"];

test("publishing runs the build that produces what `main` points at", async () => {
  const files = pkg.files ?? [];
  const main = (pkg.main ?? "").replace(/^\.\//, "");

  assert.ok(files.length > 0, "package.json has no `files` allowlist — publish would ship the whole tree");
  assert.ok(main, "package.json has no `main`");

  // Is `main` inside one of the allowlisted directories?
  const mainDir = main.split("/")[0];
  const shipsBuildOutput = files.some((f) => f.replace(/\/$/, "") === mainDir);

  if (!shipsBuildOutput) return; // main is a committed file; nothing to build

  assert.ok(
    pkg.scripts?.build,
    `main is ${main} and \`files\` ships ${mainDir}/, but there is no build script to produce it`,
  );

  const hook = HOOKS.find((h) => pkg.scripts?.[h]);
  assert.ok(
    hook,
    `main is ${main}, which lives in ${mainDir}/ — a build output that is not committed. ` +
      `Nothing in package.json builds it at publish time, so \`npm publish\` from a clean clone ` +
      `ships a tarball whose entry point is missing. Measured on this package: 3 files and ` +
      `11.3 kB without dist/, against 108 files and 436.8 kB with it. npm does not allow ` +
      `republishing a version, so the recovery is a version burn. Add "prepublishOnly": "npm run build".`,
  );

  assert.match(
    pkg.scripts[hook],
    /\bbuild\b/,
    `${hook} is "${pkg.scripts[hook]}" and does not run the build. The hook exists but does not ` +
      `close the hole it is here for.`,
  );
});

/**
 * The lowest Node a range admits.
 *
 * Alternatives separated by `||` widen the range, so the minimum of a
 * dependency's own range is the LOWEST of its alternatives — "^18.17.0 ||
 * >=20.5.0" runs on 18.17.0. Across dependencies the binding constraint is the
 * HIGHEST of those minima. Getting these two the wrong way round would turn
 * this guard into a formality that never fires.
 */
function minNode(range) {
  if (!range || typeof range !== "string") return null;
  const mins = [];
  for (const alt of range.split("||")) {
    const m = alt.match(/(\d+)\.(\d+)\.(\d+)|(\d+)\.(\d+)|(\d+)/);
    if (!m) continue;
    const nums = m[0].split(".").map(Number);
    while (nums.length < 3) nums.push(0);
    mins.push(nums);
  }
  if (!mins.length) return null;
  mins.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return mins[0];
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const fmt = (v) => v.join(".");

test("engines.node is not looser than what the dependencies require", async () => {
  const declared = minNode(pkg.engines?.node);
  assert.ok(declared, `package.json declares engines.node = ${JSON.stringify(pkg.engines?.node)}`);

  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length === 0) {
    // A package with no runtime dependencies has nothing here to violate. The
    // SDK is deliberately dependency-free, and the first version of this guard
    // failed it for that — treating an intentional design as a broken checkout.
    // Not silently skipped. npm never writes an empty `dependencies` object, so
    // demanding one would impose a convention rather than check a fact. The
    // lock file is the fact: npm maintains its root entry, and a package that
    // genuinely has no runtime dependencies has none there either.
    let lock;
    try {
      lock = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf-8"));
    } catch (err) {
      assert.fail(
        `package.json lists no runtime dependencies and package-lock.json could not be read ` +
          `(${err.code}), so there is no way to tell a dependency-free package from a manifest ` +
          `that lost its dependencies`,
      );
    }
    const locked = Object.keys(lock.packages?.[""]?.dependencies ?? {});
    assert.deepEqual(
      locked,
      [],
      `package.json declares no runtime dependencies but package-lock.json records ${locked.join(", ")} ` +
        `at the root. One of the two is wrong, and the engines check above silently covered nothing.`,
    );
    return;
  }

  const violations = [];
  let inspected = 0;

  for (const name of deps) {
    let depPkg;
    try {
      depPkg = JSON.parse(await readFile(join(ROOT, "node_modules", ...name.split("/"), "package.json"), "utf-8"));
    } catch {
      continue; // not installed in this checkout
    }
    inspected += 1;
    const need = minNode(depPkg.engines?.node);
    if (need && cmp(need, declared) > 0) {
      violations.push(`${name}@${depPkg.version} needs node ${depPkg.engines.node}`);
    }
  }

  assert.ok(
    inspected > 0,
    "no dependency package.json could be read — run npm install; this guard checks nothing without node_modules",
  );

  assert.deepEqual(
    violations,
    [],
    `this package promises node ${pkg.engines.node} (min ${fmt(declared)}) but ships dependencies that ` +
      `refuse it:\n  ${violations.join("\n  ")}\n\nThe engines field goes into the published tarball and ` +
      `cannot be corrected afterwards, so anyone on a Node this package claims to support installs ` +
      `something that will not run.`,
  );
});
