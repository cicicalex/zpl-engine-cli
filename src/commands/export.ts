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

export type ExportFormat = "json" | "csv" | "markdown" | "md";

export interface ExportOptions {
  /** Optional limit; default = all entries (capped by history file size). */
  limit?: string;
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

  if (fmt === "json") {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else if (fmt === "csv") {
    process.stdout.write(asCsv(rows));
  } else {
    // markdown / md
    process.stdout.write(asMarkdown(rows));
  }
}
