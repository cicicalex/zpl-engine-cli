# Security policy — zpl-engine-cli

We take the security of the CLI seriously because it handles a credential
(your ZPL API key) that can be used to spend money and burn quota on your
account. This document explains how to report vulnerabilities, what's in
scope, and what defences ship by default.

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security reports.** Instead:

- **Email:** `security@zeropointlogic.io` (preferred) or
  `contact@zeropointlogic.io`.
- **Subject:** start with `[SECURITY]` so it gets triaged on the same day.
- Include: the CLI version (`zpl --version`), OS, a minimal reproducer,
  and what you believe the impact is.

We commit to:

- **Acknowledge** within 2 business days.
- **Initial assessment** within 5 business days.
- **Patch + coordinated release** within 30 days for high-severity issues
  (key exfiltration, RCE, auth bypass), 90 days for medium (DoS, secret
  leak in logs), best effort for low.
- **Credit** you in `CHANGELOG.md` and the GitHub release notes once the
  patch ships, unless you ask to remain anonymous.

If you do not receive an acknowledgement within 5 business days, please
re-send and CC `cicicalex20@gmail.com`.

## Scope

In scope:

- The published `zpl-engine-cli` npm package and its source on
  [github.com/cicicalex/zpl-engine-cli](https://github.com/cicicalex/zpl-engine-cli).
- Any CLI behaviour that handles, stores, or transmits the API key.
- Local file handling (config, history, backup) on supported platforms
  (macOS, Linux, Windows).
- Anything that could route an authenticated request to an unintended host.

Out of scope:

- Vulnerabilities in third-party dependencies — please report those
  upstream first; we'll fast-track the advisory once patched.
- The ZPL engine itself — report engine-side issues to
  `security@zeropointlogic.io` separately.
- Self-hosted or modified copies — only the npm-published binary is
  covered.
- Social-engineering attacks against ZPL employees.

## Defences shipped by default (v1.0+)

The CLI ships these protections out of the box. Most of them have unit
tests in `test/` and you can verify their behaviour from `zpl about`:

### Credentials

- **API key is never written to logs / errors.** All four secret-shape
  patterns (`zpl_u_*`, `zpl_s_*`, `Bearer …`, `sk-…`, `gsk_…`) are
  redacted in:
  - `~/.zpl/history.json` (`status` field — `db.ts` `sanitiseStatus`)
  - `dieFormatted` stderr output (`index.ts` `sanitiseErrorMessage`)
  - `zpl diagnose` API key field (always shown as
    `zpl_u_cli_***` prefix)
- **Config file mode 0600 on POSIX.** `requireConfig` warns yellow if
  it finds anything more open and prints the exact `chmod 600` fix.
- **Backup file mode 0600 on POSIX.** `zpl repair`'s pre-deletion
  backup is chmoded immediately after copy.
- **`ZPL_API_KEY` env var validated.** Format-checked with the same
  regex as `zpl login` issues; service keys (`zpl_s_*`) are rejected
  with a redirect to the dashboard.

### Network

- **Engine URL host allowlist.** `engine.base_url` from any source
  must be `https://` AND match `*.zeropointlogic.io` (or a host
  added via `ZPL_ENGINE_HOST_ALLOWLIST`). Hostile URLs are rejected
  before any Bearer-tokenised request leaves the box.
- **HTTPS only.** `http://` engine URLs are rejected — no plain-text
  Bearer tokens.
- **No userinfo in URLs.** `https://user:pass@host/...` is rejected
  (those credentials end up in proxy logs and referer headers).
- **Cloudflare HTML detection.** Any 200-or-4xx response with HTML
  body is surfaced as `ApiCloudflareError` with the cf-ray ID,
  preventing JSON-parse crashes that would expose the request.
- **Proxy support honours NO_PROXY.** Sensitive hosts can be excluded
  from a corporate TLS-inspecting proxy.

### Filesystem

- **File reads capped at 1 MB.** `zpl check` / `compare` / `diff`
  refuse to read enormous files that would OOM the process.
- **No TOCTOU race.** Single `stat`-then-`read` per file instead of
  `existsSync → readFileSync`.

### Process / runtime

- **No forced exit while fetch is in flight.** Avoids the libuv
  assertion on Windows that pre-v1.0 could leak partial output.
- **Recursive exit-code enforcement.** Unknown command / option exits
  1 instead of 0 (POSIX-compliant for `set -e` scripts).

## Telemetry

The CLI sends **one** outbound request to npm's registry on startup,
solely to detect new versions. No telemetry, no usage analytics, no
phone-home. Disable with `ZPL_SKIP_UPDATE_CHECK=1`.

The engine logs requests for billing purposes only. Logs never feed
training data.

## Hash-of-the-binary verification

If you want to verify the npm tarball hasn't been tampered with:

```bash
npm view zpl-engine-cli@latest dist.shasum
```

Compare with the SHA-1 you compute locally:

```bash
shasum -a 1 $(npm pack zpl-engine-cli@latest --dry-run --json | jq -r '.[0].filename')
```

(Future improvements: package signing via `npm provenance` once we wire
SLSA into the CI release flow. Tracked in CHANGELOG.)

## Encryption / TLS

The CLI relies on Node 18+'s native fetch / undici stack for TLS. CA
certificates come from the system trust store (override with
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem` for corporate MITM proxies).
Minimum TLS 1.2 enforced by Node defaults; we do not ship a
`NODE_TLS_REJECT_UNAUTHORIZED=0` escape hatch.

## Acknowledgements

Thank you to the security researchers who have responsibly disclosed
issues. Credits land here as patches ship.
