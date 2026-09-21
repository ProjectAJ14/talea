import { findWorkspace, loadManifest, saveManifest } from '../config.js';
import { listRepos, toEntry, token, whoami } from '../github.js';
import { c, context, fail, heading, info, ok, plain, skip, table, warn } from '../log.js';

export const help = `
${c.bold('talea discover')} — build the catalogue from your GitHub account

  ${c.dim('talea discover')}                    every repo you can see
  ${c.dim('talea discover --since 6mo')}        anything older is kept, but marked archived
  ${c.dim('talea discover --user someone')}     public repos of an account, no token needed
  ${c.dim('talea discover --apply')}            write the catalogue (default is a dry run)

Lists your own repos and every org you belong to, then writes each one's owner,
default branch and last push into the catalogue. This is what makes the
catalogue current instead of hand-maintained.

Options
      --since <window>   6mo | 90d | 2y | an ISO date. Older repos are kept in
                         the catalogue and marked archived, never dropped.
      --user <login>     read a specific account's public repos instead
      --apply            write the file (default prints what would change)

${c.bold('What is preserved')} — a repo already in the catalogue keeps its ${c.dim('default')},
${c.dim('group')} and ${c.dim('dir')}. Discovery refreshes the facts GitHub owns; the choices are
yours and are never overwritten.

Auth comes from ${c.dim('gh auth token')}, then ${c.dim('GITHUB_TOKEN')}, then nothing — and nothing is
a working state, it just means public repos only.

The first run writes ${c.dim('~/.talea/talea.repos.json')}. Share it with
${c.dim('talea manifest push')}.
`;

/**
 * Turn `6mo` / `90d` / `2y` / `2026-01-01` into an ISO timestamp.
 *
 * Returns null for "no window", which means nothing gets marked archived by
 * age. A window that cannot be parsed is an error rather than a silent null:
 * `--since 6m` quietly meaning "everything is active" is the kind of typo that
 * makes a command look like it worked.
 */
export function parseSince(spec, now = new Date()) {
  if (!spec) return null;
  const m = /^(\d+)\s*(d|w|mo|m|y)$/i.exec(String(spec).trim());
  if (m) {
    const n = Number(m[1]);
    const d = new Date(now);
    const unit = m[2].toLowerCase();
    if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - n * 7);
    else if (unit === 'y') d.setFullYear(d.getFullYear() - n);
    else d.setMonth(d.getMonth() - n); // 'mo' and bare 'm' both mean months
    return d.toISOString();
  }
  const date = new Date(spec);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot read --since "${spec}". Try 6mo, 90d, 2y, or 2026-01-01.`);
  }
  return date.toISOString();
}

/**
 * Merge what GitHub says into what the catalogue already holds.
 *
 * The split that matters: GitHub owns the *facts* (owner, default branch, fork,
 * last push) and refreshing them is the whole point. You own the *choices*
 * (`default`, `group`, `dir`, `url`), and a discovery run that reset those
 * would undo your curation every time the tool got run.
 */
export function merge(existing, found) {
  const byKey = new Map(existing.map((r) => [`${r.owner}/${r.name}`.toLowerCase(), r]));
  const seen = new Set();
  const repos = [];
  const added = [];

  for (const entry of found) {
    const key = `${entry.owner}/${entry.name}`.toLowerCase();
    seen.add(key);
    const prior = byKey.get(key);
    if (!prior) added.push(entry);
    repos.push({
      ...entry,
      // Choices win over discovery, every time.
      ...(prior?.default !== undefined ? { default: prior.default } : {}),
      ...(prior?.group !== undefined ? { group: prior.group } : {}),
      ...(prior?.dir !== undefined ? { dir: prior.dir } : {}),
      ...(prior?.url !== undefined ? { url: prior.url } : {}),
    });
  }

  // A repo the API did not return is not a repo that stopped existing — a token
  // with narrower scopes, a revoked org grant or a rate limit all look the same
  // from here. Keep it, mark it, and let the human decide.
  const vanished = existing.filter((r) => !seen.has(`${r.owner}/${r.name}`.toLowerCase()));
  for (const r of vanished) repos.push({ ...r, missing: true });

  return { repos, added, vanished };
}

export async function run(opts) {
  const { token: tok, from } = token();
  const since = parseSince(opts.since);

  heading('Discovering repositories');
  context([
    ['auth', tok ? c.green(from) : c.yellow('none — public repos only')],
    opts.user ? ['user', c.bold(opts.user)] : null,
    since ? ['active since', c.cyan(since.slice(0, 10))] : null,
    ['mode', opts.apply ? c.bold('apply') : c.dim('dry run')],
  ]);

  let login = opts.user ?? null;
  if (tok && !login) {
    try {
      login = await whoami(tok);
      info(`signed in as ${c.bold(login)}`);
    } catch (err) {
      warn(`Could not read the account behind that token — ${err.message}`);
    }
  }

  let api;
  try {
    api = await listRepos({ token: opts.user ? null : tok, user: login });
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }

  const found = api.map((r) => toEntry(r, { activeSince: since }));
  const root = findWorkspace();
  const manifest = loadManifest(root);
  const { repos, added, vanished } = merge(manifest.repos, found);

  const active = repos.filter((r) => !r.archived && !r.missing);
  const owners = new Set(repos.map((r) => r.owner));

  plain('');
  table(
    [
      ['found', `${found.length}`],
      ['active', `${active.length}`],
      ['archived / quiet', `${repos.length - active.length - vanished.length}`],
      ['new to the catalogue', `${added.length}`],
      ['owners', [...owners].join(', ')],
    ],
    ['', ''],
  );

  if (added.length) {
    heading('New');
    for (const r of added.slice(0, 40)) {
      plain(`  ${c.green('+')} ${c.bold(`${r.owner}/${r.name}`)} ${c.dim(r.pushedAt?.slice(0, 10) ?? '')}`);
    }
    if (added.length > 40) plain(c.dim(`  … and ${added.length - 40} more`));
  }

  if (vanished.length) {
    heading('In the catalogue, not returned by GitHub');
    for (const r of vanished) {
      plain(`  ${c.yellow('?')} ${c.bold(`${r.owner}/${r.name}`)}`);
    }
    plain(
      c.dim(
        '  Kept and marked. Renamed, made private, or your token cannot see it —\n' +
          '  none of which is a reason for this tool to forget it.',
      ),
    );
  }

  if (!opts.apply) {
    plain(`\n${c.dim('Re-run with --apply to write the catalogue.')}`);
    return;
  }

  // First discovery decides what "default" means: everything still active. It
  // is only a starting point — the catalogue is yours to edit, and `talea add`
  // and the picker both write to it.
  const seeding = !manifest.repos.length;
  if (seeding) {
    for (const r of repos) r.default = !r.archived && !r.fork;
  }

  const groups = { ...manifest.groups };
  for (const owner of owners) groups[owner] ??= { dir: owner, title: `${owner} on GitHub` };

  const file = saveManifest({ ...manifest, groups, repos });
  plain('');
  ok(`catalogue written ${c.dim(`→ ${file}`)}`);
  if (seeding) {
    const on = repos.filter((r) => r.default).length;
    skip(`${on} repos marked default — edit the file, or run \`talea sync --pick\` to choose`);
  }
}
