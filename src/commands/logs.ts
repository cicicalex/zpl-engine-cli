/**
 * `zpl logs` — show recent CLI activity from the local history log.
 *
 * Different from `zpl history`:
 *   - history    = scoring runs (check / pipe / watch / consistency / compare / diff)
 *   - logs       = ALL events, with type filtering for auth events
 *
 * Use cases:
 *   1. "When did I last log in?" — `zpl logs --type auth`
 *   2. "What ran on this box yesterday?" — `zpl logs --limit 50`
 *   3. Compliance / audit — `zpl logs --output json | feed-into-siem`
 *
 * Privacy guarantee: input is SHA-256 hashed at write time (db.ts), so the
 * raw text scored is NEVER in the log. Only command, score, status, tokens.
 *
 * NOTE: today auth events (login / logout / repair) are NOT written to
 * history.json — db.ts only logs scoring commands. This command currently
 * shows all of those, with a TODO to extend appendHistory() to record
 * auth events too in a future minor.
 */
import chalk from "chalk";
import Table from "cli-table3";
import { listHistory, type HistoryRow } from "../db.js";
import { TABLE_STYLE } from "../table-style.js";

export type LogTypeFilter = "all" | "auth" | "scoring";

const AUTH_COMMANDS = new Set(["login", "logout", "repair", "diagnose"]);

export interface LogsOptions {
  limit?: string;
  output?: "text" | "json";
  type?: LogTypeFilter;
}

function filterRows(rows: HistoryRow[], type: LogTypeFilter): HistoryRow[] {
  if (type === "all") return rows;
  if (type === "auth") return rows.filter((r) => AUTH_COMMANDS.has(r.command));
  // type === "scoring"
  return rows.filter((r) => !AUTH_COMMANDS.has(r.command));
}

export async function cmdLogs(opts: LogsOptions = {}): Promise<void> {
  const output = (opts.output ?? "text").toLowerCase();
  if (output !== "text" && output !== "json") {
    process.stderr.write(chalk.red(`Invalid --output: "${opts.output}". Must be text or json.\n`));
    process.exit(2);
  }

  const type = (opts.type ?? "all").toLowerCase() as LogTypeFilter;
  if (!["all", "auth", "scoring"].includes(type)) {
    process.stderr.write(
      chalk.red(`Invalid --type: "${opts.type}". Must be all | auth | scoring.\n`),
    );
    process.exit(2);
  }

  let limit = 50;
  if (opts.limit !== undefined) {
    const n = Number.parseInt(opts.limit, 10);
    if (Number.isNaN(n) || n < 1 || n > 500) {
      process.stderr.write(chalk.red(`Invalid --limit: "${opts.limit}". Must be 1..500.\n`));
      process.exit(2);
    }
    limit = n;
  }

  const all = listHistory(500); // pull everything; filter then trim
  const filtered = filterRows(all, type).slice(0, limit);

  if (output === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          filter: type,
          shown: filtered.length,
          total_in_log: all.length,
          rows: filtered,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (filtered.length === 0) {
    process.stdout.write(
      chalk.gray(
        type === "auth"
          ? `No auth events logged yet. (auth event logging is added in v1.1+ — older runs are not in the log.)\n`
          : `No history yet. Run \`zpl check <file>\` or \`zpl pipe\` first.\n`,
      ),
    );
    return;
  }

  const table = new Table({
    head: [
      chalk.bold("#"),
      chalk.bold("When"),
      chalk.bold("Cmd"),
      chalk.bold("Input Hash"),
      chalk.bold("Score"),
      chalk.bold("Status"),
      chalk.bold("Tokens"),
    ],
    style: TABLE_STYLE,
    colWidths: [5, 22, 12, 18, 7, 22, 8],
    wordWrap: true,
  });
  for (const r of filtered) {
    table.push([
      String(r.id),
      r.timestamp.slice(0, 19).replace("T", " "),
      r.command,
      r.input_hash,
      r.score === null ? "—" : String(r.score),
      r.status ?? "—",
      r.tokens === null ? "—" : String(r.tokens),
    ]);
  }
  process.stdout.write(table.toString() + "\n");
  process.stdout.write(
    chalk.gray(`Showing ${filtered.length} of ${all.length} entries (filter: ${type}).\n`),
  );
}
