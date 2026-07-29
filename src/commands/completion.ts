/**
 * `zpl completion <shell>` — emit a shell-completion script for the requested
 * shell to stdout. The user pipes it into the appropriate location:
 *
 *   bash:        zpl completion bash       >> ~/.bashrc
 *   zsh:         zpl completion zsh        >> ~/.zshrc
 *                  (or > ~/.zsh/completions/_zpl with fpath wired)
 *   fish:        zpl completion fish       > ~/.config/fish/completions/zpl.fish
 *   PowerShell:  zpl completion powershell >> $PROFILE
 *
 * We hand-roll the scripts (rather than rely on commander.js's nascent
 * completion support) so we can ship one stable contract — the same set of
 * subcommands and flags appears in every shell, generated from the COMMANDS
 * table below. (An earlier comment pointed at `src/commands-meta.ts`, which
 * does not exist — the table has always lived in this file.)
 *
 * Each shell's script:
 *   - Lists subcommands as the first-position completions
 *   - Lists short + long flags per subcommand for second-position
 *   - Falls back to file completion for arguments like <file>, <a>, <b>
 *
 * Why no install/uninstall flags: every shell's completion-loading mechanism
 * is different, and many users have dotfiles managers that resent foreign
 * writes. Print to stdout and let the user redirect — universal, debuggable,
 * works in restricted environments.
 */
import chalk from "chalk";

export type SupportedShell = "bash" | "zsh" | "fish" | "powershell";
const SHELLS: SupportedShell[] = ["bash", "zsh", "fish", "powershell"];

/**
 * Source of truth for subcommands + their flags. Mirrors what's wired in
 * src/index.ts via commander. Keeping this list in sync is a manual chore;
 * a future refactor could pull it from program.commands directly.
 */
const COMMANDS: { name: string; flags: string[]; takesFile?: boolean }[] = [
  { name: "login", flags: ["--force", "-f"] },
  { name: "logout", flags: [] },
  { name: "whoami", flags: ["--output", "-o"] },
  { name: "diagnose", flags: [] },
  { name: "repair", flags: ["--yes", "-y"] },
  { name: "check", flags: [], takesFile: true },
  { name: "pipe", flags: ["--threshold", "-t", "--output", "-o", "--max-bytes"] },
  { name: "watch", flags: [] },
  { name: "consistency", flags: ["--n", "-n"] },
  { name: "compare", flags: [], takesFile: true },
  { name: "diff", flags: [], takesFile: true },
  { name: "history", flags: [] },
  { name: "export", flags: ["--limit", "-l"] },
  { name: "plans", flags: ["--output", "-o"] },
  { name: "quota", flags: ["--output", "-o"] },
  { name: "update", flags: ["--apply", "--output", "-o"] },
  { name: "about", flags: ["--output", "-o"] },
  { name: "config", flags: [] },
  { name: "logs", flags: ["--limit", "-l", "--output", "-o"] },
  { name: "completion", flags: [] },
  { name: "help", flags: [] },
];

const COMMAND_NAMES = COMMANDS.map((c) => c.name).join(" ");

// ── Shell-specific generators ─────────────────────────────────────────

function generateBash(): string {
  // Standard pattern: a function _zpl_complete reads COMP_WORDS / COMP_CWORD,
  // picks the right list per position, and writes COMPREPLY.
  const flagsPerCmd = COMMANDS.map(
    (c) => `    ${c.name}) options="${c.flags.join(" ")}" ;;`,
  ).join("\n");

  return `# zpl-engine-cli bash completion
# Install: zpl completion bash >> ~/.bashrc  (or ~/.bash_profile on macOS)
# Then:    source ~/.bashrc
_zpl_complete() {
  local cur prev cmd options
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${COMMAND_NAMES}" -- "\${cur}") )
    return 0
  fi

  case "\${cmd}" in
${flagsPerCmd}
    *) options="" ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${options}" -- "\${cur}") )
  else
    # Fall back to file completion for positional args (check, compare, diff)
    COMPREPLY=( $(compgen -f -- "\${cur}") )
  fi
}
complete -F _zpl_complete zpl
complete -F _zpl_complete zpl-engine-cli
`;
}

function generateZsh(): string {
  const cmdLines = COMMANDS.map((c) => `    "${c.name}:${c.name} command"`).join("\n");
  return `#compdef zpl zpl-engine-cli
# zpl-engine-cli zsh completion
# Install: zpl completion zsh > "$\{fpath[1]\}/_zpl"  (then restart shell)
# Or:      zpl completion zsh >> ~/.zshrc

_zpl() {
  local -a commands
  commands=(
${cmdLines}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _files
  fi
}
_zpl "$@"
`;
}

function generateFish(): string {
  // fish uses one `complete` line per completion candidate.
  const subcommandLines = COMMANDS.map(
    (c) =>
      `complete -c zpl -n "__fish_use_subcommand" -f -a "${c.name}" -d "${c.name} command"`,
  ).join("\n");

  // Per-subcommand flag completions
  const flagLines: string[] = [];
  for (const c of COMMANDS) {
    for (const flag of c.flags) {
      const stripped = flag.replace(/^-+/, "");
      const short = flag.length === 2 && flag.startsWith("-") && !flag.startsWith("--");
      const opt = short ? `-s ${stripped}` : `-l ${stripped}`;
      flagLines.push(`complete -c zpl -n "__fish_seen_subcommand_from ${c.name}" ${opt}`);
    }
  }

  return `# zpl-engine-cli fish completion
# Install: zpl completion fish > ~/.config/fish/completions/zpl.fish
# Restart: open a new fish shell (or 'source ~/.config/fish/completions/zpl.fish')

${subcommandLines}

${flagLines.join("\n")}
`;
}

function generatePowerShell(): string {
  // PowerShell uses Register-ArgumentCompleter for completion.
  const cmdsList = COMMANDS.map((c) => `'${c.name}'`).join(", ");
  return `# zpl-engine-cli PowerShell completion
# Install: zpl completion powershell >> $PROFILE
# Reload:  . $PROFILE

Register-ArgumentCompleter -CommandName zpl, zpl-engine-cli -Native -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(${cmdsList})

    # If we're typing the first arg after \`zpl\`, complete subcommand names.
    $tokens = $commandAst.CommandElements
    if ($tokens.Count -le 2) {
        $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
    # else: rely on default file completion for positional args.
}
`;
}

// ── Main ──────────────────────────────────────────────────────────────

export async function cmdCompletion(shell: string): Promise<void> {
  const lower = shell.toLowerCase() as SupportedShell;
  if (!SHELLS.includes(lower)) {
    process.stderr.write(
      chalk.red(
        `Unsupported shell: "${shell}". Supported: ${SHELLS.join(", ")}.\n`,
      ),
    );
    process.exit(2);
  }

  let script: string;
  switch (lower) {
    case "bash":
      script = generateBash();
      break;
    case "zsh":
      script = generateZsh();
      break;
    case "fish":
      script = generateFish();
      break;
    case "powershell":
      script = generatePowerShell();
      break;
  }

  process.stdout.write(script);
}
