# contrib - LIVE-AGENT TOOLING

## OVERVIEW
These scripts drive a real `pi`/`omo` process, make real model calls, and cost tokens. They are excluded from CI and from the npm package; CI asserts `npm pack` contains no `contrib/`.
This file exists because `contrib` scores about 8 and is a distinct domain: live smoke tests and maintainer tooling, not product code.

## STRUCTURE
```
contrib/
├── smoke.ts, v2-smoke.ts, model-consistency.ts, probe.ts, probe-archive.ts  # import ../src
├── omo/
│   ├── omo-smoke.ts        # runner; loads smoke/checks/*.ts in sorted filename order
│   ├── omo-fixtures.ts     # session JSONL -> test/fixtures/omo-tools/*.json (redacted)
│   ├── capture-omo-rpc.ts  # real RPC run -> test/fixtures/omo-rpc/run1.jsonl (redacted)
│   └── smoke/{core,context}.ts, checks/NN-*.ts, README.md
└── examples/opencode-dispatch  # POSIX sh: SSH-remote OpenChamber backend dispatch by port
```

## WHERE TO LOOK
| Task | Location |
|------|----------|
| Add an OmO smoke check | new `omo/smoke/checks/NN-name.ts` exporting `register(check, context)`; no runner edit |
| Check contract (deps, timeouts, `--only`) | `omo/smoke/core.ts`, `omo/smoke/README.md` |
| Shared HTTP/SSE helpers | `omo/smoke/context.ts` (`api`, `prompt`, `messages`, `waitForEvent`, `idle`, `delta`) |
| Raw RPC event dump | `probe.ts` (`npm run probe`) -> `pi-probe-events.jsonl` (gitignored) |
| OmO deployment/ops scripts | belong under `omo/`, not repo root or `docs/` |

## CONVENTIONS
- Run with the binary named explicitly: `ANTECHAMBER_PI_BINARY="$(command -v omo)" npm run omo-smoke -- --only prompt,abort`.
- `--only` pulls in the transitive `dependsOn` closure and marks the rest SKIP. The first FAIL or timeout skips everything after it.
- Every check receives an `AbortSignal` and must pass it to every HTTP call and wait.
- omo-smoke runs in a private HOME and state dir under `/tmp/antechamber-qa/`. It copies config and credentials and deletes them on exit.
- Acceptance means two consecutive unfiltered runs, with every check PASS and zero SKIP.
- Deltas arrive as `message.part.updated` with `properties.delta`, not `message.part.delta`.

## ANTI-PATTERNS
- Asserting only that a request was accepted. Assert the feature's concrete effect.
- Waiting before subscribing. Waits match future events only, so stale idle or delta frames cannot satisfy a new turn.
- Letting harness cleanup mask a failed shutdown assertion. The shutdown assert runs before cleanup.
- Claiming processes by command-line match. Ownership requires the cwd to be inside the run root and an exact private HOME in `/proc/<pid>/environ`.

## GOTCHAS
- `docs/development.md` and CONTRIBUTING point at `contrib/omo/omo-smoke.ts` and `contrib/omo/smoke/`.
- `omo/smoke/checks/90-routes.ts` reads the static route table in `docs/api-surface.md`; parameterized routes are probed through their lifecycle checks where needed.
- The lifecycle checks need Linux `/proc` and GNU `tail --pid`.
