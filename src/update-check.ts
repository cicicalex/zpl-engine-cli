/**
 * Version check with forced-upgrade policy — mirrors the MCP's implementation
 * so users on the CLI and MCP both get the same upgrade cadence + safety net.
 *
 *  - MAJOR version behind  -> BLOCK (exit 1). Breaking changes or security fix.
 *  - MINOR version behind  -> WARN but continue. New features available.
 *  - PATCH version behind  -> WARN quietly. Bug fixes available.
 *  - Up-to-date / ahead    -> silent.
 *
 * Cache: 1 h (so stuck users retry npm soon after a new major lands).
 * Bypass: set `ZPL_SKIP_UPDATE_CHECK=1` (for self-hosted / offline / CI).
 * Network errors are non-fatal — never blocks startup if npm is unreachable.
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SemverParts = { major: number; minor: number; patch: number };

function parseSemver(v: string): SemverParts | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 if a<b, 0 if equal, +1 if a>b, or null if either unparseable. */
function cmpSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

export type UpdateCheckResult = "ok" | "block";

/**
 * Run the version check. Call this at CLI startup, before parsing args, and
 * exit early if it returns "block" so no command can run against a version
 * that has a known breaking/security issue.
 */
export async function checkLatestVersion(currentVersion: string): Promise<UpdateCheckResult> {
  if (process.env.ZPL_SKIP_UPDATE_CHECK === "1") return "ok";

  try {
    const cacheFile = join(tmpdir(), "zpl-cli-version-check.json");

    // Short cache (1 h) — so stuck users retry npm soon after a new major lands.
    let cachedLatest: string | undefined;
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf-8")) as { checkedAt: number; latest: string };
      if (Date.now() - cached.checkedAt < 60 * 60 * 1000) {
        cachedLatest = cached.latest;
      }
    } catch {
      // no cache, continue
    }

    let latest = cachedLatest;
    if (!latest) {
      const res = await fetch("https://registry.npmjs.org/zpl-engine-cli/latest", {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return "ok"; // npm unreachable — do not block startup
      const body = (await res.json()) as { version?: string };
      if (!body.version) return "ok";
      latest = body.version;
      await writeFile(cacheFile, JSON.stringify({ checkedAt: Date.now(), latest })).catch(() => {});
    }

    const ord = cmpSemver(currentVersion, latest);
    if (ord === null || ord >= 0) return "ok"; // up-to-date or ahead (dev build)

    const pc = parseSemver(currentVersion)!;
    const pl = parseSemver(latest)!;

    if (pl.major > pc.major) {
      // HARD BLOCK — major version behind. Likely breaking change or security fix.
      process.stderr.write("\n");
      process.stderr.write("┌──────────────────────────────────────────────────────────────┐\n");
      process.stderr.write("│  zpl-engine-cli: required upgrade                            │\n");
      process.stderr.write("├──────────────────────────────────────────────────────────────┤\n");
      process.stderr.write(`│  You have v${currentVersion.padEnd(14)} Latest is v${latest.padEnd(14)}  │\n`);
      process.stderr.write("│  A new MAJOR version is available — upgrade is required.    │\n");
      process.stderr.write("│                                                              │\n");
      process.stderr.write("│  Update:                                                     │\n");
      process.stderr.write("│    npm i -g zpl-engine-cli@latest                            │\n");
      process.stderr.write("│                                                              │\n");
      process.stderr.write("│  Or run any command via npx:                                 │\n");
      process.stderr.write("│    npx zpl-engine-cli@latest <command>                       │\n");
      process.stderr.write("│                                                              │\n");
      process.stderr.write("│  Offline / self-hosted override (not recommended):           │\n");
      process.stderr.write("│    env ZPL_SKIP_UPDATE_CHECK=1                               │\n");
      process.stderr.write("└──────────────────────────────────────────────────────────────┘\n");
      process.stderr.write("\n");
      return "block";
    }

    // MINOR or PATCH behind — warn but continue.
    const severity = pl.minor > pc.minor ? "new features" : "bug fixes";
    process.stderr.write(`\nℹ️  zpl-engine-cli v${latest} is available (${severity}). You have v${currentVersion}.\n`);
    process.stderr.write(`   Update: npm i -g zpl-engine-cli@latest\n\n`);
    return "ok";
  } catch {
    // Any unexpected error — never block. Version check is best-effort.
    return "ok";
  }
}
