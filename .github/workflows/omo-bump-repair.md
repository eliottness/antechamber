---
description: Repairs a failed weekly OmO bump by fixing antechamber on its omo-bump branch and opening a pull request.
on:
  workflow_run:
    workflows: ["OmO bump"]
    types: [completed]
    branches: [main]
    conclusion: failure
  workflow_dispatch:
    inputs:
      run_id:
        description: ID of the failed OmO bump run to repair
        required: true
  # One repair at a time: an open repair pull request or issue waits for a maintainer.
  skip-if-match: "is:open label:omo-bump"
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
engine: claude
timeout-minutes: 45
concurrency:
  job-discriminator: ${{ github.run_id }}
max-ai-credits: 800
max-daily-ai-credits: 1600
runtimes:
  node:
    version: "24"
  bun:
    version: "1.4"
checkout:
  fetch-depth: 0
  fetch: ["omo-bump/*"]
network:
  allowed: [defaults, node, github]
tools:
  github:
    toolsets: [default, actions]
  edit:
  bash: [":*"]
safe-outputs:
  create-pull-request:
    title-prefix: "[omo-bump] "
    labels: [omo-bump]
    draft: false
    base-branch: main
    if-no-changes: error
    # The bump commit itself changes the dependency manifests.
    protected-files:
      exclude: [package.json, package-lock.json]
  create-issue:
    title-prefix: "[omo-bump] "
    labels: [omo-bump]
    max: 1
---

# Repair a failed OmO bump

The weekly **OmO bump** workflow (`.github/workflows/omo-bump.yml`) moved antechamber's `omo-ai` pin to a new
release, and something failed. Run to repair: `${{ github.event.workflow_run.id || github.event.inputs.run_id }}` in
`${{ github.repository }}`. It has four jobs:

- `prepare` bumps the pin with `scripts/omo-bump.ts` and pushes one commit,
  `chore(deps): bump omo-ai from <from> to <to>`, to the branch `omo-bump/<to>`.
- `ci` waits for `ci.yml` on that commit: typecheck, lint, format, the hermetic tests and the build on Node 22/24,
  the Bun runtime jobs, and macOS.
- `e2e` runs `scripts/ci/openchamber-e2e.sh`: the latest `@openchamber/web` driving the bumped OmO through the
  extension launcher, up to one prompt answered by the local mock provider `scripts/ci/mock-openai.mjs`.
- `ship` fast-forwards `main` to the bump, which releases it.

Your job is to make the bump shippable, or to explain precisely why you could not.

## 1. Find what failed

Use the GitHub Actions tools to list the run's jobs, then read the failed jobs' logs, including the run of `ci.yml`
that the `ci` job links to. Note the versions from the `prepare` job and the exact failing assertion.

Stop and open an **issue** instead of a pull request (title: `omo-ai <to>: <what failed>`) when:

- `prepare` failed, so no `omo-bump/<to>` branch exists;
- the failure is infrastructure, not antechamber: a runner, network, registry or GitHub outage, a cancelled or timed
  out job with no assertion failing, or `ship` warning that main moved;
- after trying, you cannot find a fix you can verify.

The issue states the run link, the failing job and step, the log lines that show the failure, what you checked, and
your best diagnosis.

## 2. Reproduce on the bump branch

```bash
git checkout -B "omo-bump/<to>" "origin/omo-bump/<to>"
npm ci
npm run check && npm run build
```

For an `e2e` failure also run `ANTECHAMBER_RUNTIME_DIR=/tmp/gh-aw/agent/runtime scripts/ci/openchamber-e2e.sh` (it needs the
build and no API key). You cannot run the macOS job here;
reason from their logs and from the code, and say so in the pull request.

Read `AGENTS.md`, `src/AGENTS.md` and `test/AGENTS.md` before changing anything: they hold the project's rules. To
see what changed in OmO, diff the two published packages, for example
`npm pack omo-ai@<from> omo-ai@<to>` and `npm pack @code-yeongyu/senpi@<engine>`, and read the RPC code involved.

## 3. Fix antechamber

- Make the smallest change in antechamber that adapts it to the new OmO or OpenChamber behavior. Keep the new
  `omo-ai` pin: never pin it back, downgrade it, or change `scripts/omo-bump.ts` to dodge the failure.
- Never skip, delete or weaken a test or a check, and do not edit `.github/`.
- When OmO's behavior changed, teach the fake agent in `test/fixtures/` the new behavior (cite the OmO bundle file
  you read) and add a hermetic test that fails without your fix.
- Add a `### Fixed` entry under `## [Unreleased]` in `CHANGELOG.md`, next to the bump's `### Changed` note.
- Run `npm run build` and commit the regenerated extension bundles and `package.json` manifest with the source.
- Commit on top of the bump commit with Conventional Commit messages (`fix(session): ...`), then rerun
  `npm run check && npm run build` and the e2e script until they pass.

## 4. Open the pull request

Create one pull request from your branch to `main`. It contains the bump commit and your fixes, and merging it
releases both. Title: `omo-ai <to>: <what you fixed>`. The body has:

- the failed run link and the failing job, step and assertion;
- the root cause, with the OmO or OpenChamber change behind it and where you read it;
- what you changed;
- the commands you ran and their PASS/FAIL, and plainly what you could not run here (macOS).
