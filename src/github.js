// Talking to GitHub.
//
// Two calls and no SDK: list the repos an account can see, and read/write a
// gist. `fetch` is in Node 20, which is the floor this package already sets, so
// the dependency count stays at zero.
//
// The token is whatever the machine already has. `gh auth token` first, because
// anyone who clones private repos over SSH almost certainly has the GitHub CLI
// logged in and that saves inventing a second credential to keep in sync.

import { spawnSync } from 'node:child_process';

const API = 'https://api.github.com';

/**
 * A token, and where it came from.
 *
 * No token is a usable state, not an error: the public repos of a named user
 * are enough to build a catalogue with, and saying "public only" is better than
 * demanding a credential for a read anyone can do.
 */
export function token() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, from: 'GITHUB_TOKEN' };
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, from: 'GH_TOKEN' };

  const res = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: false });
  const out = res.stdout?.trim();
  if (res.status === 0 && out) return { token: out, from: 'gh auth token' };

  return { token: null, from: null };
}

/**
 * Is the `gh` CLI on this machine?
 *
 * Worth knowing beyond the token: `gh` is a Go binary that trusts the system
 * certificate store, and Node's `fetch` trusts a CA list compiled into Node.
 * On any machine behind TLS interception — a corporate proxy, a VPN, a
 * security agent — `curl` and `gh` work and `fetch` fails with
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Preferring `gh` when it is there means
 * that machine works with no configuration at all.
 */
let ghPresent = null;
export function haveGh() {
  if (ghPresent === null) {
    ghPresent = spawnSync('gh', ['--version'], { encoding: 'utf8', shell: false }).status === 0;
  }
  return ghPresent;
}

function viaGh(pathname, { method = 'GET', body, paginate } = {}) {
  const args = ['api', pathname.replace(`${API}`, ''), '-X', method];
  // --slurp because without it `--paginate` prints each page as its own JSON
  // document, and stitching those back together by string surgery would break
  // on a repo whose description happens to contain "] [".
  if (paginate) args.push('--paginate', '--slurp');
  if (body) args.push('--input', '-');

  const res = spawnSync('gh', args, {
    encoding: 'utf8',
    shell: false,
    input: body ? JSON.stringify(body) : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.status !== 0) {
    const detail = (res.stderr ?? '').trim().split('\n')[0] ?? `gh api exited ${res.status}`;
    throw new Error(`GitHub — ${detail}`);
  }

  const json = JSON.parse(res.stdout);
  // --slurp wraps the pages in an outer array: [[page1…], [page2…]].
  return paginate ? json.flat() : json;
}

async function call(pathname, { token: tok, method = 'GET', body } = {}) {
  if (haveGh()) return { json: viaGh(pathname, { method, body }), link: null };

  const res = await fetch(pathname.startsWith('http') ? pathname : `${API}${pathname}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'talea',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      detail = JSON.parse(text).message ?? '';
    } catch {
      detail = text.slice(0, 200);
    }
    throw new Error(`GitHub ${res.status} on ${pathname}${detail ? ` — ${detail}` : ''}`);
  }

  return { json: await res.json(), link: res.headers.get('link') };
}

/**
 * Follow `Link: <…>; rel="next"` until it stops.
 *
 * The page count is not knowable in advance and `?page=N` past the end returns
 * an empty array rather than an error, so walking the header is both the
 * cheapest and the only correct way to know when to stop.
 */
async function paginate(pathname, opts) {
  if (haveGh()) return viaGh(pathname, { paginate: true });

  const all = [];
  let next = pathname;
  while (next) {
    const { json, link } = await call(next, opts);
    all.push(...json);
    next = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;
  }
  return all;
}

/**
 * Every repo this account can see: its own, and every org it belongs to.
 *
 * `affiliation` is what makes one call do the job of four — without it you
 * would list the user's repos, then list each org, and miss anything shared
 * with the account directly.
 */
export async function listRepos({ token: tok, user }) {
  if (tok) {
    return paginate('/user/repos?per_page=100&sort=pushed&affiliation=owner,organization_member,collaborator', {
      token: tok,
    });
  }
  if (!user) {
    throw new Error(
      'No GitHub token, and no --user to fall back on.\n' +
        '  Run `gh auth login`, or set GITHUB_TOKEN, or pass --user <login> for public repos.',
    );
  }
  return paginate(`/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`, {});
}

export async function whoami(tok) {
  const { json } = await call('/user', { token: tok });
  return json.login;
}

/** The catalogue entry for one API repo. Shape lives here, in one place. */
export function toEntry(api, { activeSince } = {}) {
  return {
    name: api.name,
    owner: api.owner?.login,
    defaultBranch: api.default_branch ?? null,
    private: Boolean(api.private),
    fork: Boolean(api.fork),
    // A fork with no upstream recorded is a fork whose parent was deleted, so
    // the field is honestly null rather than absent.
    upstream: api.parent?.full_name ?? null,
    pushedAt: api.pushed_at ?? null,
    // Archived means "not touched lately", not GitHub's archived flag — a repo
    // that has gone quiet is still listed, just off by default, so nothing is
    // ever lost by narrowing the window.
    archived: Boolean(api.archived) || (activeSince ? (api.pushed_at ?? '') < activeSince : false),
    description: api.description ?? '',
  };
}

// ── gists ────────────────────────────────────────────────────────
// The whole cross-machine story. A private gist is a file with a URL and an
// edit history, reachable with the token the machine already has — no server to
// run, no repo to create, nothing to remember to commit.

export async function createGist({ token: tok, filename, content, description }) {
  const { json } = await call('/gists', {
    token: tok,
    method: 'POST',
    body: { description, public: false, files: { [filename]: { content } } },
  });
  return json.id;
}

export async function updateGist({ token: tok, id, filename, content }) {
  const { json } = await call(`/gists/${id}`, {
    token: tok,
    method: 'PATCH',
    body: { files: { [filename]: { content } } },
  });
  return json.id;
}

export async function readGist({ token: tok, id, filename }) {
  const { json } = await call(`/gists/${id}`, { token: tok });
  const file = json.files?.[filename] ?? Object.values(json.files ?? {})[0];
  if (!file) throw new Error(`Gist ${id} has no files.`);

  // GitHub truncates a file inline past ~1MB and hands back a raw_url instead.
  // A catalogue can reach that size, and silently syncing half of one would be
  // worse than any error this can throw.
  if (file.truncated) {
    const res = await fetch(file.raw_url, { headers: { 'user-agent': 'talea' } });
    if (!res.ok) throw new Error(`Could not read the full gist (${res.status}).`);
    return res.text();
  }
  return file.content;
}
