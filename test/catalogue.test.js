// The logic that is talea's own rather than inherited: how a repo turns into a
// URL and a folder, what a machine keeps, and what a discovery run is allowed
// to overwrite.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import os from 'node:os';

import { defaultBranch, repoDir, repoGroup, repoUrl } from '../src/config.js';
import { merge, parseSince } from '../src/commands/discover.js';
import { toEntry } from '../src/github.js';
import { buildTree, selectedRepos, toggle } from '../src/prompt.js';
import { machineRepos } from '../src/workspace.js';
import { workspaceTarget } from '../src/commands/init.js';

const MANIFEST = {
  remotes: {
    ssh: 'git@github.com:{owner}/{repo}.git',
    https: 'https://github.com/{owner}/{repo}.git',
  },
  groups: { nonstopio: { dir: 'nonstopio' } },
  repos: [],
};

const repo = (over = {}) => ({ name: 'eklavya', owner: 'ProjectAJ14', ...over });

describe('one catalogue, many owners', () => {
  test('the owner comes from the repo, not the manifest', () => {
    assert.equal(
      repoUrl(MANIFEST, repo()),
      'git@github.com:ProjectAJ14/eklavya.git',
    );
    assert.equal(
      repoUrl(MANIFEST, repo({ name: 'json-viewer', owner: 'nonstopio' }), 'https'),
      'https://github.com/nonstopio/json-viewer.git',
    );
  });

  test('an explicit url wins over the template, protocol and all', () => {
    const r = repo({ url: 'git@gitlab.com:someone/thing.git' });
    assert.equal(repoUrl(MANIFEST, r, 'https'), 'git@gitlab.com:someone/thing.git');
  });

  test('an unknown protocol is an error, not a silently wrong remote', () => {
    assert.throws(() => repoUrl(MANIFEST, repo(), 'carrier-pigeon'), /Unknown remote protocol/);
  });

  test('a repo with no group falls back to its owner, so no curation is needed', () => {
    assert.equal(repoGroup(repo()), 'ProjectAJ14');
    assert.equal(repoGroup(repo({ group: 'work' })), 'work');
  });

  test('the folder is group/name, and a group dir may be a nested path', () => {
    const m = { ...MANIFEST, groups: { work: { dir: 'work/backend' } } };
    // Built with path.join rather than written out, because the separator is
    // the platform's: this same call returns \ws\work\backend\eklavya on
    // Windows and a literal forward-slash expectation fails there.
    assert.equal(
      repoDir(m, '/ws', repo({ group: 'work' })),
      path.join('/ws', 'work', 'backend', 'eklavya'),
    );
  });

  test('a branch is never guessed — null means "whatever origin hands over"', () => {
    assert.equal(defaultBranch(repo()), null);
    assert.equal(defaultBranch(repo({ defaultBranch: 'trunk' })), 'trunk');
  });
});

describe('what this machine keeps', () => {
  const manifest = {
    ...MANIFEST,
    repos: [
      repo({ name: 'a', default: true }),
      repo({ name: 'b', default: true, archived: true }),
      repo({ name: 'c' }),
    ],
  };

  test('with nothing chosen, the catalogue defaults stand in — minus the quiet ones', () => {
    assert.deepEqual(machineRepos(manifest, {}).map((r) => r.name), ['a']);
  });

  test('an explicit selection wins, including a repo the catalogue does not default', () => {
    const picked = machineRepos(manifest, { selected: ['c', 'b'] }).map((r) => r.name);
    assert.deepEqual(picked.sort(), ['b', 'c']);
  });

  test('an empty selection means empty — not "fall back to the defaults"', () => {
    // The difference between "I chose nothing" and "I have not chosen" is the
    // whole reason the state holds a list rather than a flag.
    assert.deepEqual(machineRepos(manifest, { selected: [] }), []);
  });

  test('a selected repo the catalogue no longer has is ignored, not fatal', () => {
    const names = machineRepos(manifest, { selected: ['a', 'deleted-on-github'] });
    assert.deepEqual(names.map((r) => r.name), ['a']);
  });
});

describe('the picker opens on your defaults', () => {
  const manifest = {
    ...MANIFEST,
    repos: [
      repo({ name: 'a', owner: 'me', default: true }),
      repo({ name: 'b', owner: 'me' }),
      repo({ name: 'c', owner: 'them', default: true }),
    ],
  };

  test('a predicate ticks exactly the repos it says', () => {
    const rows = buildTree(manifest, manifest.repos, (r) => Boolean(r.default));
    assert.deepEqual(selectedRepos(rows).map((r) => r.name), ['a', 'c']);
  });

  test('every repo is still listed, ticked or not — that is how you take an extra one', () => {
    const rows = buildTree(manifest, manifest.repos, (r) => Boolean(r.default));
    assert.equal(rows.filter((r) => r.kind === 'repo').length, 3);
  });

  test('an owner with no group entry still gets a group row', () => {
    const rows = buildTree(manifest, manifest.repos, false);
    const groups = rows.filter((r) => r.kind === 'group').map((r) => r.group);
    assert.deepEqual(groups.sort(), ['me', 'them']);
  });

  test('toggling the group row takes everything under it', () => {
    const rows = buildTree(manifest, manifest.repos, false);
    toggle(rows, rows.findIndex((r) => r.kind === 'group' && r.group === 'me'));
    assert.deepEqual(selectedRepos(rows).map((r) => r.name), ['a', 'b']);
  });
});

