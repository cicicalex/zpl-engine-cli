# zpl-engine-cli

Terminal CLI for the [ZPL Engine](https://zeropointlogic.io) — score AI output for sycophancy, bias, and consistency from the command line.

Sister package to [`zpl-engine-mcp`](https://www.npmjs.com/package/zpl-engine-mcp): same engine, same account, terminal-first workflow.

## Install

```bash
npm install -g zpl-engine-cli
# or
npx zpl-engine-cli login
```

Node 18+ required.

## Quickstart

```bash
# 1. Log in (opens a browser, approve the device code)
zpl login

# 2. Score a file
zpl check essay.txt

# 3. Watch the clipboard
zpl watch
```

## Commands

| Command | What it does |
|---|---|
| `zpl login` | Device flow — approve in the browser, key is stored in `~/.zpl/config.toml` |
| `zpl logout` | Remove the local config |
| `zpl whoami` | Show email + plan |
| `zpl check <file>` | Score a file for bias and neutrality |
| `zpl watch` | Poll the clipboard every 2s, score any new text |
| `zpl consistency "<question>" --n 5` | Run N passes, report variance |
| `zpl compare <a.txt> <b.txt>` | Score two files and show the delta |
| `zpl diff <before.txt> <after.txt>` | "improved / worsened / unchanged" |
| `zpl history` | Last 20 runs from the local SQLite log |

## Config

- `~/.zpl/config.toml` — API key, user email, engine URL. Mode 0600 on POSIX.
- `~/.zpl/history.db` — SQLite log of every scored run.

## Links

- Docs: https://zeropointlogic.io/cli
- Engine: https://engine.zeropointlogic.io
- MCP equivalent: https://www.npmjs.com/package/zpl-engine-mcp
- Support: contact@zeropointlogic.io

## License

MIT © Alex Cicic / Zero Point Logic
