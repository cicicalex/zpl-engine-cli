/**
 * Local history log at ~/.zpl/history.json.
 *
 * We deliberately avoid `better-sqlite3` (and any other native module) so
 * install is `npm install -g zpl-engine-cli` with zero Python / VC++ build
 * dependencies. The log is capped at MAX_ENTRIES to keep the file small;
 * anyone who actually needs a real queryable history can pipe `zpl check`
 * output to whatever they want.
 *
 * v1.0.0 privacy notes:
 *   - Inputs are SHA-256 hashed before persistence (see hashInput) — the
 *     raw text is never written to disk.
 *   - Status field is sanitised by sanitiseStatus() to redact any keys an
 *     engine response might accidentally echo back. Defence in depth: the
 *     engine should never put secrets here, but the cost of redacting is
 *     near-zero and a leak would be permanent.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, ensureConfigDir } from "./config.js";

const MAX_ENTRIES = 500;

/**
 * Defensive sanitiser for status / free-text fields written to history.json.
 *
 * Mirrors the regex set in mcp/src/store.ts so both clients redact the same
 * shapes. The MCP found multiple real bugs where an error path leaked the
 * full ZPL key into a user-visible error message; the CLI doesn't have that
 * surface today, but we wear seatbelts.
 *
 * Patterns redacted:
 *   - ZPL user keys: zpl_u_[prefix_]<20+ hex>          (any wizard variant)
 *   - ZPL service keys: zpl_s_<20+ hex>                (server-side only)
 *   - Generic Bearer tokens
 *   - Anthropic / OpenAI sk-* tokens (any length)
 *   - Groq gsk_* tokens
 */
//
// AUDIT 2026-08-02: the comment above said this mirrors the MCP's set. It did
// not, and the difference ran both ways. Both shipped sanitisers were run over
// one corpus:
//
//   short Bearer token       CLI leaked it   MCP redacted it
//   sk_live_<...>            CLI leaked it   MCP redacted it
//   sk_test_<...>            CLI leaked it   MCP redacted it
//   Bearer<TAB><token>       CLI redacted it MCP leaked it
//
// The length floor of 16 was the first: a short token is still a token. The
// Stripe shapes were simply absent here.
//
// The lists are still two copies in two packages, because these ship
// separately and neither can import the other. What keeps them together now is
// a behavioural guard in each repo running the same corpus, rather than a
// comment asserting they match.
const SECRET_PATTERNS: RegExp[] = [
  /zpl_[us]_(?:[a-z]+_)?[a-f0-9]{20,}/gi,
  // Quote excluded for the same reason the MCP excludes it: its twin runs
  // over serialised JSON, and the two sets are meant to behave alike.
  /Bearer\s+[^\s"]+/gi,
  /sk-[A-Za-z0-9_-]+/gi,
  /sk_(?:live|test)_[A-Za-z0-9_-]+/gi,
  /gsk_[A-Za-z0-9_-]+/gi,
];

export function sanitiseStatus(value: string | null | undefined): string | null {
  if (value == null) return null;
  let out = value;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

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
    // Defensive: redact any secret-shaped strings the engine might echo back.
    status: sanitiseStatus(args.status ?? null),
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
