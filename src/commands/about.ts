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
  command_count: number;
  commands: { name: string; purpose: string }[];
  scoring: {
    range: string;
    engine_scale: string;
    bands_are: string;
    bands: { score: string; meaning: string }[];
  };
  links: { docs: string; repo: string; npm: string; engine_status: string };
  free_plan: string;
  privacy: {
    data_sent_to_engine: string;
    data_stored_locally: string;
    telemetry: string;
    config_file_mode: string;
  };
  security: {
    transport: string;
    engine_url_allowlist: string;
    secret_redaction: string;
    backup_safety: string;
  };
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

/**
 * Every top-level command registered in src/index.ts, in registration order.
 *
 * Keep this list in sync with `program.command(...)` there — `command_count`
 * is derived from it, so there is exactly one number to maintain and no way
 * for the manifest to advertise a count that disagrees with the list.
 * `config` is one command with five subcommands (get/set/unset/list/edit);
 * they are not counted separately.
 */
const COMMANDS: { name: string; purpose: string }[] = [
  { name: "login", purpose: "Device-flow login (memory-aware: skips if already logged in)" },
  { name: "logout", purpose: "Remove local credentials" },
  { name: "whoami", purpose: "Show logged-in user, plan, and quota" },
  { name: "diagnose", purpose: "Health check: config + key + engine + auth" },
  { name: "repair", purpose: "Wipe config + auto re-login (with backup/restore)" },
  { name: "check [file]", purpose: "Score a file — or stdin when no file is given" },
  { name: "watch [file]", purpose: "Score on every clipboard paste, or on every save of <file>" },
  { name: "consistency <q>", purpose: "Probe engine determinism over N identical calls" },
  { name: "compare <a> <b>", purpose: "Score two files head-to-head" },
  { name: "diff <before> <after>", purpose: "Semantic delta: improved/worsened/unchanged" },
  { name: "history", purpose: "Show last 20 scored runs (input is hashed for privacy)" },
  { name: "pipe", purpose: "Score stdin (Unix-style); --threshold for CI gates" },
  { name: "about", purpose: "This manifest — text or JSON" },
  { name: "quota", purpose: "Tokens used and remaining this month" },
  { name: "plans", purpose: "Catalogue of plans with monthly quotas and prices" },
  { name: "export <format>", purpose: "Export local history as json / csv / markdown" },
  { name: "update", purpose: "Check for a newer npm version (--apply installs it)" },
  { name: "completion <shell>", purpose: "Emit a bash/zsh/fish/powershell completion script" },
  { name: "config", purpose: "get / set / unset / list / edit ~/.zpl/config.toml" },
  { name: "logs", purpose: "Recent CLI activity from the local log" },
];

