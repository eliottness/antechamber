# Releasing

Releases are cut from `main` by pushing a version tag. The
[release workflow](../.github/workflows/release.yml) then:

1. checks that the tag matches `package.json` and that `CHANGELOG.md` has a
   section for that version,
2. runs `npm run check` and `npm run build`,
3. publishes the package to npm with provenance,
4. creates a GitHub release whose notes are that CHANGELOG section.

## Cutting a release

```bash
# 1. move the [Unreleased] notes under a new heading in CHANGELOG.md:
#    ## [X.Y.Z] - YYYY-MM-DD
# 2. bump the version (also updates package-lock.json, no tag yet)
npm version X.Y.Z --no-git-tag-version
# 3. commit, tag, push
git commit -am "chore(release): vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Follow [Semantic Versioning](https://semver.org/). While the project is
`0.x`, breaking changes (renamed settings, changed defaults) bump the minor
version and are called out under **Changed** in the CHANGELOG.

The version printed by `antechamber version` comes from `package.json`; there
is no other copy to update. `antechamber --version` intentionally prints the
OpenCode API version OpenChamber checks for, not the antechamber version.

## npm authentication

The workflow publishes in one of two ways:

- **Trusted publishing (preferred).** On npmjs.com, open the `antechamber`
  package settings and add a trusted publisher: GitHub Actions, repository
  `eliottness/antechamber`, workflow `release.yml`. No secret is needed; the
  workflow's OIDC token authenticates the publish.
- **Token.** Add an npm automation token as the `NPM_TOKEN` repository secret
  (Settings -> Secrets and variables -> Actions).

Trusted publishing can only be configured for a package that already exists,
so the very first release needs either the `NPM_TOKEN` secret or a one-time
manual publish by a maintainer:

```bash
npm login
npm publish --access public   # runs the build through `prepack`
```

After that, configure trusted publishing and remove the token.

## If a release fails

- **Tag/version mismatch or missing CHANGELOG section:** delete the tag
  (`git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`), fix, re-tag.
- **npm publish failed:** fix authentication and re-run the workflow from the
  Actions tab; nothing was published.
- **Published but the GitHub release step failed:** create it manually with
  `gh release create vX.Y.Z --notes-file <section>`. Never re-publish the same
  npm version; bump to the next patch instead.
