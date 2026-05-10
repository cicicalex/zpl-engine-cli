/**
 * Shared file-reading helpers with consistent error handling and a hard size
 * cap so a `zpl check 5GB-log.txt` doesn't OOM the Node process.
 *
 * Pre-v1.0.0 each command did its own `existsSync(path) + readFileSync(path)`
 * dance, which (a) had a TOCTOU race window between the two syscalls, and
 * (b) had no upper bound on file size. v1.0.0 consolidates both into one
 * stat-then-read with explicit limits.
 */
import { readFileSync, statSync } from "node:fs";
import chalk from "chalk";

/** Anything bigger than this we refuse — protects the engine free tier too,
 *  since a 10 MB text would burn through quota in a single `check`. */
export const MAX_FILE_BYTES = 1_000_000;
export const MIN_TEXT_CHARS = 10;

export interface ReadFileOpts {
  /** Min chars of trimmed text required. Falls back to MIN_TEXT_CHARS. */
  minChars?: number;
  /** Max bytes accepted. Falls back to MAX_FILE_BYTES. */
  maxBytes?: number;
}

/**
 * Read a UTF-8 text file with size + length validation.
 *
 * On any failure (not found, too big, too short, perm denied, ENOTDIR, etc.)
 * writes a red error to stderr and calls `process.exit(1)`. Callers don't need
 * to wrap in try/catch — that's intentional: the CLI's `dieFormatted` doesn't
 * have enough context to write a per-file error message, so we do it here.
 *
 * @param filePath path passed by user on the command line
 * @returns the file contents as a string
 */
export function readTextFileOrDie(filePath: string, opts: ReadFileOpts = {}): string {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const minChars = opts.minChars ?? MIN_TEXT_CHARS;

  // Single stat-then-read avoids the existsSync→readFileSync TOCTOU race
  // and lets us reject huge files BEFORE allocating a 5 GB buffer.
  let size: number;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      process.stderr.write(chalk.red(`Not a regular file: ${filePath}\n`));
      process.exit(1);
    }
    size = st.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      process.stderr.write(chalk.red(`File not found: ${filePath}\n`));
    } else if (code === "EACCES" || code === "EPERM") {
      process.stderr.write(chalk.red(`Permission denied: ${filePath}\n`));
    } else {
      process.stderr.write(chalk.red(`Cannot stat ${filePath}: ${(err as Error).message}\n`));
    }
    process.exit(1);
  }

  if (size > maxBytes) {
    const mb = (size / 1_000_000).toFixed(1);
    const capMb = (maxBytes / 1_000_000).toFixed(1);
    process.stderr.write(
      chalk.red(`File too large: ${filePath} is ${mb} MB (limit ${capMb} MB).\n`) +
        chalk.gray(`Slice it: \`head -c ${maxBytes} ${filePath} > sample.txt && zpl check sample.txt\`\n`),
    );
    process.exit(1);
  }

  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (err) {
    process.stderr.write(chalk.red(`Cannot read ${filePath}: ${(err as Error).message}\n`));
    process.exit(1);
  }

  if (text.trim().length < minChars) {
    process.stderr.write(
      chalk.red(`File too short to analyze: ${filePath} (minimum ${minChars} non-whitespace characters).\n`),
    );
    process.exit(1);
  }

  return text;
}
