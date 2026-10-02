import { updateUserState } from '../config.js';
import { c, fail, heading, icon, info, ok, plain, skip, warn } from '../log.js';
import { installKind, installLatest, isNewer, lookupLatestRelease, pkgJson, takeUpgradeLock } from '../update.js';
import { task } from '../live.js';

export const help = `
${c.bold('talea upgrade')} — update the CLI itself

  ${c.dim('talea upgrade')}                    reinstall from npm at the latest version, now
  ${c.dim('talea update')}                     the same thing
  ${c.dim('talea upgrade --check')}            only report whether one is available
  ${c.dim('talea upgrade --on')}               turn automatic updates on (the default)
  ${c.dim('talea upgrade --off')}              turn automatic updates off

Automatic updates are on by default. At most once a day, after a command
finishes, talea checks npm; if a newer version exists it installs it in the
background, with the output in ${c.dim('~/.talea/update.log')}. The command you ran
finishes on the old version, and the next one says it was updated — the
version never changes mid-run, and never without a line saying so.

Two upgrades never install at once — a second one, background or typed, stops
while the first holds ${c.dim('~/.talea/upgrade.lock')} — and ${c.dim('~/.talea/state.json')} is written
whole, so a run that overlaps an update never loses your workspaces or settings.

A copy that is a git checkout is never updated, only told. Set
${c.dim('TALEA_NO_UPDATE_CHECK=1')} to turn checking off for a single shell.

Options
      --check   report only, change nothing
      --on      enable automatic updates
      --off     disable automatic updates and the check
`;

export async function run(opts) {
  if (opts.on || opts.off) {
    updateUserState((now) => ({ ...now, updateCheck: Boolean(opts.on) }));
    ok(`automatic updates ${opts.on ? c.green('on') : c.dim('off')}`);
    return;
  }

  const { name, version } = pkgJson();
  heading('talea upgrade');

  const latest = await task('Asking the npm registry', () => lookupLatestRelease(name));
  if (!latest.version) {
    const why = {
      timeout: 'the registry did not answer in time',
      unpublished: `${name} is not on the registry yet`,
      unreachable: 'could not reach the registry',
      untagged: 'the registry has no version for it',
    };
    warn(`No version to compare against — ${why[latest.reason]}.`);
    plain(c.dim(`  Installed: ${version}`));
    return;
  }

  // Cached for the passive notice, whatever happens next. A `--check` that
  // silently refreshed nothing would make the cached version go stale for a day.
  updateUserState((now) => ({ ...now, lastCheck: Date.now(), latestSeen: latest.version }));

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

  // npm's own output is inherited and says it is working; this line says what
  // it is about to do, so the pause before npm's first byte is not silence.
  // One install at a time: two npm installs into one global prefix race each
  // other, and the background run and a hand-typed upgrade can easily meet.
  const release = takeUpgradeLock();
  if (!release) {
    skip('another talea upgrade is installing right now — this one stops; run it again in a minute');
    return;
  }
  info(c.dim(`npm install -g ${name}@latest`));
  plain('');
  let code;
  try {
    code = await installLatest(name);
  } finally {
    release();
  }
  plain('');
  if (code !== 0) {
    // A background run has nobody watching it. The exit code goes where the
    // next command will find it and say so.
    if (process.env.TALEA_BACKGROUND_UPGRADE === '1') {
      updateUserState((now) => (now.autoUpdate ? { ...now, autoUpdate: { ...now.autoUpdate, failed: code } } : now));
    }
    fail(`npm install exited ${code}.`);
    plain(c.dim(`  Try it yourself: npm install -g ${name}@latest`));
    process.exitCode = code;
    return;
  }
  ok(`upgraded to ${c.green(latest.version)}`);
}
