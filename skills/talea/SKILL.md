---
name: talea
description: "Operate talea, the CLI that gives every machine the same folder structure for its GitHub repos. Use when the user asks where a repo is, to clone or sync or pull their repos, to tidy or reorganise a workspace, to adopt checkouts that are in the wrong place, to change what this machine keeps, or to move their repo catalogue to another machine. Also use before running a command in several repos at once. Do not use for ordinary git work inside one repo that is already checked out."
---

<!-- talea-skill: installed by `talea skill install`; edits are overwritten -->

# talea

`talea` keeps one folder structure across every machine a developer works on.
It holds a catalogue of their GitHub repos, moves checkouts they already have
into place, clones what is missing, and fast-forwards the rest.

Two rules make it safe to hand to an agent: it never pushes, and it never
deletes. Everything below leans on that.

## Find the binary first

```bash
command -v talea
```

That prints the path, or nothing. It is installed with
`npm install -g @ajaykumarnpm/talea` — the package is scoped, the command is
not. If it prints nothing, fall back to `npx -y @ajaykumarnpm/talea <command>`,
which downloads on first use. If that fails too, say talea is not installed and
give the one install command rather than guessing at a path.

Shell variables do not survive between tool calls, so write the resolved path
into every later command rather than setting `T=` and hoping.

Everything below writes `talea` for readability. Substitute whatever the line
above resolved to.

## Where is this repo?

This is the command to reach for most, and the reason the tool exists.

```bash
talea where eklavya          # the absolute path, one line, nothing else
cd "$(talea where eklavya)"  # what it is actually for
talea where                  # the workspace root
```

It exits **non-zero** on an unknown name and writes every diagnostic to stderr,
so `cd "$(talea where typo)"` fails instead of landing in the home directory.
Never `cd` to a path it did not print.

Outside a workspace it falls back to the ones this machine has. With several
and no terminal — which is how you run it — it lists them and exits non-zero.
`cd` into the workspace the user means rather than guessing from the list.

Two owners can own a repo of the same name. When that happens it says so and
exits non-zero — pass `owner/name` rather than picking one.

## Read before you write

None of these change anything on disk. Run one before proposing work.

| Command | Answers |
|---|---|
| `talea status` | branch, clean or dirty, ahead or behind, for every repo this machine keeps |
| `talea list` | the catalogue — every repo, its group, its folder |
| `talea tree` | the folder tree as it actually is on disk |
| `talea doctor` | can this machine do the work: git, SSH, GitHub auth, the workspace |
| `talea adopt` | what a move *would* do. It changes nothing without `--apply` |

`talea status` is the one to run before suggesting a sync — a dirty repo is
skipped, and saying so up front is better than reporting it afterwards.

## Bringing a machine into line

```bash
talea sync                   # clone what is missing, fast-forward what is there
talea clone                  # clone only — never fetches or merges
talea sync -g NonStop        # one group
talea sync eklavya           # one repo — same as -r eklavya
```

`sync` is safe to run unattended. It fast-forwards **the branch you are on** and
leaves anything else alone with a line saying why. It never switches branches,
never merges a divergence and never pushes.

Every bulk command exits non-zero if **any** repo failed, so check the exit
code — the per-repo errors are printed but the run keeps going.

## Adoption: the one that moves things

A repo the developer already has, in the wrong folder, is **moved** into place
rather than re-cloned. A move keeps branches, stashes, the reflog and
uncommitted work; a re-clone throws all of it away.

```bash
talea adopt                    # show what would move, change nothing
talea adopt --from ~/Desktop   # look there too; the folder is remembered
talea adopt --apply            # do it
```

**Always run it without `--apply` first and show the developer the plan.** A
move relocates directories they may have open in an editor, a terminal or a
long-running process.

Matching is on the **git remote URL**, not the folder name. When only the name
matches — a fork, a mirror, an SDK cache — it is listed and left alone. `--loose`
or `-r <repo>` includes it. Do not reach for `--loose` on the developer's behalf:
the guard exists because an FVM Flutter SDK cache reports `origin` as
`flutter/flutter` and name-matches a personal fork, and adopting it breaks every
Flutter project on the machine.

A second copy of the same repo is **parked** in `.talea-duplicates/`, not
deleted. Say so when it happens — clearing that folder is the developer's call,
and nothing in talea will do it for them.

## What this machine keeps

```bash
talea add some-repo     # keep one more here, and clone it now
talea rm some-repo      # stop keeping it — the checkout stays exactly where it is
talea select            # reopen the whole checklist, interactively
talea pick some-repo    # = add when the name is exact; otherwise the checklist
```

`talea select` needs a terminal. In a non-interactive session it prints a
summary instead of hanging, so prefer `add` and `rm` when acting on the
developer's behalf and leave `select` as something to suggest they run.
`pick <name>` falls back to that same checklist on a typo, so an agent uses
`add`, which fails loudly instead.

`talea update` reinstalls the CLI (it is `upgrade`), not `sync`. Never run it
to refresh repos.

`rm` does **not** delete the checkout. Say that plainly when you run it, or it
reads like data loss.

## Running one command everywhere

```bash
talea exec -- git status --short
talea exec -g NonStop -- npm test
```

Everything after `--` runs in each repo. Treat it as you would any command run
in N repositories at once: read-only commands freely, anything that writes only
when the developer asked for it by name.

## Moving the catalogue between machines

```bash
talea manifest push            # publish it; prints a gist id
talea manifest pull <gist-id>  # on the next machine
```

The gist is **private**, but it still carries the names of private
repositories. Treat the id as something not to paste into a public channel, and
do not print it into a message that is going somewhere shared.

The split that matters: the **catalogue** travels, the **selection** does not.
Pulling it onto a new laptop hands over the full list to choose from, never the
last machine's choices. So `manifest pull` alone changes nothing about what is
cloned — `talea init` or `talea select` after it is what fills the tree.

## Narrowing any run

Every command takes `-g <group>` and `-r <repo>`, both repeatable, and `--help`
for its own examples. For `sync`, `clone`, `status`, `list` and `tree` a bare
name is the same as `-r`. `adopt` is the exception: it refuses a bare name,
because `-r` there lifts the name-only guard and must be typed on purpose. An
unknown group or repo name **exits non-zero** rather than quietly doing nothing,
so a typo is loud.

## Rules

- **Never `--apply` an adopt the developer has not seen the dry run of.**
- **Never `--loose`** unless they have looked at the name-only matches and said
  which one they want.
- Report a move as *moved*, a removal as *taken off the list*, and a duplicate
  as *parked*. Those are three different things and the words are the whole
  safety story.
- Do not add `ignore: true` to a catalogue entry to work around a conflict
  without saying so — it means another tool owns that checkout, and every talea
  command will skip it from then on.
- talea never pushes. If a repo is ahead of its remote, report it and stop;
  pushing is the developer's call and not talea's job.
- A bulk command that exits non-zero has a failed repo in it. Read the output
  for the failures rather than reporting the run as done.
