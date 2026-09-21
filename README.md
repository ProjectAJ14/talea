# talea

**One folder structure for every machine you work on.**

You have a laptop, a desktop, and a work machine. On each one, the repo you want
is either missing or somewhere you have to go and find. `talea` fixes that: one
catalogue of your GitHub repos, one tree, and a command that makes any machine
match it.

```
~/Workspace/
  ProjectAJ14/
    eklavya/
    Morph/
    d-pilot/
  nonstopio/
    flutter_forge/
    json-viewer/
```

Same paths on every machine. `cd $(talea where eklavya)` works everywhere.

---

## Install

```sh
npm install -g @ajaykumarnpm/talea
```

The package is scoped; the command it installs is just `talea`.

Node 20 or newer. No other dependencies — not at runtime, not to build it.

## Your first machine

```sh
talea doctor                 # git, SSH and GitHub auth all reachable?
talea init ~/Workspace       # discovers your repos, asks what to keep, clones
talea manifest push          # publish the catalogue so the next machine can read it
```

`init` builds the catalogue from your GitHub account the first time — your own
repos, every org you belong to, and anything shared with you directly. It then
asks what this machine should keep and fills the tree.

## Every machine after that

```sh
talea manifest pull <gist-id>   # the id `manifest push` printed
talea init ~/Workspace
```

You are handed the full list with your defaults already ticked. Tick the extras
this machine needs, untick what it does not, press enter.

## Every day

```sh
talea sync                   # clone the new, fast-forward the rest
talea status                 # branch, clean/dirty, ahead/behind, in one table
talea add some-repo          # keep one more on this machine, and clone it now
cd $(talea where eklavya)
```

---

## The repos you already have

This is the part that matters on a machine you have been using for years.

`talea` never clones a repo you already have. Before cloning anything it scans
the workspace — and any folder you name with `--from` — and matches every
checkout it finds **by its git remote**, not by folder name. A repo cloned into
`~/tmp/clone2/whatever` is recognised as the repo it holds and **moved** into
place.

A move keeps everything: branches, stashes, the reflog, your uncommitted
changes. A re-clone throws all of it away, which is why this tool does not do
one.

```sh
talea adopt                      # show what would move, change nothing
talea adopt --from ~/Desktop     # look there too; the folder is remembered
talea adopt --apply              # do it
```

If the same repo turns up twice, the copy at the catalogue path wins and the
other moves into `.talea-duplicates/` with everything in it. **Nothing is ever
deleted.** Clearing that folder is your call.

After a move, the absolute paths that pointed at the old location are repaired —
Claude Code session history and project settings, `.idea`, `.vscode` — because a
repo that moves and loses its history has not really been helped.

---

## What travels, and what does not

| | Where it lives | Shared |
|---|---|---|
| **The catalogue** — every repo, its owner, its folder, its default branch | `~/.talea/talea.repos.json` | yes, through a private gist |
| **What this machine keeps** | `<workspace>/.talea.json` | **never** |

That split is the whole design. Pulling the catalogue onto a new laptop gives
you the full list to *choose* from — not the last machine's choices. Your work
laptop can keep three repos while the desktop keeps forty, and neither fights
the other.

The gist is private, but it still holds the names of your private repositories.
Treat the id like a bookmark you would not paste into a public channel.

---

## Commands

| | |
|---|---|
| `talea init [dir]` | create the workspace on this machine and fill it |
| `talea discover` | build or refresh the catalogue from GitHub |
| `talea sync` | clone what is missing, fast-forward what is there |
| `talea clone` | clone only — never fetches or merges |
| `talea adopt` | move checkouts you already have into place |
| `talea status` | branch, clean/dirty, ahead/behind |
| `talea add` / `talea rm` | change what this machine keeps |
| `talea where <repo>` | print a repo's path, for `cd $( )` |
| `talea list` | the catalogue |
| `talea tree` | the folder tree on disk |
| `talea exec -- <cmd>` | run one command in every repo |
| `talea manifest push/pull` | move the catalogue between machines |
| `talea doctor` | check this machine can do the work |
| `talea upgrade` | update the CLI itself |

Every one of them takes `-g <group>` and `-r <repo>` to narrow the run, and
`--help` for its own examples.

---

## What it will not do

- **It will not push.** Read and checkout only.
- **It will not throw away uncommitted work.** A dirty repo is fetched and left
  alone, with a line saying so.
- **It will not merge a divergence.** Fast-forwards only; anything else is
  reported for you to deal with.
- **It will not move you off your branch.** If you are on a feature branch, that
  is where the work is. It fast-forwards the branch you are on, or leaves it.
- **It will not delete anything.** Not a duplicate, not a checkout you removed
  from the list, not a folder in the way. It moves things and tells you where.

## Auth

Cloning uses **SSH** (`--protocol https` if you prefer). Reading the catalogue
uses the GitHub API, via the `gh` CLI if it is installed, else `GITHUB_TOKEN`,
else public repos only — which is a working state, not an error.

If `gh` is installed, talea uses it for API calls. That is deliberate beyond the
token: `gh` trusts your system's certificate store, so talea keeps working on a
machine behind a corporate proxy or VPN where Node's own HTTPS would fail.

## Contributing

```sh
git clone git@github.com:ProjectAJ14/talea.git
cd talea
npm test          # no install step — there are no dependencies
node bin/talea.js --help
```

Tests run on macOS, Linux and Windows across Node 20, 22 and 24 on every push.

## Licence

MIT.
