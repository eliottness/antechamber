# Releasing

Every commit that lands on `main` is released as a new **patch** version. Nobody
bumps versions or pushes tags by hand. The
[release workflow](.github/workflows/release.yml) does it all.

## What happens on a push to `main`

1. **Check.** It checks out the current tip of `main` and runs `npm ci` and
   `npm run check`. If a check fails, nothing is released.
2. **Bump.** `scripts/release.ts` computes the next patch version (for example
   `0.2.1` -> `0.2.2`) and writes it to:
   - `package.json` and `package-lock.json`,
   - `extensions/omo-dag/package.json` (the OmO Graph extension always carries
     the same version as the package),
   - `CHANGELOG.md`: the `[Unreleased]` notes move under
     `## [X.Y.Z] - YYYY-MM-DD`, and an empty `[Unreleased]` heading is kept.
     If `[Unreleased]` was empty, the notes are the commit subjects since the
     previous tag.
3. **Build.** `npm run build`.
4. **Commit and tag.** A `chore(release): vX.Y.Z` commit by
   `github-actions[bot]` and an annotated `vX.Y.Z` tag are pushed to `main` in
   one atomic push.
5. **Publish.** `npm publish --provenance` to npm.
6. **GitHub release.** It creates release `vX.Y.Z` with the CHANGELOG section as
   notes and attaches `antechamber-omo-graph.zip` (built by
   `npm run pack:extension`).

The release commit does not trigger another release. Pushes made with
`GITHUB_TOKEN` start no workflows, and the job also skips any commit whose
message starts with `chore(release):`.

Releases are queued (`concurrency: release`), never run in parallel and never
cancelled halfway through. Each run releases the tip of `main`, so several
merges that land close together can ship as a single version. If `main` moves
while a run is in progress, its atomic push is rejected before anything is
published, and the queued run for the newer push releases everything.

## What contributors do

- Write user-visible changes under `## [Unreleased]` in `CHANGELOG.md` in the
  same PR (Keep a Changelog sections: Added, Changed, Fixed...). The release
  moves them under the version heading.
- Do not edit the `version` fields or push `v*` tags. A manually pushed tag no
  longer triggers anything.
- Pull and rebase after a merge: `main` gains a release commit after every push.

Every release is a patch. While the project is `0.x`, a breaking change (renamed
settings, changed defaults) still belongs under **Changed** in the CHANGELOG.
For a deliberate minor or major bump, prepare that release by hand:

```bash
# move the [Unreleased] notes under "## [X.Y.0] - YYYY-MM-DD" in CHANGELOG.md, then:
npm version X.Y.0 --no-git-tag-version           # package.json + package-lock.json
npm pkg set version=X.Y.0 --prefix extensions/omo-dag
git commit -am "chore(release): vX.Y.0"
git tag -a vX.Y.0 -m vX.Y.0
git push --atomic origin HEAD:main vX.Y.0
```

The push itself releases nothing because the commit is a release commit. Start
the workflow from the Actions tab (**Run workflow**). It sees that `main` is
already tagged, skips the bump, and publishes `X.Y.0`. The next ordinary commit
then ships `X.Y.1`.

The version printed by `antechamber version` comes from `package.json`.
`antechamber --version` intentionally prints the OpenCode API version that
OpenChamber checks for, not the antechamber version.

The extension zip is installed by URL from
`https://github.com/eliottness/antechamber/releases/latest/download/antechamber-omo-graph.zip`,
so keep that asset name stable.

## One-time repository setup

- **Pushing to `main` from CI.** The workflow pushes the release commit and the
  tag to `main`. With no branch protection, the default `GITHUB_TOKEN` is
  enough (the workflow requests `contents: write`). If `main` is protected
  (required PRs or status checks), either let GitHub Actions bypass the rule
  (a ruleset bypass for the "GitHub Actions" app, or a deploy key), or store
  a fine-grained PAT with `contents: write` on this repository as the
  `RELEASE_TOKEN` secret. When `RELEASE_TOKEN` is set, the workflow checks out
  and pushes with it. CI then also runs on the release commit, and the release
  job skips it.
- **npm authentication.**
  - *Trusted publishing (preferred).* On npmjs.com, open the `antechamber`
    package settings and add a trusted publisher: GitHub Actions, repository
    `eliottness/antechamber`, workflow `release.yml`. No secret is needed.
  - *Token.* Add an npm automation token as the `NPM_TOKEN` repository secret
    (Settings -> Secrets and variables -> Actions).

Tags are created by `github-actions[bot]` and are annotated but not signed.

## If a release fails

Every step after the push can be re-run safely. When the tip of `main` is
already a `vX.Y.Z` release commit, the workflow skips the bump and only does
what is still missing: it publishes to npm only if that version is not on the
registry yet, and it uploads the zip to an existing GitHub release instead of
creating a new one.

- **Checks or build failed:** nothing was committed or published. Fix it on
  `main`; the fix's push releases.
- **Push rejected:** `main` moved (the queued run releases) or the token cannot
  push to a protected `main` (see setup above).
- **npm publish or GitHub release failed after the push:** fix the cause (for
  example npm auth), then re-run the failed job, or start the workflow from the
  Actions tab with **Run workflow**. Never re-publish an existing npm version.
  If `main` gained commits since that release push, a re-run bumps to the next
  patch instead: the failed version keeps its git tag but never reaches npm,
  which is harmless (delete the tag and any draft release if you want it gone).
