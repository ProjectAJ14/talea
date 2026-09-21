# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-09-21

### Documentation
- the skip marker is read from the commit body too

### Chores
- publish before pushing the tag
- the pipeline cuts the release, not a laptop

## [0.2.1] - 2026-09-21

### Fixed
- The live block no longer repeats itself down the screen. A row wider than the
  terminal wrapped onto a second line, which threw off the cursor arithmetic the
  block redraws with, so every frame landed a line lower than the last. Rows are
  now cut to the window width.

### Chores
- Releases are published by a GitHub release rather than by pushing a tag, and
  npm authenticates with trusted publishing instead of a stored token.

## [0.2.0] - 2026-09-21

### Added
- `ignore: true` in the catalogue marks a checkout that another tool owns. No
  command touches it — not `sync`, not `adopt`, not an explicit selection.

### Fixed
- `init` defaults to `~/Workspace` and refuses to turn your home directory into
  a workspace.
- `adopt` moves a repo's worktrees with it and repairs their links, instead of
  leaving them stranded.
- A repo that matches only by name is never moved unattended. Say `--loose`, or
  name it with `-r`, to move one anyway.

## [0.1.0] - 2026-09-21

### Added
- First published release: `discover`, `clone`, `sync`, `adopt`, `add`, `rm`,
  `where`, `status` and `doctor`, the live progress block, and the shared
  catalogue with a per-machine selection that never travels with it.
- Published as `@ajaykumarnpm/talea` — npm's typo-squatting filter refused the
  bare name.
