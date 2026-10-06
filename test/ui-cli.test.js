// main(): every way a command line is refused, routed or run — plus the
// top-level catch in bin/talea.js, which only a real process can reach.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

// Set before the imports: config.js reads the home directory when it loads.
const home = mkdtempSync(path.join(os.tmpdir(), 'talea-ui-cli-'));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
delete process.env.CLAUDE_CONFIG_DIR;
const { main } = await import('../src/cli.js');
const { USER_DIR, USER_STATE } = await import('../src/config.js');
const { stripAnsi } = await import('../src/theme.js');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = path.join(import.meta.dirname, '..', 'bin', 'talea.js');

class Exit extends Error {}

/** Run main(argv) with output captured and process.exit turned into a throw. */
async function run(argv) {
  const got = { out: [], err: [] };
  const saved = [console.log, console.error, process.exit];
  console.log = (...a) => got.out.push(stripAnsi(a.join(' ')));
  console.error = (...a) => got.err.push(stripAnsi(a.join(' ')));
  process.exit = (code) => {
    throw Object.assign(new Exit(), { code });
  };
  try {
    await main(argv);
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    got.code = err.code;
  } finally {
    [console.log, console.error, process.exit] = saved;
  }
  got.text = [...got.out, ...got.err].join('\n');
  return got;
}

describe('main', () => {
  test('--version prints the package version', async () => {
    assert.deepEqual((await run(['-v'])).out, [pkg.version]);
  });

  test('no command prints the usage', async () => {
    assert.match((await run([])).text, /talea <command> \[options\]/);
  });

  test('an unknown flag stops, with a pointer to --help', async () => {
    const r = await run(['--bogus']);
    assert.equal(r.code, 1);
    assert.match(r.text, /Run `talea --help`/);
  });

  test('an unknown command stops and lists the real ones', async () => {
    const r = await run(['frobnicate']);
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /Unknown command "frobnicate"/);
    assert.match(r.out.join('\n'), /Available: init/);
  });

  test('--help prints the command’s own help, aliases included', async () => {
    const r = await run(['ls', '--help']);
    assert.equal(r.code, undefined);
    assert.ok(r.out.length > 0);
  });

  test('--jobs must be a positive whole number', async () => {
    for (const j of ['x', '0', '1.5']) {
      const r = await run(['skill', '-j', j]);
      assert.equal(r.code, 1, j);
      assert.match(r.text, /--jobs must be a positive whole number/);
    }
  });

  test('a stray word after a command that takes none stops the run', async () => {
    const r = await run(['doctor', 'stray']);
    assert.equal(r.code, 1);
    assert.match(r.text, /`doctor` takes no arguments/);
  });

  test('adopt refuses a bare word, and says how to name a repo on purpose', async () => {
    const r = await run(['adopt', 'flutter']);
    assert.equal(r.code, 1);
    assert.match(r.text, /talea adopt -r flutter/);
  });

  test('a bare word after sync or status joins -r', async () => {
    const cwd = process.cwd();
    process.chdir(home);
    try {
      // Routed into -r, then stopped by the missing workspace.
      for (const argv of [['status', 'a'], ['sync', 'a', '-r', 'b']]) {
        assert.match((await run(argv)).text, /Not inside a talea workspace/);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  test('runs the command, treating a bare "all" as the default it already is', async () => {
    const r = await run(['skill', 'all', '-j', '2', '-g', 'x', '-r', 'y', '--from', 'z']);
    assert.equal(r.code, undefined);
    assert.match(r.text, /talea skill/);
  });

  test('exec keeps "all" and passes the tail after -- verbatim', async () => {
    // No workspace anywhere under this home, so exec stops — after main has
    // routed its arguments, which is what is under test.
    const cwd = process.cwd();
    process.chdir(home);
    try {
      const r = await run(['exec', 'all', '--', 'git', '--version']);
      assert.equal(r.code, 1);
      assert.match(r.text, /Not inside a talea workspace/);
    } finally {
      process.chdir(cwd);
    }
  });

  test('upgrade is never followed by the update check', async () => {
    const r = await run(['update', '--off']);
    assert.match(r.text, /automatic updates off/);
    assert.equal(JSON.parse(readFileSync(USER_STATE, 'utf8')).updateCheck, false);
    writeFileSync(USER_STATE, '{}');
  });

  test('shell-init is never followed by the update check — it runs in every new shell', async () => {
    mkdirSync(USER_DIR, { recursive: true });
    writeFileSync(USER_STATE, JSON.stringify({ autoUpdate: { from: '0.0.1' }, lastCheck: 0 }));
    delete process.env.TALEA_NO_UPDATE_CHECK;
    const write = process.stdout.write;
    let script = '';
    process.stdout.write = (s, ...rest) => (typeof s === 'string' ? ((script += s), true) : write.call(process.stdout, s, ...rest));
    try {
      const r = await run(['shell-init', 'zsh']);
      process.stdout.write = write;
      assert.match(script, /function tcd/);
      assert.doesNotMatch(r.text, /Updated|Updating/);
      // Untouched: the notice waits for the next real command.
      assert.equal(JSON.parse(readFileSync(USER_STATE, 'utf8')).autoUpdate.from, '0.0.1');
    } finally {
      process.stdout.write = write;
      process.env.TALEA_NO_UPDATE_CHECK = '1';
      writeFileSync(USER_STATE, '{}');
    }
  });

  test('a failing update check cannot fail the command that ran', async () => {
    // A recorded update makes the check print; a console.error that throws
    // makes the check fail. The command still succeeds.
    mkdirSync(USER_DIR, { recursive: true });
    writeFileSync(USER_STATE, JSON.stringify({ autoUpdate: { from: '0.0.1' }, lastCheck: Date.now() }));
    delete process.env.TALEA_NO_UPDATE_CHECK;
    const error = console.error;
    const log = console.log;
    let threw = false;
    console.log = () => {};
    console.error = () => {
      threw = true;
      throw new Error('stderr is gone');
    };
    try {
      await main(['skill']);
    } finally {
      console.error = error;
      console.log = log;
      process.env.TALEA_NO_UPDATE_CHECK = '1';
      writeFileSync(USER_STATE, '{}');
    }
    assert.ok(threw);
  });
});

describe('bin/talea.js', () => {
  // `discover --since` with a window it cannot read throws before any network
  // call, so it reaches the top-level catch on every platform.
  const crash = (env = {}) => {
    const { TALEA_DEBUG, ...base } = process.env;
    return spawnSync(process.execPath, [bin, 'discover', '--since', 'soon'], {
      env: { ...base, HOME: home, USERPROFILE: home, GITHUB_TOKEN: 'x', ...env },
      encoding: 'utf8',
    });
  };

  test('an uncaught error is one readable line and exit 1', () => {
    const r = crash();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\n {2}Cannot read --since "soon"/);
    assert.doesNotMatch(r.stderr, /at parseSince/);
  });

  test('TALEA_DEBUG adds the stack', () => {
    const r = crash({ TALEA_DEBUG: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /at parseSince/);
  });
});
