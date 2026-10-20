# Contributing to antechamber

## Setup

```bash
git clone https://github.com/eliottness/antechamber.git
cd antechamber
npm ci
npm run build
```

Node.js 22+ is required. You don't need `pi` or `omo` installed to build, run
`npm test`, or typecheck; you do need one of them to run the smoke scripts
(see below) or to exercise antechamber end to end through OpenChamber.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | compile `src/` to `dist/` with `tsc`, then bundle the OmO Graph (`extensions/omo-dag/`) and OmO Work (`extensions/omo-work/`) extensions with esbuild |
| `npm run dev` | run the CLI from source with `tsx`, no build step |
| `npm run typecheck` | `tsc -p tsconfig.check.json && tsc -p extensions/omo-dag/tsconfig.json && tsc -p extensions/omo-work/tsconfig.json` |
| `npm test` | run the unit/integration test suite (`test/*.test.ts` and `extensions/*/test/*.test.ts`) |
| `npm run smoke` | end-to-end smoke test against a real `pi` process |
| `npm run omo-smoke` | end-to-end smoke test against a real `omo` process |
| `npm run probe` | dump raw pi/OmO RPC events for protocol inspection |
| `npm run model-smoke` | model-selection consistency check |
| `npm run v2-smoke` | OpenCode v2 API surface check |
| `npm run replay` | renders copies of your real sessions in an isolated OpenChamber (needs `npm run build`, Chrome and `openchamber`) |

Run `npm run typecheck && npm test && npm run build` before opening a pull
request.

## Test rules

- Tests must be hermetic: no dependency on your machine's filesystem layout,
  installed global tools, or network access, beyond what the test itself
  sets up and tears down.
- No fixed sleeps or polling loops as a substitute for waiting on a real
  event. If a test needs to wait for a process or an async state change,
  subscribe to the actual signal (an RPC event, a process exit, a file
  watcher) with a bounded timeout, not `setTimeout` and a guess.
- Tests that spawn processes or sessions must clean them up even on failure.
- The smoke scripts under `contrib/` are a different thing: they require a
  real `pi` or `omo` binary, make real model calls, and cost tokens. They are
  not run in CI and are not part of `npm test`. Don't rely on them to catch a
  regression that a unit test should catch.

## Commit style

This repository uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

fix(session): keep RPC and saved navigation consistent across tree ops
feat(tools): render provider server tool calls as native cards
docs(omo): reflect current deployment and rollback paths
chore: rename project to antechamber
```

Common types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`. Scope is
usually the module or area touched (`session`, `tools`, `shell`, `lifecycle`,
and so on) and can be omitted for repo-wide changes.

## Running the smoke tests

Smoke scripts drive a real agent process and need a backend on PATH or named
explicitly:

```bash
# against OmO (the default backend; omo-smoke needs the binary named explicitly)
npm run smoke
ANTECHAMBER_PI_BINARY="$(command -v omo)" npm run omo-smoke
ANTECHAMBER_PI_BINARY="$(command -v omo)" npm run omo-smoke -- --only prompt,abort

# against plain pi (opt-in, best effort)
ANTECHAMBER_PI_BINARY=pi npm run smoke
```

They make real model calls and will cost tokens on whatever provider your
agent is configured with. See `contrib/omo/smoke/README.md` for the full check
list, the `--only` selector, and how to add a new check module.

## Releases

Every commit merged to `main` is released automatically as a new patch version;
see [RELEASE.md](RELEASE.md). Do not bump versions or push tags yourself. Add user-visible changes to the
`[Unreleased]` section of `CHANGELOG.md` in the same PR.

## Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] New behavior has a unit test that fails without the change; no fixed sleeps were added
- [ ] A bug fix was reproduced on the reported case before the change and shown fixed after it, on the real surface (`npm run replay -- --session <id>` for transcript/UI bugs)
- [ ] Commit messages follow Conventional Commits
- [ ] Docs updated if you changed a config variable, route, or CLI flag
- [ ] No personal paths, hostnames, or credentials in anything you touched

## Scope

If you're changing something that affects the OpenCode API surface (routes,
event shapes), update `docs/api-surface.md` in the same PR. If you're adding
or renaming an environment variable, update `docs/configuration.md`.
