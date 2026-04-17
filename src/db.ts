/**
 * SQLite history DB under ~/.zpl/history.db.
 * Created lazily on first write; schema is idempotent so upgrades are a no-op.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { getHistoryDbPath, ensureConfigDir } from "./config.js";

export interface HistoryRow {
  id: number;
  timestamp: string;
  command: string;
  input_hash: string;
  score: number | null;
  status: string | null;
  tokens: number | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  ensureConfigDir();
  _db = new Database(getHistoryDbPath());
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      command TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      score REAL,
      status TEXT,
      tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp DESC);
  `);
  return _db;
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
  const db = getDb();
  db.prepare(
    `INSERT INTO history (timestamp, command, input_hash, score, status, tokens)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    args.command,
    hashInput(args.input),
    args.score ?? null,
    args.status ?? null,
    args.tokens ?? null,
  );
}

export function listHistory(limit = 20): HistoryRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM history ORDER BY id DESC LIMIT ?`)
    .all(limit) as HistoryRow[];
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
