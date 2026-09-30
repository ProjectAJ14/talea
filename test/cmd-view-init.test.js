// `talea init` end to end, with `discover` and `sync` stood in for: the first
// needs GitHub and the second is covered by its own tests. What is pinned here
// is what init itself decides — where the root goes, what it refuses, what it
// writes and in which folder the fill runs.

import assert from 'node:assert/strict';
import test, { describe, after, afterEach } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters as strip } from 'node:util';

// Set before the imports: config.js reads the home directory when it loads.
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-home-')));
process.env.HOME = process.env.USERPROFILE = home;
process.env.TALEA_NO_UPDATE_CHECK = '1';
const init = await import('../src/commands/init.js');
const { USER_MANIFEST, readUserState } = await import('../src/config.js');

const real = { ...init.deps };
afterEach(() => Object.assign(init.deps, real));
after(() => rmSync(home, { recursive: true, force: true }));

async function capture(fn) {
  const out = [];
  const err = [];
  const w = [process.stdout.write, process.stderr.write, process.exit];
  // Strings are the command's output. Buffers are the test runner's own
  // reports, piped through the same stream, and must still reach it.
  const tap = (sink, write, stream) => (s, ...rest) =>
    typeof s === 'string' ? (sink.push(s), true) : write.call(stream, s, ...rest);
  process.stdout.write = tap(out, w[0], process.stdout);
  process.stderr.write = tap(err, w[1], process.stderr);
  process.exit = (code) => {
    throw Object.assign(new Error('exit'), { exitCode: code });
  };
  let code;
  try {
    await fn();
  } catch (e) {
    if (!('exitCode' in e)) throw e;
    code = e.exitCode;
  } finally {
    [process.stdout.write, process.stderr.write, process.exit] = w;
  }
  return { out: strip(out.join('')), err: strip(err.join('')), code };
}

const CATALOGUE = { repos: [{ name: 'alpha', owner: 'me' }, { name: 'beta', owner: 'you' }] };
const fresh = () => path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'talea-init-'))), 'Workspace');
const withCatalogue = (target) => {
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'talea.repos.json'), JSON.stringify(CATALOGUE));
  return target;
};
const state = (target) => JSON.parse(readFileSync(path.join(target, '.talea.json'), 'utf8'));

describe('workspaceTarget', () => {
  test('~/Workspace by default, the catalogue can rename it, a path wins', () => {
    assert.equal(init.workspaceTarget(undefined, undefined), path.join(home, 'Workspace'));
    assert.equal(init.workspaceTarget(undefined, { workspace: 'code' }), path.join(home, 'code'));
    assert.equal(init.workspaceTarget('~/src', {}), path.join(home, 'src'));
    assert.equal(init.workspaceTarget('rel', {}), path.resolve('rel'));
  });
});

describe('init', () => {
  test('the home directory is refused, with a better root suggested', async () => {
    const packaged = await capture(() => init.run({}, ['~']));
    assert.equal(packaged.code, 1);
    assert.match(packaged.err, /home directory cannot be the workspace root/);
    assert.ok(packaged.err.includes(`talea init ${path.join(home, 'Workspace')}`));
    assert.equal(existsSync(path.join(home, '.talea.json')), false);

    // A user catalogue with no `workspace` name still suggests ~/Workspace.
    mkdirSync(path.dirname(USER_MANIFEST), { recursive: true });
    writeFileSync(USER_MANIFEST, JSON.stringify({ repos: [] }));
    try {
      const user = await capture(() => init.run({}, [home]));
      assert.equal(user.code, 1);
      assert.ok(user.err.includes(`talea init ${path.join(home, 'Workspace')}`));
    } finally {
      rmSync(USER_MANIFEST);
    }
  });

  test('a fresh workspace records its protocol and the machine remembers it', async () => {
    const target = withCatalogue(fresh());
    const r = await capture(() => init.run({ clone: false, protocol: 'https' }, [target]));
    assert.match(r.out, /Creating a workspace at /);
    assert.match(r.out, /Workspace ready\. Run `talea sync`/);
    assert.equal(state(target).protocol, 'https');
    assert.ok(readUserState().workspaces.includes(target));

    // Run again: the state is left alone, nothing is re-written.
    const before = readFileSync(path.join(target, '.talea.json'), 'utf8');
    const again = await capture(() => init.run({ clone: false }, [target]));
    assert.match(again.out, /Workspace already at /);
    assert.match(again.out, /already here, leaving it alone/);
    assert.equal(readFileSync(path.join(target, '.talea.json'), 'utf8'), before);
  });

  test('a workspace inside another is warned about', async () => {
    const outer = withCatalogue(fresh());
    writeFileSync(path.join(outer, '.talea.json'), '{}');
    const inner = withCatalogue(path.join(outer, 'nested'));
    const r = await capture(() => init.run({ clone: false }, [inner]));
    assert.match(r.out, /already a talea workspace at /);
    assert.equal(state(inner).protocol, 'ssh');
  });

  test('an empty catalogue runs discover first, and stops if it finds nothing', async () => {
    const target = fresh();
    const calls = [];
    init.deps.discover = async (opts) => calls.push(opts);
    init.deps.sync = async () => assert.fail('sync must not run with nothing to clone');
    const r = await capture(() => init.run({ protocol: 'ssh' }, [target]));
    assert.deepEqual(calls, [{ protocol: 'ssh', apply: true }]);
    assert.match(r.out, /catalogue is empty — discovering/);
    assert.match(r.out, /Still nothing in the catalogue/);
  });

  test('then fills the workspace by running sync from inside it', async () => {
    const target = fresh();
    const back = process.cwd();
    let ranIn;
    init.deps.discover = async () => withCatalogue(target);
    init.deps.sync = async (opts) => {
      ranIn = process.cwd();
      assert.equal(opts.jobs, 2);
    };
    const r = await capture(() => init.run({ jobs: 2 }, [target]));
    assert.equal(ranIn, realpathSync(target));
    assert.equal(process.cwd(), back);
    assert.match(r.out, /repos\s+2/);
    assert.match(r.out, /groups\s+2/);
  });
});
