/**
 * Local history log at ~/.zpl/history.json.
 *
 * We deliberately avoid `better-sqlite3` (and any other native module) so
 * install is `npm install -g zpl-engine-cli` with zero Python / VC++ build
 * dependencies. The log is capped at MAX_ENTRIES to keep the file small;
 * anyone who actually needs a real queryable history can pipe `zpl check`
 * output to whatever they want.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, ensureConfigDir } from "./config.js";

const MAX_ENTRIES = 500;

export interface HistoryRow {
  id: number;
  timestamp: string;
  command: string;
  input_hash: string;
  score: number | null;
  status: string | null;
  tokens: number | null;
}

function historyPath(): string {
  return join(getConfigDir(), "history.json");
}

function readAll(): HistoryRow[] {
  const path = historyPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop anything missing required fields rather than crash.
    return parsed.filter(
      (r): r is HistoryRow =>
        r && typeof r.id === "number" && typeof r.timestamp === "string" && typeof r.command === "string",
    );
  } catch {
    // Corrupted file — treat as empty, next write will overwrite cleanly.
    return [];
  }
}

function writeAll(rows: HistoryRow[]): void {
  ensureConfigDir();
  const capped = rows.length > MAX_ENTRIES ? rows.slice(-MAX_ENTRIES) : rows;
  writeFileSync(historyPath(), JSON.stringify(capped, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function hashInput(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface AppendHistoryArgs {
  command: string;
  input: string;
  score?: number | null;
  status?: string | null;
  tokens?: number | null;
}

export function appendHistory(args: AppendHistoryArgs): void {
  const rows = readAll();
  const nextId = rows.length > 0 ? rows[rows.length - 1]!.id + 1 : 1;
  rows.push({
    id: nextId,
    timestamp: new Date().toISOString(),
    command: args.command,
    input_hash: hashInput(args.input),
    score: args.score ?? null,
    status: args.status ?? null,
    tokens: args.tokens ?? null,
  });
  writeAll(rows);
}

export function listHistory(limit = 20): HistoryRow[] {
  const rows = readAll();
  // Newest first, like the previous SQL query ORDER BY id DESC LIMIT ?.
  return rows.slice(-limit).reverse();
}

export function closeDb(): void {
  // No-op — JSON backend has nothing to close. Kept for API compat with callers.
}
