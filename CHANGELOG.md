# Changelog

All notable changes to **zpl-engine-cli** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] — 2026-05-10

### Added

- **`zpl completion <shell>`** — emit a tab-completion script for
  `bash` / `zsh` / `fish` / `powershell`. Pipe into the appropriate
  shell init file:
  ```bash
  zpl completion bash       >> ~/.bashrc
  zpl completion zsh        >> ~/.zshrc
  zpl completion fish       > ~/.config/fish/completions/zpl.fish
  zpl completion powershell >> $PROFILE
  ```
- **`zpl config get|set|list|unset|edit`** — read / write
  `~/.zpl/config.toml` without manual TOML editing. Settable keys:
  `auth.user_email`, `engine.base_url`, `defaults.model`. The
  `engine.base_url` setter runs the host-allowlist validator before
  writing, so a typo can't expose your key.
- **`zpl logs`** — show recent CLI activity from the local history log.
  Filter with `--type all | auth | scoring`, limit with `--limit N`,
  output with `--output text | json`.
- **HTTP_PROXY / HTTPS_PROXY / NO_PROXY support** — automatic. The CLI
  now routes every outbound request through `EnvHttpProxyAgent` if the
  standard proxy env vars are set. Disable explicitly with
  `ZPL_NO_PROXY=1`. **Enterprise users behind a TLS-inspecting proxy
  can now use the CLI without modification.**
- **CHANGELOG.md** (this file) — every release documented going forward.
- **SECURITY.md** — vulnerability disclosure policy at the repo root.

### Changed

- `zpl about` — when `ZPL_NO_PROXY=1` is honoured (or HTTP_PROXY /
  HTTPS_PROXY are detected), the active proxy is shown in the Privacy
  section.

### Why a minor bump (1.0 → 1.1) and not a patch

All the additions above are backwards-compatible (new commands, new
optional env vars). No breaking changes to existing command shapes,
exit codes, or output schemas. Per semver, that's MINOR.

---

## [1.0.0] — 2026-05-10

The first production-ready release. Audit-driven: every line of the
v0.1.x codebase was reviewed against POSIX/CLI conventions, security
best practice, and the parallel MCP package's hardening checklist.
Twenty bugs and security gaps were closed and twelve new commands
landed before the version-1 banner went up.

### Added

#### New commands (12)

- **`zpl pipe [--threshold N] [--output text|json]`** — Unix-style:
  read text from stdin, score it, emit single-line text or JSON to
  stdout. With `--threshold N` exits 1 when AIN < N (CI gate). The
  CLI's flagship command and the differentiator from the MCP — the AI
  never sees the score.
- **`zpl about [--output text|json]`** — self-describing manifest.
  Text mode for humans, JSON mode for AI agents. Includes Privacy
  and Security sections so customers don't have to read the source.
- **`zpl quota [--output text|json]`** — tokens used + remaining for
  the current billing period, color-coded green/yellow/red at the
  70% / 90% thresholds.
- **`zpl plans [--output text|json]`** — the catalogue of all eight
  tiers (Free / Basic / Pro / GamePro / Studio / Agent / Enterprise /
  XL) with monthly token quota and EUR price.
- **`zpl export <format> [--limit N]`** — export local history to
  stdout in `json | csv | markdown` (md alias). RFC-4180 CSV escaping;
  pipe to file with `> history.csv`.
- **`zpl update [--apply]`** — self-service upgrade. Detects install
  kind (global-npm / npx / unknown) and prints the correct upgrade
  command for THAT path. With `--apply`, spawns `npm install -g`.
- **`zpl diagnose`** — health report (config + key format + engine
  reachability + auth) with actionable hints per FAIL.
- **`zpl repair [--yes]`** — wipe config + auto-relogin, with
  automatic backup to `~/.zpl/config.toml.bak` (mode 0600) before
  delete and clear restore instructions on login failure.
- **`zpl whoami [--output text|json]`** — same as before, plus a
  machine-readable JSON mode and a `source` field telling agents
  whether credentials came from `~/.zpl/config.toml` or
  `ZPL_API_KEY` env.
- Supporting: **memory-aware login** (`zpl login` now skips the
  device flow if you're already authenticated, with `--force` to
  override) and **smoke test post-login** (verifies the new key
  against `/api/user/me` to catch replication lag).

#### New environment variables

- **`ZPL_API_KEY`** — non-interactive auth for CI / Docker. Validated
  with the same regex `zpl login` issues. Service keys (`zpl_s_*`)
  are rejected here with a redirect to the dashboard.
- **`ZPL_USER_EMAIL`** / **`ZPL_ENGINE_URL`** / **`ZPL_DEFAULT_MODEL`** —
  override individual config values when running with `ZPL_API_KEY`.
- **`ZPL_ENGINE_HOST_ALLOWLIST`** — comma-separated list of hosts to
  add to the engine URL allowlist (for self-hosters).
- **`ZPL_ALLOW_LOCALHOST`** — `=1` lets `localhost` / `127.0.0.1` /
  `[::1]` through the engine URL allowlist (engine devs only).
- **`ZPL_SKIP_UPDATE_CHECK`** — `=1` disables the once-per-startup
  npm registry check.

#### Security hardening (six gaps closed)

- **Engine URL host allowlist** — `engine.base_url` from any source
  (env, config file) must be `https://` AND match
  `*.zeropointlogic.io`. A hijacked config or hostile env var pointing
  to `attacker.com` is REJECTED before any Bearer-tokenised request.
