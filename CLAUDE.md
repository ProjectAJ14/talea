# CLAUDE.md — talea

`talea` gives every machine you work on the same folder structure. It builds a
catalogue of your GitHub repos, moves the checkouts you already have into place,
clones what is missing, and fast-forwards the lot. Installed globally.

**Read this before changing anything here.**

## Stack

Node.js **20+**, ESM (`"type": "module"`), **zero dependencies** — runtime *and*
dev. Cross-platform: macOS, Windows, Linux.

There is nothing to install. `npm test` runs bare `node --test` — **not** a glob:
`node --test "test/*.test.js"` finds nothing on Node 20, the declared minimum,
and unquoted it needs a globbing shell that cmd.exe is not.

## Layout

```
bin/talea.js               entry point; formats top-level errors
src/
  cli.js                   arg parsing, the command table, aliases
  config.js                manifest + state resolution, paths, URLs
  workspace.js             target selection — what this run is about
  select.js                "what does this machine keep?", asked once
  github.js                the two API calls and the gist
  git.js                   git plumbing; spawn with shell:false
  adopt.js                 match checkouts by remote, move them, repair paths
  theme.js                 the look, in one file — palette, glyphs, width maths
  log.js                   composes theme.js into headings, tables, the box
  live.js                  the live block redrawn in place while pooled() works
  prompt.js                the selection tree (pure) + raw-mode checkbox picker
  docs.js                  write templates/<GROUP>.CLAUDE.md into the workspace
  update.js                version check against the npm registry
  commands/                one file per command
manifest/talea.repos.json  the packaged catalogue — SHIPS EMPTY, see below
skills/talea/SKILL.md      the agent-facing skill `talea skill install` copies
templates/                 group CLAUDE.md files, dropped in by clone/sync
test/                      node --test
web/                       the site and the manual — its own CLAUDE.md
```

`web/` is a separate world: Astro, its own `package.json`, its own dependencies,
deployed to Firebase Hosting. Nothing in `src/` may import from it and nothing in
it may import from `src/`. **Read `web/CLAUDE.md` before touching it.** The one
thing that spans both is the palette — see *The look* below.

## The data model — read this first

Three files, and confusing them is how this tool would go wrong.

| File | Holds | Travels? |
|---|---|---|
| `<workspace>/talea.repos.json` | a catalogue for this tree only | no |
| `~/.talea/talea.repos.json` | **your** catalogue — what `discover` writes | yes, via gist |
| `<workspace>/.talea.json` | what **this machine** keeps, and what it has moved | **never** |

Nearest catalogue wins. The packaged one is last and is **empty on purpose**:
talea is the machinery, not a list of anybody's repositories. A published
package carrying the author's repo list would be a personal tool wearing a
general one's name.

The split that everything hangs off: **the catalogue is shared, the selection is
not.** Pulling the catalogue onto a new laptop gives you the full list to choose
from — never the last machine's choices. That is why `state.selected` is a list
of names rather than a filter over `default: true`: a filter would re-evaluate,
and adding `default: true` to a repo would silently start cloning it on every
machine you own. The catalogue does not get to make that decision.

`state.selected` being **absent** and being **empty** mean different things.
Absent is "never asked" and falls back to the catalogue defaults; empty is "I
chose nothing". A test pins that.

**Commands run from anywhere.** Inside a workspace the upward walk to
`.talea.json` wins, as git's does. Outside one, `requireWorkspace()` falls back
to the workspaces this machine knows: every root `init` recorded in
`~/.talea/state.json` (and any root a command was run inside, so pre-existing
workspaces join the list), plus the default `~/Workspace`. One is used with a
note on stderr; several are asked about **on stderr**, so `cd $(talea where)`
never swallows the prompt; several with no terminal is a non-zero exit, never
a pick — a script syncing whichever came first is syncing a tree nobody named.
That list is machine state, not catalogue: a path on this laptop means nothing
on the next one, so it never travels with `manifest push`.

## The rules that matter

These are load-bearing. Breaking one causes data loss or a silent failure.

1. **No dependencies.** Node's stdlib covers argument parsing (`node:util`
   `parseArgs`), subprocesses, filesystem, colour and now HTTP. A tool installed
   globally should carry no supply chain. Adding a dependency needs a written
   reason.

