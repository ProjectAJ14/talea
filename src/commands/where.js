import { existsSync } from 'node:fs';

import { repoDir } from '../config.js';
import { c, fail, plain } from '../log.js';
import { requireWorkspace } from '../workspace.js';

export const help = `
${c.bold('talea where')} — print a repo's path

  ${c.dim('talea where eklavya')}             the absolute path, one line, nothing else
  ${c.dim('cd $(talea where eklavya)')}       what it is actually for
  ${c.dim('talea where')}                     the workspace root

The whole point of a fixed structure is never having to remember it. This is
the command that keeps that promise — the path goes to stdout on its own so it
composes with ${c.dim('cd')}, ${c.dim('code')}, ${c.dim('open')} and anything else that takes a directory.

Exits non-zero if the repo is not in the catalogue, so ${c.dim('cd $(talea where typo)')}
fails loudly instead of landing you in your home directory.
`;

export function run(opts, positionals = []) {
  const { root, manifest } = requireWorkspace();
  const name = positionals[0];

  if (!name) {
    // stdout, not through the logger: this is data, and it is going to be
    // consumed by $( ).
    process.stdout.write(root + '\n');
    return;
  }

  const wanted = name.toLowerCase();
  const matches = manifest.repos.filter(
    (r) => r.name.toLowerCase() === wanted || `${r.owner}/${r.name}`.toLowerCase() === wanted,
  );

  if (!matches.length) {
    // Everything diagnostic goes to stderr, so a failed lookup never puts a
    // stray word on stdout where a shell would try to cd into it.
    fail(`No repo called "${name}" in the catalogue.`);
    const near = manifest.repos
      .filter((r) => r.name.toLowerCase().includes(wanted))
      .slice(0, 5);
    if (near.length) {
      console.error(`\n  Did you mean: ${near.map((r) => c.bold(r.name)).join(', ')}`);
    }
    process.exit(1);
  }

  // Two owners can have a repo of the same name, and picking one silently would
  // be the wrong kind of convenient.
  if (matches.length > 1) {
    fail(`"${name}" is ambiguous — ${matches.length} repos have that name.`);
    for (const r of matches) console.error(`    ${c.bold(`${r.owner}/${r.name}`)}`);
    console.error(`\n  Name the owner too: ${c.dim(`talea where ${matches[0].owner}/${matches[0].name}`)}`);
    process.exit(1);
  }

  const dir = repoDir(manifest, root, matches[0]);
  process.stdout.write(dir + '\n');

  if (!existsSync(dir)) {
    console.error(c.dim(`\n  Not cloned yet — \`talea sync -r ${matches[0].name}\` will fetch it.`));
    process.exit(1);
  }
}
