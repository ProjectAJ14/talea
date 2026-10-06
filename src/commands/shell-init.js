import path from 'node:path';

import { c, fail } from '../log.js';

export const help = `
${c.bold('talea shell-init')} — let ${c.bold('talea cd')} and ${c.bold('tcd')} move your shell

  ${c.dim('eval "$(talea shell-init)"')}           in ~/.zshrc or ~/.bashrc
  ${c.dim('talea shell-init fish | source')}       in ~/.config/fish/config.fish

Then ${c.dim('talea cd ek')} or ${c.dim('tcd ek')} goes straight to the one repo matching "ek",
or lists them all to pick from with the arrow keys and Enter. ${c.dim('tcd')} alone goes
to the workspace root.

A program cannot change the folder of the shell that started it, so this prints
a small shell function that runs ${c.dim('talea where')} and does the ${c.dim('cd')} itself — the
same trick nvm and zoxide use. Every other ${c.dim('talea')} command passes through to
the real one unchanged. The shell is read from ${c.dim('$SHELL')} unless named: zsh, bash
or fish. PowerShell is not covered yet; on Windows use ${c.dim('talea where')} as the manual shows.
`;

// `function name {` and the unalias, not `name() {`: zsh expands an alias
// while parsing `name()`, so an existing `alias tcd=…` made the whole eval a
// parse error and took `talea` down with it. zsh parses the whole eval before
// the unalias runs, so a `talea` alias would still expand inside `tcd`'s body:
// hence `\talea`, which skips aliases and still finds the function. `--help`
// passes through: captured by $( ) it would be cd'd into.
const POSIX = `unalias talea tcd 2>/dev/null || true
function talea {
  case " $* " in
    *" -h "* | *" --help "*) command talea "$@"; return ;;
  esac
  if [ "$1" = cd ]; then
    shift
    local dest
    dest="$(command talea where "$@")" && cd -- "$dest"
  else
    command talea "$@"
  fi
}
function tcd { \\talea cd "$@"; }
`;

const FISH = `function talea
  if test "$argv[1]" = cd; and not contains -- -h $argv; and not contains -- --help $argv
    set -l dest (command talea where $argv[2..-1]); and cd $dest
  else
    command talea $argv
  end
end
function tcd; talea cd $argv; end
`;

const SCRIPTS = { zsh: POSIX, bash: POSIX, fish: FISH };

export async function run(opts, positionals = []) {
  const shell = positionals[0] ?? path.basename(process.env.SHELL ?? '');
  const script = SCRIPTS[shell];
  if (!script) {
    fail(
      shell
        ? `No shell-init for "${shell}" — talea knows zsh, bash and fish.`
        : 'Could not tell your shell from $SHELL — name it: talea shell-init zsh, bash or fish.',
    );
    process.exit(1);
  }
  process.stdout.write(script);
}
