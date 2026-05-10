/**
 * `zpl about` — what is ZPL, what does this CLI do, where to learn more.
 *
 * Designed as the first command an AI agent (or curious human) runs after
 * installing. Returns plain text by default; `--output json` returns a
 * machine-readable manifest agents can use to decide whether ZPL is the
 * right tool for the task they're working on.
 */
import chalk from "chalk";
import { createRequire } from "node:module";

interface AboutManifest {
  name: string;
  version: string;
  what_is_zpl: string;
  what_does_the_cli_do: string;
  why_use_cli_over_mcp: string;
  commands: { name: string; purpose: string }[];
  scoring: { range: string; bands: { score: string; meaning: string }[] };
  links: { docs: string; repo: string; npm: string; engine_status: string };
  free_plan: string;
}

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildManifest(): AboutManifest {
  return {
    name: "zpl-engine-cli",
    version: readVersion(),
    what_is_zpl:
      "ZPL (Zero Point Logic) is a mathematical stability and bias engine. " +
      "Given any text, dataset, or distribution, it returns an AIN " +
      "(AI Neutrality Index) score from 0 to 100 indicating how balanced or " +
      "biased the input is. The scoring formula is published in a Zenodo DOI " +
      "and produces deterministic, reproducible results.",
    what_does_the_cli_do:
      "Score files, clipboard pastes, or piped stdin for bias / neutrality / " +
      "sycophancy. Useful as a CI gate (block AI-generated content below a " +
      "threshold), as a clipboard watcher, or as a one-shot check.",
    why_use_cli_over_mcp:
      "The MCP exposes scores TO the AI, which can then modify its own output " +
      "to look better (observer effect). The CLI runs as a separate process " +
      "AFTER the AI has produced its output — the AI never sees the score, " +
      "so the result is independent verification rather than self-report.",
    commands: [
      { name: "login", purpose: "Device-flow login (memory-aware: skips if already logged in)" },
      { name: "logout", purpose: "Remove local credentials" },
      { name: "whoami", purpose: "Show logged-in user, plan, and quota" },
      { name: "diagnose", purpose: "Health check: config + key + engine + auth" },
      { name: "repair", purpose: "Wipe config + auto re-login (with backup/restore)" },
      { name: "check <file>", purpose: "Score a single file for bias / neutrality" },
      { name: "pipe", purpose: "Score stdin (Unix-style); --threshold for CI gates" },
      { name: "watch", purpose: "Score every new clipboard paste in real time" },
      { name: "consistency <q>", purpose: "Probe engine determinism over N identical calls" },
      { name: "compare <a> <b>", purpose: "Score two files head-to-head" },
      { name: "diff <before> <after>", purpose: "Semantic delta: improved/worsened/unchanged" },
      { name: "history", purpose: "Show last 20 scored runs (input is hashed for privacy)" },
    ],
    scoring: {
      range: "0–100, integer",
      bands: [
        { score: "80–100", meaning: "highly balanced, trustworthy" },
        { score: "60–79", meaning: "moderately balanced" },
        { score: "40–59", meaning: "noticeable bias" },
        { score: "0–39", meaning: "heavily biased" },
      ],
    },
    links: {
      docs: "https://zeropointlogic.io/docs",
      repo: "https://github.com/cicicalex/zpl-engine-cli",
      npm: "https://www.npmjs.com/package/zpl-engine-cli",
      engine_status: "https://engine.zeropointlogic.io/health",
    },
    free_plan:
      "5,000 tokens/month, no credit card required. Sign up at zeropointlogic.io.",
  };
}

export interface AboutOptions {
  output?: "text" | "json";
}

export async function cmdAbout(opts: AboutOptions = {}): Promise<void> {
  const m = buildManifest();
  const output = (opts.output ?? "text").toLowerCase();

  if (output === "json") {
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
    return;
  }

  // Human-readable output. Keep narrow (80 cols) so it reads on small terms.
  const w = (s: string) => process.stdout.write(s + "\n");

  w(chalk.bold.cyan(`${m.name} v${m.version}`));
  w("");
  w(chalk.bold("What is ZPL?"));
  w("  " + m.what_is_zpl);
  w("");
  w(chalk.bold("What does this CLI do?"));
  w("  " + m.what_does_the_cli_do);
  w("");
  w(chalk.bold("Why CLI over MCP?"));
  w("  " + m.why_use_cli_over_mcp);
  w("");
  w(chalk.bold("Commands:"));
  for (const c of m.commands) {
    w(`  ${chalk.cyan(c.name.padEnd(22))}  ${chalk.gray(c.purpose)}`);
  }
  w("");
  w(chalk.bold("AIN scoring:"));
  for (const b of m.scoring.bands) {
    w(`  ${chalk.cyan(b.score.padEnd(8))}  ${chalk.gray(b.meaning)}`);
  }
  w("");
  w(chalk.bold("Links:"));
  w(`  Docs        ${chalk.cyan(m.links.docs)}`);
  w(`  Repo        ${chalk.cyan(m.links.repo)}`);
  w(`  npm         ${chalk.cyan(m.links.npm)}`);
  w(`  Engine      ${chalk.cyan(m.links.engine_status)}`);
  w("");
  w(chalk.gray(m.free_plan));
}