2. **Worktrees travel with their repo.** A worktree's link to its repo is an
   absolute path, so a rename breaks every one at once. `executeMove` reads the
   worktree list **before** the rename — afterwards every worktree that moved is
   reported `prunable`, indistinguishable from a dead one, so reading late
   filters out exactly the ones that need repairing — then moves the sibling
   `<repo>-worktrees/` folder and runs `git worktree repair` with the new paths.
   That folder is derived from the repo's path when a worktree is created and
   never stored, so leaving it behind does not error; it silently splits the
   workflow in two. A linked worktree is never treated as a second copy of the
   repo, though it reports the same `origin` — renaming one unroots its commits.

3. **A name-only match is never moved unattended.** `matchRepo` returns `exact`
   when the remote URL matches and `name` when only the repo name does. `clone`
   and `sync` act on `exact` only, and so does `adopt --apply`; `--loose` or an
   explicit `-r` is how you say otherwise. Found on a real machine: an FVM
   Flutter SDK cache has origin `flutter/flutter`, which name-matches a personal
   `flutter` fork, and adopting it breaks every Flutter project there. Parks are
   gated the same way — parking is a move, and that case was a park.

4. **`ignore: true` means another tool owns that checkout.** No command touches
   it — not `sync`, not `adopt`, not even an explicit `selected` entry. Two
   tools that both organise repositories will otherwise each drag the same
   checkout back where it thinks it belongs, on every run, forever. Found on a
   real machine: two repos living inside a second workspace manager's tree.
   Enforced in `adoptable()` as well as `machineRepos()`, because `adopt`
   deliberately reaches past this machine's selection.

5. **Never destroy uncommitted work.** No `reset --hard`, no `clean -fd`, no
   `checkout --force`. Check `isDirty()` and skip with a warning.
   This is also why a repo in the wrong place is **moved, not re-cloned**. A
   `renameSync` keeps branches, stashes, reflog and uncommitted work; a re-clone
   silently discards all of it. Never copy-then-delete — a cross-device move is
   refused and reported instead.
   And why a *second* copy of a repo is **parked, not deleted**: it moves to
   `.talea-duplicates/<GROUP>/<repo>` with everything in it, and clearing that
   folder is the developer's decision. `src/adopt.js` has no `rmSync` in it;
   keep it that way.
   `talea rm` follows the same rule: it takes the repo off this machine's list
   and leaves the checkout exactly where it is.

6. **Never push.** This is a read-and-checkout tool. No `git push`, ever.

7. **Never switch branches.** `sync` fast-forwards the branch you are on, or
   leaves it alone and says why. A tool that moves you off a feature branch
   mid-task is no better than one that clobbers your changes. This is also why
   there is no environment/branch-mapping machinery: it belongs to a workspace
   of deploy branches, not to a person's own repositories.

8. **Never guess a branch.** `defaultBranch` is recorded per repo by `discover`,
   because GitHub is the only thing that knows. A repo with none recorded is
   cloned on whatever the server hands over — not on an assumed `main`.

9. **Fail loudly on typos.** An unknown group or repo name exits non-zero. A
   bulk command that quietly does nothing is worse than one that stops.
   `talea where` is the sharp case: it exits non-zero and writes every
   diagnostic to **stderr**, because `cd $(talea where typo)` must fail rather
   than land you in your home directory.

10. **Bulk commands exit non-zero on any failure.** `summary()` in `src/log.js`
   sets `process.exitCode`. Commands print per-repo errors and keep going, so
   without this a partial failure reads as success to a script.

11. **Discovery refreshes facts, never choices.** GitHub owns `owner`,
   `defaultBranch`, `fork`, `pushedAt`. You own `default`, `group`, `dir`,
   `url`. A repo the API does not return is **kept and marked `missing`** — a
   narrower token, a revoked org grant and a deleted repo look identical from
   here, and forgetting it is the only unrecoverable reading.

12. **No silent self-update.** The tool moves checkouts across every repo a
   developer has. It tells them an update exists; they choose when.

## The look

`src/theme.js` owns every byte of colour this CLI prints, and its `PALETTE` is
the **verdigris ramp from `web/public/tokens.css`** — the `--vd-*` steps, as
hexes. That is deliberate: the terminal and talea.run are one product, and a CLI
in phosphor green beside a website in verdigris reads as two tools that share a
name. Change one and change the other.

24-bit colour is gated on `COLORTERM`, with a basic-16 fallback per role. That is
not caution for its own sake: a terminal that does not understand
`\x1b[38;2;r;g;bm` does not silently drop it — it parses the SGR opener and
spills the remaining parameters onto the line as visible text.

