# Changelog

All notable changes to **zpl-engine-cli** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-07-31

Includes the alignment pass against the numeric contract that was previously
filed below as *Unreleased*. It was never released separately: `src/ain-scale.ts`
does not exist at tag `v1.2.1`, so every item here ships for the first time in
1.3.0. **`zpl pipe`'s text output changes in this release** — see *Changed*.

### Fixed
- `zpl plans` had never once fetched live data. The request carried no
  Authorization header and the engine's `/plans` requires one, so every call
  fell back to the built-in list while the note underneath blamed an
  unreachable engine. The engine was fine.
- The built-in fallback list had drifted: Agent showed 15 API keys against 50
  on the website. Now pinned to the website's plan table by test.
- `zpl plans` honours `ZPL_ENGINE_URL` and the configured engine URL, which it
  previously ignored — anyone pointed at a staging engine silently received
  production's plan list. The URL passes the same validator the rest of the CLI
  uses, since this request now carries the API key.
- `zpl diff --lines` printed "Mean delta: +0.00 AIN (unchanged)" on stdout when
  nothing could be scored. The exit code and stderr were already correct, but
  stdout is what a script reads. A mean over zero samples is now reported as
  absent.
- **Three kinds of secret were printed to the terminal in full.** The redaction
  that runs over error text before it is shown claimed in its own comment to
  cover the same shapes as the MCP's. Running both shipped redactions over one
  corpus showed the claim was false in both directions; the three that leaked
  here were a short bearer token — a length floor treated it as not a token,
  and a short token is still a token — and both Stripe key shapes, which were
  simply absent from the list. The two lists remain separate copies, because
  the packages ship independently and neither can import the other; what holds
  them together now is a test that runs both over the same corpus and fails on
  any shape one catches and the other does not.

### Changed
- Verdict wording follows the engine's bands. `zpl check` prints the engine's
  status and its own verdict on consecutive lines, and across 60–79 they
  disagreed — the engine said MODERATE_BIAS while the line below said
  "moderately balanced".
- `zpl about` publishes the engine's bands and no longer describes any reading
  as "trustworthy", a claim the engine makes about nothing it returns.

### Changed — numeric contract alignment

No behaviour change to auth, config, networking, or exit codes.

- **AIN precision is no longer thrown away.** Every command scored with
  `Math.round(ain * 100)`, collapsing the engine's 0.0–1.0 value to a whole
  number. Scores are now presented as a percentage with two decimals
  (`93.24`, not `93`) via the new `src/ain-scale.ts`. This matters most for
  `zpl consistency`, whose entire job is detecting drift — integer rounding
  made any drift under one point invisible, so the command reported
  `✓ DETERMINISTIC` for runs it had not actually verified. Affects `check`,
  `pipe`, `compare`, `diff`, `watch`, `consistency`, and the `score` column
  in `~/.zpl/history.json`.
- **`zpl pipe` text output** now labels the engine field as
  `ain_status=` instead of `status=`. Scripts grepping for `status=` need
  updating; JSON output keeps `status` as an alias (see below).
- **`zpl about`** describes the scale honestly: `range` was
  `"0-100, integer"`, which no longer matched what is returned. The manifest
  now states the 0.00–100.00 percentage form, notes that the engine's own
  scale is 0.0–1.0, and marks the four bands as the *CLI's* verdict bands
  rather than the engine's `ain_status` enum.
- **`zpl about` command list** was 12 entries out of 20 registered commands.
  It now lists all 20 and exposes `command_count`, derived from the same
  list so the number cannot drift from the list.
- **README** said "Commands (17 total)" while listing 20. Corrected to 20,
  with a note that `zpl config`'s five subcommands are not counted
  separately.

### Fixed

- **`zpl about` privacy claim was wrong in the alarming direction.** It said
  "Your raw text is sent in the request body for scoring." It is not: the
  sentiment pass runs locally and the request body contains only
  `{d, bias, samples}` (verified against a local stub engine — the body on
  the wire is `{"d":5,"bias":0.5,"samples":1000}`). Corrected to say the raw
  text never leaves the machine.

### Added

- `ain_status` key in the JSON output of `check` and `pipe`, carrying the
  engine's balance-quality enum. The existing `status` key is kept as a
  backwards-compatible alias with the same value; new scripts should read
  `ain_status`. The engine's separate stability-regime field is still not
  surfaced by the CLI.
- README section "Reading the score" — the 0.0–1.0 vs percentage
  distinction, and the difference between `ain_status` and the CLI's own
  `verdict`.

---

## [1.1.4] — 2026-05-12

Funnel finding from the 12.05 audit. Pre-fix: when the engine returned
HTTP 403 with body "Token limit exceeded: X/Y used this month" (monthly
free-tier exhaustion), `api-client.ts` fell through to
`throw new ApiAuthError()` whose message reads
`"API key invalid. Run zpl logout then zpl login."`

An engaged user who burned 5,000 free-tier tokens was therefore told
their key was invalid and to log out and back in. Pure user hostility
— they had no way to know they needed to upgrade. Most users in that
state silently churned.

### Added