function buildManifest(): AboutManifest {
  return {
    name: "zpl-engine-cli",
    version: readVersion(),
    what_is_zpl:
      "ZPL (Zero Point Logic) is a mathematical stability and bias engine. " +
      "Given any text, dataset, or distribution, it returns an AIN " +
      "(AI Neutrality Index) on a 0.0–1.0 scale indicating how balanced or " +
      "biased the input is; this CLI presents it as a percentage. The " +
      "scoring formula is published in a Zenodo DOI and produces " +
      "deterministic, reproducible results.",
    what_does_the_cli_do:
      "Score files, clipboard pastes, or piped stdin for bias / neutrality / " +
      "sycophancy. Useful as a CI gate (block AI-generated content below a " +
      "threshold), as a clipboard watcher, or as a one-shot check.",
    why_use_cli_over_mcp:
      "The MCP exposes scores TO the AI, which can then modify its own output " +
      "to look better (observer effect). The CLI runs as a separate process " +
      "AFTER the AI has produced its output — the AI never sees the score, " +
      "so the result is independent verification rather than self-report.",
    command_count: COMMANDS.length,
    commands: COMMANDS,
    scoring: {
      range:
        "0.00–100.00. The CLI reports the engine's AIN multiplied by 100 and " +
        "keeps 2 decimals — it is NOT rounded to a whole number.",
      engine_scale:
        "The engine itself returns `ain` on a 0.0–1.0 scale. Percentage is a " +
        "presentation choice made by this CLI, not a different measurement.",
      bands_are:
        "CLI verdict bands (the `verdict` field). They are NOT the engine's " +
        "`ain_status` enum, which has its own thresholds and is passed " +
        "through unmodified in the `ain_status` field.",
      bands: [
        { score: ">= 80", meaning: "highly balanced, trustworthy" },
        { score: "60 to <80", meaning: "moderately balanced" },
        { score: "40 to <60", meaning: "noticeable bias" },
        { score: "< 40", meaning: "heavily biased" },
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
    privacy: {
      data_sent_to_engine:
        "Your raw text NEVER leaves this machine. Sentiment analysis runs locally (src/sentiment.ts) and the only thing posted to the engine is the distilled triple {d, bias, samples} — a dimension, a single bias number 0-1, and a sample count. The engine logs that request for billing purposes only; it is not used to train any model.",
      data_stored_locally:
        "~/.zpl/config.toml (your API key, mode 0600 on POSIX) and ~/.zpl/history.json (one row per scored input — input is SHA-256 hashed BEFORE storage, so the raw text is never written to disk).",
      telemetry:
        "None. The CLI makes ONE outbound check per startup to npm registry to detect new versions. Disable with ZPL_SKIP_UPDATE_CHECK=1.",
      config_file_mode:
        "0600 on POSIX (owner read/write only). On Windows NTFS, owner-only by default. Use `zpl diagnose` to verify.",
    },
    security: {
      transport:
        "HTTPS only — http:// engine URLs are rejected at config load.",
      engine_url_allowlist:
        "Engine host must be in *.zeropointlogic.io. Self-hosters: set ZPL_ENGINE_HOST_ALLOWLIST=\"your-host.com\". A hostile config.toml or env var pointing to attacker.com cannot exfiltrate your key — the URL is rejected before any request is sent.",
      secret_redaction:
        "All secret-shaped strings (zpl_u_*, zpl_s_*, Bearer tokens, sk-ant-*, sk-*, gsk_*) are redacted in: history.json status field, error messages on stderr, and `zpl diagnose` output. Defence in depth so a leak in one layer does not propagate.",
      backup_safety:
        "`zpl repair` backs up your config to ~/.zpl/config.toml.bak with mode 0600 BEFORE deletion, and prints restore instructions if the subsequent login fails. You cannot lose your key by running repair.",
    },
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
  w(chalk.bold(`Commands (${m.command_count}):`));
  for (const c of m.commands) {
    w(`  ${chalk.cyan(c.name.padEnd(22))}  ${chalk.gray(c.purpose)}`);
  }
  w("");
  w(chalk.bold("AIN scoring:"));
  w(`  ${chalk.gray(m.scoring.range)}`);
  w(`  ${chalk.gray(m.scoring.engine_scale)}`);
  w("");
  w(chalk.bold("Verdict bands:"));
  for (const b of m.scoring.bands) {
    w(`  ${chalk.cyan(b.score.padEnd(10))}  ${chalk.gray(b.meaning)}`);
  }
  w(`  ${chalk.gray(m.scoring.bands_are)}`);
  w("");
  w(chalk.bold("Privacy:"));
  w(`  ${chalk.gray("Data sent:")}     ${m.privacy.data_sent_to_engine}`);
  w(`  ${chalk.gray("Stored locally:")} ${m.privacy.data_stored_locally}`);
  w(`  ${chalk.gray("Telemetry:")}     ${m.privacy.telemetry}`);
  w(`  ${chalk.gray("Config mode:")}   ${m.privacy.config_file_mode}`);
  w("");
  w(chalk.bold("Security:"));
  w(`  ${chalk.gray("Transport:")}     ${m.security.transport}`);
  w(`  ${chalk.gray("URL allowlist:")} ${m.security.engine_url_allowlist}`);
  w(`  ${chalk.gray("Redaction:")}     ${m.security.secret_redaction}`);
  w(`  ${chalk.gray("Backup safety:")} ${m.security.backup_safety}`);
  w("");
  w(chalk.bold("Links:"));
  w(`  Docs        ${chalk.cyan(m.links.docs)}`);
  w(`  Repo        ${chalk.cyan(m.links.repo)}`);
  w(`  npm         ${chalk.cyan(m.links.npm)}`);
  w(`  Engine      ${chalk.cyan(m.links.engine_status)}`);
  w("");
  w(chalk.gray(m.free_plan));
}
