// Outside a workspace, `talea sync` falls back to the workspaces this machine
// knows about. What it offers has to be real: a deleted workspace offered as a
// choice is a sync against a folder that is not there.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set before the imports: config.js reads the home directory when it loads.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-home-'));
process.env.HOME = process.env.USERPROFILE = home;
const { knownWorkspaces, USER_STATE } = await import('../src/config.js');
const { rememberWorkspace, workspaceCandidates } = await import('../src/workspace.js');

const makeWorkspace = (dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.talea.json'), '{}');
  return dir;
};

describe('the workspaces a command outside one can mean', () => {
  test('remembered once, and a workspace whose .talea.json is gone is not offered', () => {
    const live = makeWorkspace(path.join(home, 'code'));
    const gone = path.join(home, 'deleted');

    rememberWorkspace(live);
    rememberWorkspace(live);
    // Same folder on a case-insensitive filesystem; a second entry on Linux.
    if (process.platform !== 'linux') rememberWorkspace(live.toUpperCase());
    rememberWorkspace(gone);

    assert.deepEqual(JSON.parse(readFileSync(USER_STATE, 'utf8')).workspaces, [live, gone]);
    assert.deepEqual(knownWorkspaces(), [live]);
  });

  test('the default ~/Workspace is found even if nothing ever recorded it', () => {
    // A workspace made before the list existed has to keep working from
    // anywhere, or upgrading makes `talea sync` from home stop finding it.
    const fallback = makeWorkspace(path.join(home, 'Workspace'));
    assert.deepEqual(workspaceCandidates([], {}), [fallback]);
  });

  test('the default is not listed twice when it was also recorded', () => {
    const fallback = makeWorkspace(path.join(home, 'Workspace'));
    const other = makeWorkspace(path.join(home, 'other'));
    assert.deepEqual(workspaceCandidates([fallback, other], {}), [fallback, other]);
  });

  test('the catalogue’s own workspace name moves the default', () => {
    const src = makeWorkspace(path.join(home, 'src'));
    assert.deepEqual(workspaceCandidates([], { workspace: 'src' }), [src]);
  });
});