- **Backup file 0o600** — `zpl repair`'s pre-deletion backup is
  chmod-ed to owner-read-only on POSIX. Pre-v1.0 it inherited the
  default mode and could leak the key on shared boxes.
- **`ZPL_API_KEY` env var validation** — trim + format validation +
  service-key reject UPFRONT. Bad env keys fail loud at command
  start instead of producing a confusing 401 from the engine 30s
  later.
- **Error message redaction** — `dieFormatted` runs every error
  message through a regex set (zpl_u_*, zpl_s_*, Bearer, sk-ant-*,
  sk-*, gsk_*) before printing to stderr. Defence in depth so a
  leak in the engine doesn't propagate to terminal scrollback /
  CI logs.
- **Config file mode warning** — `requireConfig` on POSIX warns
  yellow if `~/.zpl/config.toml` is anything beyond mode 0600,
  with the exact `chmod 600` command to fix.
- **History sanitiser** — `appendHistory`'s `status` field is
  scrubbed for secret-shaped strings before persisting to
  `~/.zpl/history.json`. Inputs were already SHA-256 hashed; status
  is now belt + braces.

### Fixed

#### Audit-discovered bugs (10)

- **Bug #1: `zpl consistency` was lying.** Pre-v1 it called the
  engine N times with the same (d, bias, samples) — a deterministic
  function — and reported stdDev = 0 for everything, labelling all
  inputs CONSISTENT. Now honestly reports engine determinism (and
  flags drift if a load balancer routes between versions).
- **Bug #2: `zpl watch` swallowed terminal errors.** Auth and
  Cloudflare failures kept polling forever, so a watch session that
  broke at minute 1 looked alive at minute 60. Now both are terminal
  and the user gets actionable instructions.
- **Bug #3: `readFileSync` had no size cap.** A 5 GB file could OOM
  the process. Capped at 1 MB with helpful slice hint.
- **Bug #4: TOCTOU race.** `existsSync(path) → readFileSync(path)`
  had a window where the file could be deleted in between. Single
  stat-then-read closes it.
- **Bug #5: `zpl diagnose` used a different User-Agent than the
  api-client.** Cloudflare could allow one and block the other,
  meaning diagnose reported "Engine reachable: ✓" while real
  requests 403'd. UA centralised in `src/user-agent.ts`.
- **Bug #6: device-flow polling could go to 1 s.** RFC 8628 §3.5
  says 5 s minimum. Floored at 3 s as a reasonable compromise.
- **Bug #7: `zpl repair` lost data on login failure.** Pre-v1
  deleted config first, so a failed device flow left the user
  with NO config — strictly worse than the broken state. Now
  backs up first, restores instructions printed on failure.
- **Bug #8: `parseInt(--n)` returned NaN silently.** `Math.max`
  coerced NaN to the floor (2), hiding user typos. Now explicit
  validation, exit 2 (EX_USAGE).
- **Bug #9: `maxRetries` not clamped.** A `maxRetries: 99999` typo
  would loop 99999 times on a transient 500. Clamped to [0, 5].
- **Bug #10: Cloudflare HTML interstitials crashed.** A 200 + HTML
  response (Cloudflare challenge passing through) crashed
  `res.json()` with a useless `Unexpected token <` error. Now
  detected via Content-Type + body sniff, surfaces typed
  `ApiCloudflareError` with the cf-ray ID.

#### POSIX / CLI standards conformance (four violations)

- **NO_COLOR / pipe-friendliness on table borders.** cli-table3
  uses an internal `colors` package (NOT chalk) for its border
  characters, which doesn't respect `NO_COLOR` or TTY detection.
  All Table instances now use `TABLE_STYLE` from `src/table-style.ts`
  (head: [], border: []) so output is plain whenever colors are off.
- **Unknown command / option exits 0.** `zpl nonexistent` and
  `zpl plans --bogus` both exited 0 — broke `set -e` in CI scripts.
  Commander's `exitOverride()` is now applied recursively to every
  subcommand. Unknown command / option → exit 1.
- **`zpl diagnose` failure summary on stdout.** Hints went to stdout
  with the table, so `zpl diagnose > diag.txt` lost the actionable
  advice. Hints moved to stderr; table stays on stdout.
- **`process.exit()` while AbortSignal.timeout is in flight.** On
  Windows, `process.exit()` mid-fetch tripped a libuv assertion in
  `src/win/async.c`. Switched to `process.exitCode = N; return;` so
  the event loop drains naturally before exit.

### Tests

- **82/82 PASS**, ~3 s. Suites:
  - `test/api-key-format.test.mjs` (18 tests)
  - `test/cloudflare-error.test.mjs` (12 tests)
  - `test/config-toml.test.mjs` (9 tests)
  - `test/sanitiser.test.mjs` (10 tests)
  - `test/file-utils.test.mjs` (8 tests, 4 via subprocess for exit-1 paths)
  - `test/export.test.mjs` (6 tests)
  - `test/plans.test.mjs` (3 tests)
  - `test/engine-url-validate.test.mjs` (18 tests)

---

## [0.1.3] — 2026-04-22

Last pre-1.0 release on npm. Forced-upgrade check + stricter startup
policy. See git history for details.

[1.1.0]: https://github.com/cicicalex/zpl-engine-cli/releases/tag/v1.1.0
[1.0.0]: https://github.com/cicicalex/zpl-engine-cli/releases/tag/v1.0.0
[0.1.3]: https://github.com/cicicalex/zpl-engine-cli/releases/tag/v0.1.3
