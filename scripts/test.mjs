// `npm test` and `npm run coverage`: bare `node --test`, with one temp folder
// for the whole run, removed when the run ends.
//
// Tests build their fixtures under os.tmpdir() and not all of them clean up —
// a test that fails mid-way never reaches its `after`, and git children write
// there too. Left alone, repeated runs filled a developer's disk with 83 GB of
// `talea-*` folders. Pointing TMPDIR (POSIX) and TEMP/TMP (Windows) at one
// folder per run catches every one of them, including tests not written yet.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolved: macOS's tmpdir is a symlink and Windows hands out 8.3 short names,
// while git prints the long, real path — tests compare the two.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'talea-test-')));

// Ctrl-C reaches the test runner as well; wait for it to stop, then clean up.
process.on('SIGINT', () => {});

const res = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
});

rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
process.exitCode = res.status ?? 1;