Both colour paths close with `39` ("default foreground") and never with `0`. A
full reset also clears bold and dim, so a colour nested inside `dim()` would
un-dim the rest of the line on a truecolor terminal and not on a basic one — a
rendering difference gated on an environment variable, which is the worst kind to
reproduce.

## The agent skill

`skills/talea/SKILL.md` is a single Markdown file that teaches a coding agent to
drive this CLI. `talea skill install` copies it to
`~/.claude/skills/talea/SKILL.md` — **user scope**, honouring `CLAUDE_CONFIG_DIR`,
because a developer's workspace spans every project they open and a repo-scoped
skill would only exist in the one checkout where the question never gets asked.

Two rules hold it up, and `test/skill.test.js` pins both:

- **It never overwrites a skill it did not write.** Somebody's own
  `~/.claude/skills/talea/` is their work and there is no undo, so `install`
  refuses on any file missing talea's own marker, and `uninstall` deletes only a
  file carrying it.
- **It reports failure through `process.exitCode`, not `process.exit()`.** Same
  contract `summary()` uses, and the only one a test can drive without taking the
  runner down with it.

The skill's content is mostly restraint — never `--apply` an unseen adopt, never
`--loose`, never call a removal a delete. Those are the same rules as above,
written for a reader who will act on them without asking. When one of them
changes here, it changes there.

## Talking to GitHub

`src/github.js` prefers the `gh` CLI over `fetch` when `gh` is installed, and
that is not only about the token. `gh` is a Go binary that trusts the **system**
certificate store; Node's `fetch` trusts a CA list compiled into Node. On any
machine behind TLS interception — a corporate proxy, a VPN, a security agent —
`curl` and `gh` work and `fetch` dies with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
This was found on the first machine it ran on. Preferring `gh` means that
machine needs no configuration at all; the `fetch` path stays for machines
without `gh`.

`gh api --paginate` prints each page as a **separate JSON document**, so
`--slurp` is mandatory — stitching the pages back together by string surgery
breaks on a repo whose description contains `] [`.

## Distribution and releasing

Public package `@ajaykumarnpm/talea` on the public npm registry, installed with
`npm install -g @ajaykumarnpm/talea`. **Scoped because npm refused the bare
name** — its typo-squatting filter called `talea` too similar to `tape`, `taze`,
`table` and `jaltea`. That filter only fires at publish time, so there is no way
to test an unscoped name in advance. The binary is still `talea`, and
`publishConfig.access` is pinned to `public` because a scoped package defaults
to restricted and would otherwise publish private by accident. `upgrade` reads the registry's `latest` and reinstalls.
A copy that is a git checkout refuses to self-upgrade — replacing somebody's
working branch with a release is data loss with a friendly name.

**A release is a push to `main`.** `.github/workflows/release.yml` reads the
commits since the last tag, and if any of them asks for a version — a `feat:`, a
`fix:`, a `!` breaking change — it bumps `package.json`, writes the `CHANGELOG.md`
entry, commits, tags, cuts the GitHub release and publishes to npm. A push of
nothing but docs and chores releases nothing, and says so. There is no command
to remember and nothing to forget, which is the whole point: a release that
depends on somebody running two commands in the right order is a release that
eventually goes out wrong.

So **the commit messages are the release process**. Conventional Commits are not
a style preference here — `feat:` is a minor, `fix:` and `perf:` are a patch,
`!` or a `BREAKING CHANGE:` body is a major, and anything else ships nothing on
its own. Below 1.0.0 a breaking change takes the minor instead: declaring the
tool stable is a deliberate act, not something one `feat!:` does on the author's
behalf.

`scripts/release.mjs` holds that decision, out of the YAML and under test in
`test/release.test.js` — the release runs unattended, so the only thing between
a careless commit message and a wrong version number is that test.

To force a version — a release with no releasable commits, or a major — run the
workflow by hand: Actions → release → *Run workflow*, with `bump` set to
patch/minor/major, or `gh workflow run release.yml -f bump=minor`.

Publishing lives in that same workflow rather than in one of its own because **a
release created with `GITHUB_TOKEN` does not trigger other workflows** — GitHub
refuses, so that a workflow cannot loop itself. An `on: release` job would sit
there and never run. The bump commit carries `[skip ci]` for the same family of
reasons: the matrix already ran on the commits that earned the release, and
without it the push starts the whole thing again.

