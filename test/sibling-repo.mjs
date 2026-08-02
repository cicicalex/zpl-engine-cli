/**
 * Where the other ZPL repos are, and what to do when they are not there.
 *
 * AUDIT 2026-08-02. Three test files here read source out of the engine and the
 * website to check that this package agrees with them. Each did it through an
 * absolute path on one developer's machine, and each swallowed the failure to
 * open it:
 *
 *     try { rust = await readFile(ENGINE_AIN_RS, "utf-8"); } catch { return; }
 *
 * Measured: the engine's `ain.rs` was moved aside and the suite reported
 *
 *     tests 6   pass 6   fail 0   skipped 0   exit 0
 *
 * So on any machine that is not that one - a contributor's, a build server's,
 * a fresh clone - the check that the bands here match the engine's does not run
 * and says it passed. The bands could drift from the engine and nothing would
 * notice.
 *
 * Two things are wrong with that and this module fixes both.
 *
 * The path is no longer a machine's. It comes from an environment variable if
 * one is set, otherwise from a sibling directory next to this repo, which is
 * how the repos are actually laid out. An absolute path in a public repo also
 * published the private repos' names, which is its own small problem.
 *
 * And absence is now visible. A cross-repo check that cannot find its source
 * reports SKIPPED, which the runner counts separately, instead of reporting a
 * pass it did not earn. Nobody is expected to have the private repos checked
 * out; they are expected not to be told a check ran when it did not.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** test/ -> repo root */
const REPO = dirname(HERE);
/** the directory the sibling repos live in */
const NEIGHBOURS = dirname(REPO);

/**
 * Roots of the repos this one is checked against.
 *
 * Environment variables win, so a build server can point them anywhere. The
 * fallbacks are relative, so a normal checkout beside this one just works.
 */
export const ROOTS = {
  engine: process.env.ZPL_ENGINE_SOURCE || resolve(NEIGHBOURS, "..", "zpl-engine-source"),
  clients: process.env.ZPL_CLIENTS_ROOT || NEIGHBOURS,
  site: process.env.ZPL_SITE_ROOT || resolve(NEIGHBOURS, "..", "..", "Dev", "ZPL-Private", "zpl-nodeweb"),
};

/** A path inside one of those repos. */
export function sibling(which, ...parts) {
  const root = ROOTS[which];
  if (!root) throw new Error(`unknown sibling repo: ${which}`);
  return join(root, ...parts);
}

/**
 * Read a file from a sibling repo, or tell the caller it is not there.
 *
 * Returns the text, or null. Never throws for absence — the caller decides,
 * and the only correct decision is to skip visibly.
 */
export async function readSibling(which, ...parts) {
  const path = sibling(which, ...parts);
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * The sentence a skipped cross-repo check prints.
 *
 * Names the repo and the variable that would make it run, so somebody reading a
 * skipped test knows what to do about it rather than assuming it is broken.
 */
export function whySkipped(which, ...parts) {
  const vars = { engine: "ZPL_ENGINE_SOURCE", clients: "ZPL_CLIENTS_ROOT", site: "ZPL_SITE_ROOT" };
  return (
    `${which} repo not available at ${sibling(which, ...parts)} — this check compares ` +
    `this package against it and cannot run. Set ${vars[which]} to where it is checked out.`
  );
}
