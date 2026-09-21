import { spawn } from 'node:child_process';
import path from 'node:path';

import { findWorkspace, loadManifest, loadState } from '../config.js';
import { git, gitVersion } from '../git.js';
import { token, whoami } from '../github.js';
import { c, heading, icon, plain, verdict } from '../log.js';
import { padEndVisible } from '../theme.js';
import { hasChosen, machineRepos } from '../workspace.js';

export const help = `
${c.bold('talea doctor')} — check that this machine can actually do the work

  ${c.dim('talea doctor')}

Verifies Node, git, SSH access to GitHub, the API token, and the workspace it
found. Run this first when a clone fails.
`;

const PASS = icon.ok;
const FAIL = icon.fail;
const WARN = icon.warn;

/**
 * `ssh -T git@github.com` exits non-zero even when it works — GitHub
 * authenticates you and then refuses the shell. So the signal is the text, not
 * the exit code.
 */
function sshProbe(host) {
  return new Promise((resolve) => {
    const child = spawn(
      'ssh',
      ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', host],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, message: e.message }));
    child.on('close', () => {
      const text = out.trim();
      const authed = /successfully authenticated|shell access|You've successfully|Welcome/i.test(text);
      const denied = /permission denied|publickey/i.test(text);
      resolve({ ok: authed && !denied, message: text.split('\n')[0] ?? 'no response' });
    });
    setTimeout(() => child.kill(), 15000);
  });
}

export async function run() {
  heading('talea doctor');

  const checks = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push([
    nodeMajor >= 20 ? PASS : FAIL,
    'Node.js',
    `v${process.versions.node}${nodeMajor >= 20 ? '' : c.red('  (need >= 20)')}`,
  ]);

  const gv = await gitVersion();
  checks.push([gv ? PASS : FAIL, 'git', gv ?? c.red('not found on PATH')]);

  const user = await git(['config', '--get', 'user.email']);
  checks.push([
    user.stdout ? PASS : WARN,
    'git user.email',
    user.stdout || c.yellow('not set — commits will be attributed oddly'),
  ]);

  const gh = await sshProbe('git@github.com');
  checks.push([
    gh.ok ? PASS : FAIL,
    `SSH ${icon.arrow} GitHub`,
    gh.ok ? c.dim(gh.message) : c.red(gh.message),
  ]);

  // The token is for reading the catalogue, not for cloning — so no token is a
  // warning, never a failure. SSH is what clones private repos.
  const { token: tok, from } = token();
  let login = null;
  if (tok) {
    try {
      login = await whoami(tok);
    } catch (err) {
      login = c.red(err.message);
    }
  }
  checks.push([
    tok ? PASS : WARN,
    'GitHub API token',
    tok
      ? `${c.dim(from)}${login ? ` ${icon.arrow} ${c.bold(login)}` : ''}`
      : c.yellow('none — `talea discover` will see public repos only'),
  ]);

  const root = findWorkspace();
  const manifest = loadManifest(root);
  checks.push([root ? PASS : WARN, 'workspace', root ?? c.yellow('none found — run `talea init`')]);
  checks.push([
    manifest.repos.length ? PASS : WARN,
    'catalogue',
    manifest.repos.length
      ? `${manifest.repos.length} repos  ${c.dim(manifest.__source)}`
      : c.yellow('empty — run `talea discover`'),
  ]);

  if (root) {
    const state = loadState(root);
    checks.push([
      PASS,
      'this machine keeps',
      hasChosen(state)
        ? `${machineRepos(manifest, state).length} repos`
        : c.dim(`${machineRepos(manifest, state).length} by default — not chosen yet`),
    ]);
  }

  plain('');
  for (const [mark, label, detail] of checks) {
    plain(`  ${mark}  ${padEndVisible(label, 22)} ${detail}`);
  }

  const broken = checks.filter(([m]) => m === FAIL).length;
  verdict(
    { failed: broken },
    {
      clear: 'ALL CLEAR · this machine can do the work',
      trouble: `${broken} problem(s) to fix before cloning`,
    },
  );

  if (!gh.ok) {
    plain(
      c.dim(
        '\nGitHub SSH: add your public key at https://github.com/settings/keys,\n' +
          '  or run `talea sync --protocol https` to clone over HTTPS instead.',
      ),
    );
  }
}
