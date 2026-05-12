/**
 * `zpl export <format>` — dump local history to stdout in the requested format.
 *
 * Supported formats: json, csv, markdown (md alias).
 *
 * Power users want their history out so they can graph it, audit it, or
 * import it into a spreadsheet. We render to stdout (not a file) so you
 * can pipe it: `zpl export csv > history.csv`.
 *
 * Privacy note: input was hashed (16 chars SHA-256) at write time — raw
 * inputs are NOT in the export. Only command, score, status, tokens.
 */
import chalk from "chalk";
import { listHistory } from "../db.js";
import { readConfig, getConfigPath } from "../config.js";
import { readPkgVersion } from "../user-agent.js";

export type ExportFormat = "json" | "csv" | "markdown" | "md";

export interface ExportOptions {
  /** Optional limit; default = all entries (capped by history file size). */
  limit?: string;
  /**
   * Include config (read-only summary, never the API key) in the export.
   * Aligns with the /cli page that promises "Archive history/config as JSON".
   */
  withConfig?: boolean;
}

const VALID_FORMATS: ExportFormat[] = ["json", "csv", "markdown", "md"];

function csvEscape(value: string): string {
  // RFC 4180: enclose in quotes, escape inner quotes by doubling them.
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function asCsv(rows: ReturnType<typeof listHistory>): string {
  const header = ["id", "timestamp", "command", "input_hash", "score", "status", "tokens"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        String(r.id),
        r.timestamp,
        r.command,
        r.input_hash,
        r.score === null ? "" : String(r.score),
        csvEscape(r.status ?? ""),
        r.tokens === null ? "" : String(r.tokens),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function asMarkdown(rows: ReturnType<typeof listHistory>): string {
  if (rows.length === 0) return "_No history entries._\n";
  const lines = [
    "| ID | Timestamp | Cmd | Input Hash | Score | Status | Tokens |",
    "|---:|-----------|-----|------------|------:|--------|-------:|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.timestamp} | ${r.command} | \`${r.input_hash}\` | ${r.score ?? ""} | ${
        r.status ?? ""
      } | ${r.tokens ?? ""} |`,
    );
  }
  return lines.join("\n") + "\n";
}

export async function cmdExport(format: string, opts: ExportOptions = {}): Promise<void> {
  const fmt = format.toLowerCase() as ExportFormat;
  if (!VALID_FORMATS.includes(fmt)) {
    process.stderr.write(
      chalk.red(`Invalid format: "${format}". Must be one of: ${VALID_FORMATS.join(", ")}.\n`),
    );
    process.exit(2);
  }

  let limit = 9999; // effectively all (history is capped at 500 entries on write)
  if (opts.limit) {
    const n = Number.parseInt(opts.limit, 10);
    if (Number.isNaN(n) || n < 1) {
      process.stderr.write(chalk.red(`Invalid --limit: "${opts.limit}". Must be a positive integer.\n`));
      process.exit(2);
    }
    limit = n;
  }

  const rows = listHistory(limit);

  // Optional config bundle (bug #12 alignment with /cli docs that say
  // "Archive history/config"). Never exports the API key — only safe
  // identity + engine + defaults so a user can audit or move the
  // config between machines after running `zpl login` on the new one.
  const configBundle = opts.withConfig
    ? (() => {
        const cfg = readConfig();
        return {
          cli_version: readPkgVersion(),
          config_path: getConfigPath(),
          user_email: cfg?.auth.user_email ?? null,
          engine_base_url: cfg?.engine.base_url ?? null,
          default_model: cfg?.defaults?.model ?? null,
          api_key_present: Boolean(cfg?.auth.api_key),
          api_key: undefined, // explicit signal to anyone reading: never exported.
        };
      })()
    : null;

  if (fmt === "json") {
    const payload = configBundle ? { config: configBundle, history: rows } : rows;
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (fmt === "csv") {
    if (configBundle) {
      process.stdout.write("# config (no api_key)\n");
      for (const [k, v] of Object.entries(configBundle)) {
        if (v === undefined) continue;
        process.stdout.write(`# ${k}=${v ?? ""}\n`);
      }
      process.stdout.write("\n");
    }
    process.stdout.write(asCsv(rows));
  } else {
    // markdown / md
    if (configBundle) {
      process.stdout.write("## Config (no API key)\n\n");
      for (const [k, v] of Object.entries(configBundle)) {
        if (v === undefined) continue;
        process.stdout.write(`- **${k}**: ${v ?? "(unset)"}\n`);
      }
      process.stdout.write("\n## History\n\n");
    }
    process.stdout.write(asMarkdown(rows));
  }
}
