// `init` must not guess what the machine keeps. The checklist runs in `sync`,
// so anything the workspace creates before that comes from the catalogue's
// defaults — every owner discovery found — and a folder made for a repo nobody
// picked never goes away on its own.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run as init } from '../src/commands/init.js';

const CATALOGUE = {
  workspace: 'Workspace',
  remotes: { ssh: 'git@github.com:{owner}/{repo}.git' },
  repos: [
    { name: 'eklavya', owner: 'ProjectAJ14', default: true },
    { name: 'json-viewer', owner: 'nonstopio', default: true },
  ],
};

describe('init leaves the tree empty until something is cloned', () => {
  test('no group folder is created for a repo the machine never picked', async () => {
    const target = path.join(mkdtempSync(path.join(os.tmpdir(), 'talea-init-')), 'Workspace');

    // The catalogue goes in FIRST, and it is a workspace-local one so the
    // nearest-wins lookup never reaches ~/.talea. Without that, `init` on a
    // machine with no catalogue runs `discover` — which on a machine with no
    // GitHub token exits non-zero and takes the test runner with it. That is
    // correct behaviour for `discover` and a bug in a test: it made this case
    // pass on the author's laptop, where ~/.talea/talea.repos.json happens to
    // exist, and fail on every CI runner and every new contributor's machine.
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'talea.repos.json'), JSON.stringify(CATALOGUE));

    const log = console.log;
    console.log = () => {};
    try {
      // --no-clone stops before `sync`, which is the only thing entitled to
      // create a folder, and only for a repo it is about to clone into it.
      await init({ clone: false }, [target]);
    } finally {
      console.log = log;
    }

    assert.deepEqual(readdirSync(target).sort(), ['.talea.json', 'talea.repos.json']);
  });
});