Which is a trap worth knowing about: GitHub reads that marker anywhere in the
commit message, **body included**. A commit whose body merely mentions it — a
message explaining this very mechanism did — is pushed with no workflow run at
all, and the push looks like CI is broken. Write it as "the skip marker" in
prose and only ever put the literal token in the release commit.

**There is no npm token.** The workflow authenticates with npm **trusted
publishing** over OIDC: npm mints a short-lived credential for this repository
and this workflow file, checked against the publisher configured on the package.
A long-lived token that cannot exist cannot leak, and nothing expires in a
drawer. The publisher is matched by workflow **filename** — renaming
`release.yml` breaks publishing until the setting on npmjs.com is updated to
match. Trusted publishing needs npm >= 11.5.1, which is newer than the npm
bundled with any Node 22, so the workflow installs `npm@11` first; `npm@latest`
is 12.x and wants a Node the runner may not have.

**Never publish from a laptop**, because `--provenance` needs the OIDC token
only a workflow has — a local publish silently ships an unattested tarball, and
skips every check the workflow makes.

A laptop is also the less reliable place to publish from, for a reason worth
writing down. This machine sits behind **Cisco Secure Access**, which terminates
TLS and re-signs with a root that is in the system keychain and *not* in the CA
list compiled into Node. Which hosts it covers changes with VPN state: in one
session `api.github.com` was intercepted and `registry.npmjs.org` was not, and
earlier the same day npm itself died with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
`curl` and `gh` are unaffected because they trust the keychain. A release that
depends on which hosts are being intercepted this hour is not a release process.

The tag and `package.json` can no longer disagree, because the same run writes
both. That used to be a check; now it is not a thing that can happen.

`CHANGELOG.md` is prepended to, never rewritten. A published entry is a record
of what somebody installed, and editing it makes the record a guess.

**The publish goes before the push.** The run bumps, commits and tags locally,
publishes to npm, and only then pushes the tag and cuts the release — so a
registry that refuses the package leaves nothing behind to clean up. The other
order is what produced `v0.2.1`: tagged and released on GitHub, rejected by npm,
and now a version that exists in the history and has never existed on the
registry. Past the publish step the version is public and cannot be withdrawn,
which is why the tag follows it; a push that fails after a successful publish
leaves a published version with no tag, and that is recoverable by hand.

## The site

`web/` is built by Astro and deployed to Firebase Hosting at
https://talea-run.web.app by `.github/workflows/firebase.yml`, on any push to
`main` that touches `web/`, `firebase.json` or `.firebaserc`. The Firebase
project is `talea-run` and the deploy uses a service-account secret,
`FIREBASE_SERVICE_ACCOUNT_TALEA_RUN`.

The two workflows overlap and that is fine, because they are gated on different
things. This one is gated on **paths**: it only runs when `web/` (or the Firebase
config) changed. The release workflow runs on every push to `main` but is gated
on **commit messages**, and site work is a `docs:` commit, which releases
nothing. So a site-only push deploys the site and publishes no version — not
because the release workflow did not run, but because it ran and correctly found
nothing to ship.

The design system is shared with `eklavya/web` on purpose — same tokens, same
type scale, same two grounds. `web/CLAUDE.md` says what talea inherits and what
it deliberately does not.

## Current status

- **Ported from a private workspace manager** that did the same job for one
  company's 44 repos on a self-hosted git host. Everything about environments,
  branch mapping, the private registry and the per-team templates was dropped; the
  adoption, safety, theming and live-block machinery was kept because it had
  already been through the failure modes.
- **Verified end-to-end** on macOS against real GitHub repos: clone, a stray
  checkout with a feature branch and a stash moved into place by remote match
  (branch and stash intact, folder name completely different), a second copy
  parked in `.talea-duplicates/`, `add`, `rm`, `where`, `status`.
- **228 repos discovered** for the first user across 18 owners, because
  `affiliation=owner,organization_member,collaborator` reaches further than
  `gh repo list` does. Most are quiet; `--since` marks them, nothing is dropped.
- **`templates/` ships empty.** `docs.js` works — it writes
  `templates/<GROUP>.CLAUDE.md` into each group folder and never overwrites an
  existing file — but there is no template to write yet. Adding a doc is adding
  a file; that is the whole wiring.
