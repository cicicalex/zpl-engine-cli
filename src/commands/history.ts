import chalk from "chalk";
import Table from "cli-table3";
import { listHistory } from "../db.js";
import { TABLE_STYLE } from "../table-style.js";

export async function cmdHistory(): Promise<void> {
  const rows = listHistory(20);
  if (rows.length === 0) {
    process.stdout.write(chalk.gray("No history yet. Run `zpl check <file>` first.\n"));
    return;
  }
  const table = new Table({
    head: [
      chalk.bold("#"),
      chalk.bold("When"),
      chalk.bold("Cmd"),
      chalk.bold("Input"),
      chalk.bold("Score"),
      chalk.bold("Status"),
      chalk.bold("Tokens"),
    ],
    style: TABLE_STYLE,
    colWidths: [5, 22, 12, 18, 7, 22, 8],
    wordWrap: true,
  });
  for (const r of rows) {
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
}