- `ApiQuotaExhaustedError` — distinct from `ApiAuthError` and
  `ApiQuotaError` (per-minute rate). Multi-line message with plan
  ladder (Basic $10 → Pro $29 → GamePro $69 → Studio $149), direct
  `/pricing` link, one-off token pack fallback, and a monthly reset
  note. Exposes parsed `tokensUsed` / `tokensLimit` for callers.

### Fixed

- `api-client.ts` 403 handler now sniffs the response body for
  `/token limit exceeded/i` **before** falling through to
  `ApiAuthError`. Parses the `X/Y` numbers out of the engine response.
- `index.ts` top-level `dieFormatted()` prints the new error in yellow
  (not red) — the user's setup is fine, this is a billing prompt.

Cascade complete: MCP v4.1.4, SDK v2.0 (TS + Python), CLI v1.1.4 all
now surface the same upgrade nudge at the same moment in the user
journey. Free-tier exhaustion = upgrade prompt at every entry point.

---

## [1.1.3] — 2026-05-11

Implements ADR 0002 (`zpl-engine-sdk/docs/adr/0002-x-zpl-client-headers.md`)
in the CLI. Sister release to `zpl-engine-mcp@4.1.2` — both MCP and CLI
now identify themselves to the engine with structured headers
independent of User-Agent.

### Added

- **`X-ZPL-Client: cli`** header on every engine request.
- **`X-ZPL-Client-Version: <package version>`** header on every engine
  request, sourced from a new exported `readPkgVersion()` in
  `src/user-agent.ts`. Single source of truth: same function feeds both
  the User-Agent product token and the X-ZPL-Client-Version header so
  they cannot drift.

Headers added to `api-client.ts` `headers()` alongside `Authorization`
/ `Content-Type` / `User-Agent`.

### Compatibility

- Backwards compatible: engine ignores unknown headers today; once
  engine-side telemetry persistence ships, these headers populate the
  dashboard automatically with no CLI redeploy needed.
- SDK TypeScript + Python ship the same convention from
  `zpl-engine-sdk` commit `d05dfd9`.
- MCP (`zpl-engine-mcp@4.1.2`) ships matching headers in the same wave.

[1.1.3]: https://github.com/cicicalex/zpl-engine-cli/releases/tag/v1.1.3

## [1.1.2] — 2026-05-10

Patch release surfacing two real bugs found during the joint MCP+CLI
test pass (5 test categories × 2 packages). Both bugs were silent —
they did not crash, they just produced wrong / unfriendly behaviour
that turned a working install into "doesn't work" silently.

### Fixed

- **CLI `parseToml` parser required `[auth]` section header — but
  zpl-engine-mcp@4.x writes a FLAT TOML.** Both packages share the
  credentials store at `~/.zpl/config.toml`. MCP's `setup` writes
  `api_key = "…"` at top level (no `[auth]`); pre-1.1.2 CLI parser
  ignored everything outside a section, so `readConfig()` returned
  null and CLI said "Not logged in" — even though the file existed
  with valid credentials a user JUST wrote via `npx zpl-engine-mcp
  setup`. End result: every cross-package user (most of them) had
  a broken CLI on first run.

  Fix: keys before any section header now land in a synthetic `auth`
  section. Sectioned configs (CLI's own writeConfig output) keep
  working unchanged. Verified compatible with both formats.

- **`zpl pipe --threshold N` crashed on Windows when AIN < N.** Same
  libuv `src/win/async.c` assertion we fixed in `update-check.ts` and
  `diagnose.ts` — `process.exit(1)` while a fetch's
  `AbortSignal.timeout` is still in flight. Replaced with the
  standard `process.exitCode = 1` pattern so the event loop drains
  before exit. CI scripts on Windows that gate on `zpl pipe`
  threshold no longer see "exit 127" + libuv assertion noise; they
  see clean `exit 1`.

[1.1.2]: https://github.com/cicicalex/zpl-engine-cli/releases/tag/v1.1.2

## [1.1.1] — 2026-05-10

Tiny patch to keep CLI + MCP env vars in lockstep. After shipping
`zpl-engine-mcp@4.1.0`, an audit confirmed both packages now ship the
same defences — but the env-var name for the "allow localhost as engine
host" escape-hatch was different (`ZPL_ALLOW_LOCALHOST` in CLI vs
`ZPL_ENGINE_ALLOW_INSECURE_LOCAL` in MCP). Confusing for self-hosters.

### Changed

- **`ZPL_ENGINE_ALLOW_INSECURE_LOCAL=1` is now the canonical name** for
  the "treat localhost / 127.0.0.1 / [::1] as a valid engine host"
  override. The old name (`ZPL_ALLOW_LOCALHOST`) is still honoured for
  backwards compatibility with anyone who set it during the v1.0/v1.1.0
  window — both names work, the new one is preferred and documented.

### Why a patch bump (1.1.0 → 1.1.1) and not a minor

Pure rename with backwards-compatible fallback — no new behaviour, no
new commands, no new env vars in net (one new name, one preserved old).
Per semver, that's PATCH.

[1.1.1]: https://github.com/cicicalex/zpl-engine-cli/releases/tag/v1.1.1

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