- Cross-platform care inherited from the original, and worth keeping: treat any
  new `path.relative` / `startsWith` / `includes` on two paths as a Windows bug
  until proven otherwise. Node gets 8.3 short names out of TEMP while git prints
  the long ones, and `normalizeUrl` has to unify `\` with `/` or a checkout
  stops matching its own catalogue entry and gets cloned a second time.

## When changing behaviour — the docs move in the same commit

**Every change updates its documentation in the same commit. Not the next one,
not a follow-up, not "I'll do the docs after".** This tool has five places that
describe it, and a change that lands in one of them is a change that now
contradicts the other four. There is no reviewer who will catch that, and the
reader who finds the stale one has no way to tell which is true.

So, in the same commit as the code:

| Update | When |
|---|---|
| `README.md` | anything user-facing |
| the command's own `help` string in `src/commands/<name>.js` | always — it is the first place anybody looks |
| `USAGE` in `src/cli.js` | a new command, or a changed one-line description |
| the matching page under `web/src/content/docs/docs/` | always. `web/CLAUDE.md` has the page-to-source table |
| `web/public/index.html` | the landing page states a fact the change makes false — a count, a flag, a promise |
| `skills/talea/SKILL.md` | an agent could reach the behaviour, or a guardrail moved |
| this file | the change was a *decision*, not just code — a new rule, a new trade-off, a new reason |
| a test | always |

Two of those are easy to forget and both are load-bearing:

- **The manual is a test of the source, not prose about it.** Read the value out
  of the file — the default, the flag, the path — rather than copying what the
  page already says, or the page compounds its own drift.
- **The landing page quotes real CLI output.** The hero terminal's glyphs, row
  format, picker keys and summary counts all come from `src/theme.js`,
  `src/log.js` and `src/prompt.js`. Change one of those and the page is printing
  something the tool does not.

If a change genuinely touches none of the docs, say so in the commit body. That
is a claim somebody can check; silence is not.

<!-- BEGIN interaction-rules -->

## Where a document lives while it is being written

**A draft does not go in a repository.** Write it outside the repo and move it in
only when it is final.

A repo's `docs/` folder is for documents that are true right now and that somebody will
read again: implementation guides, testing conventions, runbooks, schema notes. It is not
a workspace. A draft committed there is a claim that the thing is settled, and everyone
who greps the folder reads it as one.

- **While writing** — outside the repo, so it cannot ride along in somebody's
  `git add -A` and does not show up in `git status` for whoever else has that checkout
  open.
- **When it is final** — move it into `docs/` in the same commit as the code it
  describes, and link it from the `CLAUDE.md` that governs the area. A document with no
  inbound link is a document nobody finds.
- **If it describes work that has not happened yet**, it is an issue, not a document.

The test: *would somebody read this in six months and act on it?* Yes → `docs/`.
No → drafts, and delete it when the work lands.

## Every answer ends with what I have to DO — ALWAYS

This is the rule that keeps getting broken, so it goes first.

- **Group by topic.** A heading per topic. Bullets under it. Never one long run of prose.
- **Close with `What I need from you:`** — a short list of actions, or the single word
  `Nothing`. If the developer has to re-read the answer to work out what they are being
  asked to do, the answer failed.
- **Ten lines per topic, hard cap.** Longer means it is two topics, or it is detail nobody
  asked for.
- **Do not re-explain what they already know.** They were in the conversation. Skip the
  recap and the background; give the new fact.
- **A correction is one line.** "I was wrong about X, here is the truth." Not a paragraph
  about how the mistake happened.
- **No narrating the investigation.** They want the finding, not the route to it.

Length is not thoroughness.

## Always recommend, and say what it costs — ALWAYS

**Never hand over a list of options and stop.** Options without a recommendation move the
decision back with none of the work done. They asked for the options so they could see the
trade-off, not so they could do the analysis.

Every set of options ends with a pick, and the pick carries:

- **Which one, in one line.** Not "it depends" and not two co-favourites.
- **Why — the reason, not the restatement.** "Because correctness beats cosmetics here" is
  a reason. "Because it fixes the bug" is the option repeated back.
- **What it costs.** Time, risk, what stays broken meanwhile, who else it blocks.

**When the quick fix and the right fix are different, give BOTH and say so.**

- **The patch** — what to do now, how long, and precisely what it leaves unfixed.
- **The proper fix** — what it takes, and what it buys that the patch does not.
- **Which one to do today, and whether the other still needs an issue.** A patch shipped
  with no issue for the real fix is a decision to never fix it, and it should be named as
  such.

If there is genuinely only one sane option, say that too, and say why the alternatives are
not alternatives. Silence reads as "I did not think about it".

## Check before you conclude — ALWAYS

**Never name a cause you have not verified.** If a claim can be checked, check it before
saying it — not after being pushed back on.

- **Query the specific rows, never the aggregate.** The population you are explaining is
  the one to look at. A rate across everything has produced confident wrong diagnoses
  about four specific cases more than once.
- **Measure over a window longer than the thing you are measuring.** "Zero errors in the
  last two minutes" can fall between two ticks of a scheduler and mean nothing.
- **Read the code path before blaming it.** One `grep` for the call site is cheaper than a
  wrong diagnosis, and it is usually the whole investigation.
- **A sample proves what it contains, never what it lacks.** To claim absence, count over
  the population that would contain it.
- **Do not generalise a diff from the lines you happened to read.** `--ignore-all-space`
  does not prove a formatting-only change — it cannot collapse a line break, and joining
  lines is most of what a formatter does.
- **Check whether the defect is yours before reporting it as somebody else's.**
  `git status` answers this, and attributing your own uncommitted mistake to the codebase
  wastes somebody's time twice.

The pattern under all six: **say what would make the claim false, then go and look for
that.** Confirming evidence is easy to find for a wrong answer; an honest attempt to
falsify is what separates a verified claim from a plausible one.

When something cannot be verified, say so plainly and say what would settle it. "I think X,
and the way to know is Y" is worth more than a confident wrong answer.

## Do not make me connect the dots — ALWAYS

**No cross-referencing.** Say the thing, in the place where it matters, in full.

- No "as in tier D", "see options A–C above", "like the earlier case". If a fact matters
  here, state it here. Naming a category somebody has to scroll back and decode is the same
  as not saying it.
- No old issue numbers as shorthand. Nobody remembers what `#4992` was about a month
  later. Say what it *was*, then the number if it is still useful.
