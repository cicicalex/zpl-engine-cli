/**
 * TOML round-trip tests for the hand-rolled config reader/writer.
 *
 * The config parser is deliberately tiny (no @iarna/toml dep) so it has to
 * be tested rigorously. These tests lock in the exact subset of TOML it
 * accepts, plus the security-critical 0o600 file mode on POSIX.
 *
 * Run after `npm run build`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use HOME env override so writeConfig writes into our tempdir instead of
// blasting the real ~/.zpl on the dev's machine.
async function withTempHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), "zpl-cli-test-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    // Re-import each call so node:os.homedir() picks up the new env.
    const { writeConfig, readConfig, getConfigPath, deleteConfig } = await import(
      `../dist/config.js?cachebust=${Date.now()}`
    );
    await fn({ writeConfig, readConfig, getConfigPath, deleteConfig, dir });
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    await rm(dir, { recursive: true, force: true });
  }
}

const SAMPLE = {
  auth: {
    api_key: "zpl_u_cli_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    user_email: "alex@example.com",
    created_at: "2026-05-10T15:00:00.000Z",
  },
  engine: { base_url: "https://engine.zeropointlogic.io" },
  defaults: { model: "claude-haiku-4-5" },
};

test("writeConfig + readConfig round-trips cleanly", async () => {
  await withTempHome(async ({ writeConfig, readConfig }) => {
    writeConfig(SAMPLE);
    const got = readConfig();
    assert.deepEqual(got, SAMPLE);
  });
});

test("readConfig returns null when file does not exist", async () => {
  await withTempHome(async ({ readConfig }) => {
    assert.equal(readConfig(), null);
  });
});

test("readConfig returns null on corrupted file (defensive parse)", async () => {
  await withTempHome(async ({ readConfig, getConfigPath, writeConfig }) => {
    writeConfig(SAMPLE);
    // Corrupt the file with garbage that doesn't match any TOML pattern.
    await writeFile(getConfigPath(), "this is not toml\nnot at all\n");
    assert.equal(readConfig(), null);
  });
});

test("readConfig returns null when [auth] block is missing required fields", async () => {
  await withTempHome(async ({ readConfig, getConfigPath }) => {
    // Hand-write a TOML that has the section but no api_key.
    const path = getConfigPath();
    const fs = await import("node:fs");
    fs.mkdirSync(path.replace(/[\/\\][^\/\\]+$/, ""), { recursive: true });
    await writeFile(path, `[auth]\nuser_email = "alex@example.com"\n`);
    assert.equal(readConfig(), null);
  });
});

test("writeConfig escapes special characters in strings", async () => {
  await withTempHome(async ({ writeConfig, readConfig }) => {
    const tricky = {
      ...SAMPLE,
      auth: {
        ...SAMPLE.auth,
        // Email with quotes + backslash + newline + double-quote — all need escaping.
        user_email: 'weird"value\\with\nnewline',
      },
    };
    writeConfig(tricky);
    const got = readConfig();
    assert.equal(got.auth.user_email, 'weird"value\\with\nnewline');
  });
});

test("deleteConfig removes the file and returns true", async () => {
  await withTempHome(async ({ writeConfig, deleteConfig, getConfigPath, readConfig }) => {
    writeConfig(SAMPLE);
    assert.notEqual(readConfig(), null);
    assert.equal(deleteConfig(), true);
    assert.equal(readConfig(), null);
    // Second delete should report "nothing to do".
    assert.equal(deleteConfig(), false);
  });
});

test("deleteConfig returns false when no file exists (idempotent)", async () => {
  await withTempHome(async ({ deleteConfig }) => {
    assert.equal(deleteConfig(), false);
  });
});

test("config file is mode 0o600 on POSIX (skipped on Windows NTFS)", async () => {
  if (process.platform === "win32") {
    return; // NTFS doesn't have POSIX bits; the chmod is best-effort.
  }
  await withTempHome(async ({ writeConfig, getConfigPath }) => {
    writeConfig(SAMPLE);
    const s = await stat(getConfigPath());
    // Mask off file-type bits, compare permission bits only.
    assert.equal(s.mode & 0o777, 0o600);
  });
});

test("readConfig falls back to default base_url + model when sections missing", async () => {
  await withTempHome(async ({ readConfig, getConfigPath }) => {
    // Write only [auth] — no [engine] or [defaults].
    const path = getConfigPath();
    const fs = await import("node:fs");
    fs.mkdirSync(path.replace(/[\/\\][^\/\\]+$/, ""), { recursive: true });
    await writeFile(
      path,
      `[auth]\napi_key = "zpl_u_${"a".repeat(48)}"\nuser_email = "a@b.com"\n`,
    );
    const got = readConfig();
    assert.equal(got.engine.base_url, "https://engine.zeropointlogic.io");
    assert.equal(got.defaults.model, "claude-haiku-4-5");
  });
});

test("readConfig ignores blank lines and comments", async () => {
  await withTempHome(async ({ readConfig, getConfigPath }) => {
    const path = getConfigPath();
    const fs = await import("node:fs");
    fs.mkdirSync(path.replace(/[\/\\][^\/\\]+$/, ""), { recursive: true });
    await writeFile(
      path,
      `# top comment\n\n[auth]\n# inline comment\napi_key = "zpl_u_${"a".repeat(48)}"\n\nuser_email = "a@b.com"\n`,
    );
    const got = readConfig();
    assert.equal(got.auth.user_email, "a@b.com");
  });
});
