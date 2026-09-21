import { readUserState, writeUserState } from '../config.js';
import { c, fail, heading, icon, info, ok, plain, skip, warn } from '../log.js';
import { installKind, installLatest, isNewer, lookupLatestRelease, pkgJson } from '../update.js';

export const help = `
${c.bold('talea upgrade')} — update the CLI itself

  ${c.dim('talea upgrade')}                    reinstall from npm at the latest version
  ${c.dim('talea upgrade --check')}            only report whether one is available
  ${c.dim('talea upgrade --on')}               turn the daily update notice on
  ${c.dim('talea upgrade --off')}              turn the daily update notice off

By default the CLI checks for a new version at most once a day and prints a
one-line notice. It never updates itself silently — this tool moves checkouts
around, so it should not change behaviour underneath you mid-session.

Set ${c.dim('TALEA_NO_UPDATE_CHECK=1')} to disable the check for a single shell.

Options
      --check   report only, change nothing
      --on      enable the daily update notice
      --off     disable the daily update notice
`;

export async function run(opts) {
  const state = readUserState();

  if (opts.on || opts.off) {
    writeUserState({ ...state, updateCheck: Boolean(opts.on) });
    ok(`daily update notice ${opts.on ? c.green('on') : c.dim('off')}`);
    return;
  }

  const { name, version } = pkgJson();
  heading('talea upgrade');

  const latest = await lookupLatestRelease(name);
  if (!latest.version) {
    const why = {
      timeout: 'the registry did not answer in time',
      unpublished: `${name} is not on the registry yet`,
      unreachable: 'could not reach the registry',
      untagged: 'the registry has no version for it',
    };
    warn(`No version to compare against — ${why[latest.reason] ?? latest.reason}.`);
    plain(c.dim(`  Installed: ${version}`));
    return;
  }

  // Cached for the passive notice, whatever happens next. A `--check` that
  // silently refreshed nothing would make the daily notice go stale for a day.
  writeUserState({ ...state, lastCheck: Date.now(), latestSeen: latest.version });

  if (!isNewer(version, latest.version)) {
    ok(`already on the latest version ${c.dim(version)}`);
    return;
  }

  info(`${c.dim(version)} ${icon.arrow} ${c.green(latest.version)}`);

  if (opts.check) {
    plain(c.dim('\n  Run `talea upgrade` to install it.'));
    return;
  }

  // A git checkout is somebody's working copy of this project. Reinstalling
  // over it from the registry would replace their branch with a release, which
  // is not an upgrade, it is a data loss with a friendly name.
  if (installKind() === 'local') {
    skip('this copy is a git checkout, not an npm install — `git pull` instead');
    return;
  }

  plain('');
  const code = await installLatest(name);
  plain('');
  if (code !== 0) {
    fail(`npm install exited ${code}.`);
    plain(c.dim(`  Try it yourself: npm install -g ${name}@latest`));
    process.exitCode = code;
    return;
  }
  ok(`upgraded to ${c.green(latest.version)}`);
}