- One decision per question. Presenting five findings that only mean something combined
  leaves the combining to the reader — do it first, then give the conclusion.

## Chat replies: short. Bullets. No noise. — ALWAYS

This governs what Claude writes **in chat**. Code comments, commit messages and documents
are unaffected — they stay as thorough as the rest of this file asks for.

- **Bullets by default.** Prose paragraphs only when a bullet genuinely cannot carry it.
- **Lead with the answer.** The finding, the number, the verdict — first line, no wind-up.
- **One line per point.** If a point needs three sentences, it is two points or it is detail
  nobody asked for.
- **Cut the reasoning unless asked.** Say what changed and what it means. The *why* is
  already in the code comment and the commit; do not restate it in chat.
- **No recaps.** Do not summarise what just scrolled past, do not re-list what was already
  agreed, do not close with "so in summary".
- **Asking a question:** the question, then the options. No preamble explaining why it is
  being asked.
- **Gotchas stay.** A "watch out" is never noise — keep it, one line, at the end.

The failure mode to avoid: a correct answer buried in three paragraphs of context the
reader already has.

## How I want things explained — ALWAYS

**Every answer, every context, every question** — explain in plain English first. No jargon,
no framework names, no acronyms unless unavoidable. Write as if explaining to a smart person
who doesn't write code every day.

- Lead with what it *does*, not what it *is*.
- Use concrete examples and real-world analogies whenever something is abstract.
- If something has a gotcha or a known bug — call it out explicitly at the end in plain
  terms.
- In DOCUMENTS and code comments, avoid bullet walls — group them or write in prose. In
  CHAT, bullets are the default; the section above wins on any conflict.
- Tables are fine for field mappings and comparisons.

**For code-review fixes and bugs specifically**, use this 6-part pattern:

1. **Issue (simple language)** — what is actually wrong, in one or two sentences somebody
   who does not work in this language would understand.
2. **Solution (simple language)** — what we'll do, in similarly plain words.
3. **Impact** — what breaks today, what data is lost, what user-visible symptom this
   prevents. Concrete consequences.
4. **Example** — a small concrete walkthrough, ideally a timeline with timestamps or a tiny
   snippet showing broken vs fixed.
5. **Changes needed** — bullet list of files, new classes, migrations, approximate LOC.
6. **Recommendation + why** — pick, rank, order, with a one-line reason. "Do #1 first
   because correctness; #3 last because cosmetic."

This pattern is for *explaining* a finding before coding. Once one is picked, dive straight
into code.

<!-- END interaction-rules -->