describe('discovery refreshes facts and never touches choices', () => {
  const found = [
    { name: 'a', owner: 'me', defaultBranch: 'main', archived: false },
    { name: 'new', owner: 'me', defaultBranch: 'main', archived: false },
  ];

  test('default, group and dir survive a re-discovery', () => {
    const existing = [
      { name: 'a', owner: 'me', defaultBranch: 'master', default: true, group: 'work', dir: 'aaa' },
    ];
    const { repos } = merge(existing, found);
    const a = repos.find((r) => r.name === 'a');

    assert.equal(a.defaultBranch, 'main', 'GitHub owns the branch');
    assert.equal(a.default, true, 'the choice is yours');
    assert.equal(a.group, 'work');
    assert.equal(a.dir, 'aaa');
  });

  test('a repo the API did not return is kept and marked, never dropped', () => {
    // A narrower token, a revoked org grant and a deleted repo look identical
    // from here. Forgetting the repo would be the one unrecoverable reading.
    const { repos, vanished } = merge([{ name: 'gone', owner: 'me' }], found);
    assert.deepEqual(vanished.map((r) => r.name), ['gone']);
    assert.equal(repos.find((r) => r.name === 'gone').missing, true);
  });

  test('a repo new to the catalogue is reported as new exactly once', () => {
    const { added } = merge([{ name: 'a', owner: 'me' }], found);
    assert.deepEqual(added.map((r) => r.name), ['new']);
  });

  test('two owners can hold the same repo name without colliding', () => {
    const { repos, added } = merge(
      [{ name: 'a', owner: 'me', default: true }],
      [...found, { name: 'a', owner: 'them', defaultBranch: 'main' }],
    );
    assert.equal(repos.filter((r) => r.name === 'a').length, 2);
    assert.equal(added.some((r) => r.owner === 'them'), true);
    assert.equal(repos.find((r) => r.owner === 'them' && r.name === 'a').default, undefined);
  });
});

describe('the activity window', () => {
  const now = new Date('2026-09-21T00:00:00Z');

  test('6mo, 90d and 2y all parse', () => {
    assert.equal(parseSince('6mo', now).slice(0, 10), '2026-03-21');
    assert.equal(parseSince('90d', now).slice(0, 10), '2026-06-23');
    assert.equal(parseSince('2y', now).slice(0, 10), '2024-09-21');
  });

  test('no window means nothing is marked quiet by age', () => {
    assert.equal(parseSince(undefined), null);
  });

  test('a window it cannot read is an error, not a silent "everything is active"', () => {
    assert.throws(() => parseSince('sometime last year'), /Cannot read --since/);
  });

  test('a repo quieter than the window is archived, not removed', () => {
    const since = parseSince('6mo', now);
    const old = toEntry({ name: 'x', owner: { login: 'me' }, pushed_at: '2025-01-01T00:00:00Z' }, { activeSince: since });
    const fresh = toEntry({ name: 'y', owner: { login: 'me' }, pushed_at: '2026-09-01T00:00:00Z' }, { activeSince: since });
    assert.equal(old.archived, true);
    assert.equal(fresh.archived, false);
  });

  test("GitHub's own archived flag is honoured whatever the window says", () => {
    const entry = toEntry({ name: 'x', owner: { login: 'me' }, archived: true, pushed_at: '2026-09-20T00:00:00Z' });
    assert.equal(entry.archived, true);
  });
});

describe('where the workspace goes', () => {
  test('no argument means ~/Workspace, never the current directory', () => {
    // `talea init` run from the home folder used to make HOME the root, which
    // reads as working right up until every scan is walking $HOME.
    assert.equal(
      workspaceTarget(undefined, { workspace: 'Workspace' }),
      path.join(os.homedir(), 'Workspace'),
    );
  });

  test('the folder name comes from the catalogue', () => {
    assert.equal(workspaceTarget(undefined, { workspace: 'code' }), path.join(os.homedir(), 'code'));
  });

  test('a catalogue with no name still lands somewhere sensible', () => {
    assert.equal(workspaceTarget(undefined, {}), path.join(os.homedir(), 'Workspace'));
    assert.equal(workspaceTarget(undefined, null), path.join(os.homedir(), 'Workspace'));
  });

  test('an explicit path is used as given, not nested under another folder', () => {
    assert.equal(workspaceTarget('/tmp/ws', { workspace: 'Workspace' }), path.resolve('/tmp/ws'));
  });

  test('~ in an explicit path is expanded, because a shell may not have', () => {
    assert.equal(workspaceTarget('~/code', {}), path.join(os.homedir(), 'code'));
  });
});
