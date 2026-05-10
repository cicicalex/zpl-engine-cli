# zpl-engine-cli

[![npm](https://img.shields.io/npm/v/zpl-engine-cli.svg)](https://www.npmjs.com/package/zpl-engine-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/zpl-engine-cli.svg)](https://nodejs.org)

Terminal CLI for the [ZPL Engine](https://zeropointlogic.io) — the
**independent verification layer** for AI output. Score files, clipboard
pastes, or piped stdin for bias / sycophancy / consistency.

> **CLI vs MCP:** The [MCP package](https://www.npmjs.com/package/zpl-engine-mcp)
> exposes scores TO the AI, which can modify its output to look better
> (observer effect). The CLI runs as a separate process AFTER the AI has
> produced its output — the AI never sees the score, so the result is
> independent verification rather than self-report.

## Install

```bash
npm install -g zpl-engine-cli
# or run a single command without installing
npx zpl-engine-cli login
```

Node 18+ required. Verified on macOS, Linux (incl. Alpine/musl), Windows.

## Quickstart

```bash
# 1. Log in — opens a browser, approve the device code
zpl login

# 2. Score a file
zpl check essay.txt

# 3. Use as a CI gate — exit 1 if AI output is too biased
claude "summarise the report" | zpl pipe --threshold 70

# 4. Tab-completion in your shell
zpl completion bash >> ~/.bashrc   # then: source ~/.bashrc
```

## Commands (17 total)

### Authentication & maintenance

| Command | What it does |
|---|---|
| `zpl login [--force]` | Memory-aware device flow. Skips if you're already logged in (`--force` to override). |
| `zpl logout` | Remove the local credentials. |
| `zpl whoami [--output text\|json]` | Show email + plan + quota + source (config-file vs env var). |
| `zpl diagnose` | Health check: config / key format / engine reachable / engine auth. Exit 1 if any FAIL. |
| `zpl repair [--yes]` | Wipe config + auto-relogin, with **automatic backup** to `~/.zpl/config.toml.bak` (mode 0600) and restore instructions if the relogin fails. |

### Scoring

| Command | What it does |
|---|---|
| `zpl check <file>` | Score a single file for bias / neutrality. |
| `zpl pipe [--threshold N] [--output text\|json]` | **Unix-style:** read stdin, score, emit text or JSON. With `--threshold N` exits 1 when AIN < N. The CLI's flagship CI-gate command. |
| `zpl watch` | Poll the clipboard every 2 s and score every new paste. |
| `zpl consistency "<q>" [--n 5]` | Probe engine determinism over N identical calls. Reports drift if a load balancer routes between versions. |
| `zpl compare <a> <b>` | Score two files head-to-head with a delta. |
| `zpl diff <before> <after>` | Semantic delta: improved / worsened / unchanged. |

### Data & exports

| Command | What it does |
|---|---|
| `zpl history` | Last 20 scored runs (input is SHA-256 hashed for privacy). |
| `zpl logs [--type all\|auth\|scoring] [--limit N] [--output text\|json]` | Recent CLI activity. Filter by event type. |
| `zpl export <json\|csv\|markdown> [--limit N]` | Export history to stdout. CSV is RFC-4180 compliant. |

### Account info

| Command | What it does |
|---|---|
| `zpl quota [--output text\|json]` | Tokens used + remaining this month. Color-coded green/yellow/red at 70% / 90%. |
| `zpl plans [--output text\|json]` | Catalogue of all 8 tiers (Free → XL) with prices. |

### Self-service

| Command | What it does |
|---|---|
| `zpl update [--apply]` | Detect newer npm version + print the upgrade command for your install path. `--apply` runs `npm install -g`. |
| `zpl about [--output text\|json]` | Self-describing manifest. **JSON mode for AI agents** — list of commands, scoring bands, privacy & security policies. |
| `zpl completion <bash\|zsh\|fish\|powershell>` | Emit a tab-completion script. Pipe into your shell's init file. |
| `zpl config <get\|set\|list\|unset\|edit>` | Manage `~/.zpl/config.toml` without manual TOML editing. The `engine.base_url` setter validates against the host allowlist before writing. |

### Help

| Command | What it does |
|---|---|
| `zpl --help`, `zpl <command> --help` | Per-command help via commander. |
| `zpl --version` | Print version and exit. |

## Environment variables

| Variable | Purpose |
|---|---|
| `ZPL_API_KEY` | Use this instead of `~/.zpl/config.toml` for non-interactive auth (CI / Docker). Validated with the same regex `zpl login` issues. |
| `ZPL_USER_EMAIL`, `ZPL_ENGINE_URL`, `ZPL_DEFAULT_MODEL` | Override individual config values when running with `ZPL_API_KEY`. |
| `ZPL_ENGINE_HOST_ALLOWLIST` | Comma-separated extra hosts for `engine.base_url` (self-hosters). |
| `ZPL_ALLOW_LOCALHOST=1` | Allow `localhost` / `127.0.0.1` / `[::1]` in `engine.base_url` (engine devs). |
| `ZPL_SKIP_UPDATE_CHECK=1` | Disable the once-per-startup npm version check. |
| `ZPL_NO_PROXY=1` | Bypass HTTP_PROXY / HTTPS_PROXY env vars. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Standard proxy env vars — honoured automatically (enterprise users behind TLS-inspecting proxies). |
| `EDITOR` / `VISUAL` | Used by `zpl config edit`. |
| `NO_COLOR=1` | Disable ANSI colors (we honour the [no-color.org](https://no-color.org) standard, including for table borders). |

## Files written

| Path | Mode | Purpose |
|---|---|---|
| `~/.zpl/config.toml` | 0600 (POSIX) | API key + email + engine URL. The CLI warns if mode is more open. |
| `~/.zpl/history.json` | 0600 (POSIX) | One row per scored run. **Input is SHA-256 hashed before write** — raw text is never stored. Capped at 500 entries. |
| `~/.zpl/config.toml.bak` | 0600 (POSIX) | Created by `zpl repair` before deletion; contains the same key as the original. |

## Privacy & Security

The CLI ships defence-in-depth against credential leaks. Run
`zpl about --output json` to see the full machine-readable manifest. Highlights:

- API key is **redacted** in error messages, history log, and diagnose output.
- Engine URL is **host-allowlist** validated — a hijacked config or hostile env var pointing to `attacker.com` is rejected before any Bearer token is sent.
- HTTPS only (no plain-text Bearer tokens), no userinfo in URLs.
- Config + backup files are **mode 0600** on POSIX; warning if perms drift.
- File reads capped at 1 MB to defend against OOM.
- Cloudflare HTML interstitials are detected and surfaced as typed errors with the cf-ray ID.
- **No telemetry** — the only outbound non-engine call is the once-per-startup npm version check, disable with `ZPL_SKIP_UPDATE_CHECK=1`.

Vulnerability disclosure policy: see [SECURITY.md](SECURITY.md).

## Sister package

Use the [MCP package](https://www.npmjs.com/package/zpl-engine-mcp) for in-conversation
scoring inside Claude Desktop / Cursor / Windsurf — same engine, same account.

## Links

- npm: https://www.npmjs.com/package/zpl-engine-cli
- Source: https://github.com/cicicalex/zpl-engine-cli
- Engine status: https://engine.zeropointlogic.io/health
- Pricing: https://zeropointlogic.io/pricing
- Support: contact@zeropointlogic.io
- Security: security@zeropointlogic.io
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

MIT © Alex Cicic / Zero Point Logic
