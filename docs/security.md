# Security posture — what is exposed, what was checked, what is left

This is the record issue #23 asked for: what talea and its site actually expose,
what the dependency advisories mean for them, which account settings were
checked and what they say. Re-check it when any of these change — a new image on
the site, a server-rendered page, a workflow, a dependency major version.

Last checked: 2026-10-02.

## The CLI

`@ajaykumarnpm/talea` has **no dependencies**, runtime or dev, so `npm audit` on
the root has nothing to report and there is no supply chain below it to patch.
What it runs is git, `gh`, `npm` (for `upgrade`) and `ps` — the machine's own.

Releases are published only by `.github/workflows/release.yml` with npm trusted
publishing over OIDC, and every published version carries a provenance
attestation (`npm view @ajaykumarnpm/talea dist.attestations` shows the SLSA
provenance for 0.10.0). There is no npm token in the repository or its secrets.

### Two talea processes at once

The automatic update runs `talea upgrade` detached, so it routinely overlaps the
command the developer typed. Both read and write `~/.talea/state.json` and both
may install into the one global npm prefix. What happens:

- **State is written atomically.** `writeUserState` writes a temp file beside
  `state.json` and renames it over, so a reader sees the old file or the new one,
  never half of one. Written in place, a half file read as `{}` and was written
  back, losing the workspace list, the gist id and `upgrade --off`.
- **No stale overwrite.** Every write that follows a network call goes through
  `updateUserState`, which re-reads the file and changes only its own fields, so
  a workspace recorded or a gist linked by another run meanwhile survives. The
  daily check decides whether to start an install on that fresh state too, so
  two runs that check at once start one install, not two.
- **One install at a time.** `talea upgrade` takes `~/.talea/upgrade.lock`
  (created with `O_EXCL`) around `npm install -g`. A second upgrade that finds
  it held stops before npm runs; a lock older than 30 minutes is a run that
  died, and is taken over. A home directory where no lock can be made does not
  stop the upgrade — it only loses the guard.
- **Not covered:** a talea command that *starts* while npm is replacing the
  package's files may fail to load. That is npm's install, not talea's; running
  the command again loads the new version. Nothing on disk is at risk.

All of this is pinned by the "runs that overlap" tests in
`test/net-update.test.js`.

## The site

`web/` is a static Astro + Starlight build (no adapter, no server output, no
middleware) deployed to Firebase Hosting by `.github/workflows/firebase.yml`.

### Who can put content into a build

The deploy runs only on a push to `main` or by hand (`workflow_dispatch`) —
never on `pull_request` — with `contents: read`. An outside contributor's pull
request runs the CI test matrix, which has no secrets; their content reaches a
deploy only after it is merged. So every byte the site build processes is
repository content that passed review: there is no remote image source, no CMS,
no user upload.

### Advisories, and whether they are reachable

`npm audit` in `web/`, with the fix below in place:

| Package | Advisory | Reachable here? |
|---|---|---|
| `sharp` (Astro's nested copy, 0.34.5) | libvips and libheif CVEs, GHSA-f88m-g3jw-g9cj and GHSA-rgj7-g3m4-5g8c — triggered by decoding an untrusted image | **Fixed.** `overrides` in `web/package.json` resolves every copy to the direct `sharp` (0.35.5); `npm ls sharp` shows one, deduped. The site has no raster images at all — two SVGs — so nothing reached the decoder anyway |
| `astro` < 7.x | XSS through `define:vars`, spread attribute names, `transition:*` values, View Transition properties, slot names | No. None of those features is used (`grep` over `web/src`), and all content is our own, rendered at build time into static HTML |
| `astro` < 7.x | server-island parameter replay; Host-header SSRF in prerendered error pages; base-path authorization bypass | No. They need server rendering, an adapter or middleware; the site has none |
| `astro` < 7.2.8 | RCE through AVIF image optimization | No. No images are optimised, and none could arrive from outside a reviewed commit |
| `esbuild` 0.27.3–0.28.0 | arbitrary file read from the dev server, on Windows | Only `npm run dev` on a Windows machine, on a developer's own box. Not part of any build or deploy |
| `@astrojs/starlight`, `@astrojs/mdx`, `astro-expressive-code` | flagged only because they depend on `astro` | Same as `astro` |

What clears the remaining entries is Astro 7 with Starlight 0.42 — a major
upgrade of both, with breaking changes to config and components. That is its own
piece of work, not a patch, and nothing above is reachable while it waits.

## Account settings

Read, never changed. Each line says what was seen and what is recommended; none
of the recommendations was applied, because changing them is the owner's call.

| Setting | Seen | Recommendation |
|---|---|---|
| Branch protection on `main` | **None**, and no rulesets. Anyone with write access can push to `main`, and a push to `main` is a release | Protect `main`: require a pull request and the CI checks, block force-pushes. Allow the release workflow's bump commit (it pushes with `GITHUB_TOKEN`) through a bypass |
| Actions defaults | `GITHUB_TOKEN` read-only by default, cannot approve PRs, fork PRs from first-time contributors need approval | Fine as it is. Optionally require actions pinned to a SHA |
| Secret scanning | On, with push protection | Fine |
| Dependabot security updates | **Off** | Turn on, for `web/` — the CLI has no dependencies to update |
| npm trusted publishing | Provenance present on published versions | Not verifiable from here (no npm login): confirm on npmjs.com that the trusted publisher is `ProjectAJ14/talea` + `release.yml`, and that token publishing is disallowed |
| Firebase browser API key | Restricted to 27 Firebase APIs; **no website restriction** | Add HTTP referrer restrictions: `talea-run.web.app`, `talea-run.firebaseapp.com`, and `localhost` for development. The key is public by design — it is in the page — so the restriction is the protection |
| Deploy service account (`github-action-…@talea-run`) | `firebasehosting.admin`, plus `cloudfunctions.developer`, `firebaseauth.admin`, `run.viewer`, `serviceusage.apiKeysViewer`, `serviceusage.serviceUsageConsumer` — the set `firebase init hosting:github` grants | Hosting deploys need `firebasehosting.admin` (and service usage). Drop `cloudfunctions.developer`, `firebaseauth.admin` and `run.viewer`; the site uses neither Functions nor Auth |

## Credentials in history

Every commit on every ref (96 at the time) was searched for GitHub, GitLab, npm,
AWS, Slack and OpenAI token shapes, private keys and service-account JSON, and
for files named `.env`, `.npmrc`, `*.pem`, `*.key`, `id_rsa` or similar. The one
hit is the Firebase web config's `apiKey` in `web/public/analytics.js` — public
by design, protected by the restrictions above, not a secret. Nothing else was
found.
