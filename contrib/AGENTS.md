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
├── replay/transcripts.ts   # real sessions -> isolated OpenChamber + headless Chrome; no agent, no tokens
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
| Does a session's transcript render on phone/desktop? | `npm run build && npm run replay -- --session <id>`; whole store without `--session` |

## CONVENTIONS
- Run with the binary named explicitly: `ANTECHAMBER_PI_BINARY="$(command -v omo)" npm run omo-smoke -- --only prompt,abort`.
- `--only` pulls in the transitive `dependsOn` closure and marks the rest SKIP. The first FAIL or timeout skips everything after it.
- Every check receives an `AbortSignal` and must pass it to every HTTP call and wait.
- omo-smoke runs in a private HOME and state dir under `/tmp/antechamber-qa/`. It copies config and credentials and deletes them on exit.
- Acceptance means two consecutive unfiltered runs, with every check PASS and zero SKIP.
- Deltas arrive as `message.part.updated` with `properties.delta`, not `message.part.delta`.

## REPLAY (`replay/transcripts.ts`)
- It copies `sessions.json`, the state dir and each selected session's OmO JSONL into a temp sandbox, and starts OpenChamber with a private HOME and `OPENCODE_BINARY` set to a launcher for the build under test (`--antechamber`, default `dist/cli.js`).
  The agent binary is `/bin/false`, so nothing is revived and the real store is never written.
- PASS means a `[data-turn-id]` section rendered (OpenChamber 1.24 renders one per user-anchored turn). SKIP means the history has no user message. FAIL writes a screenshot and exits 1.
- Roots only by default; `--children` adds subagent sessions and `--archived` adds archived ones. Point `--antechamber` at an installed `dist/cli.js` to get the "before" run.
- The data is personal. Reports and screenshots stay on the machine; never commit them or paste transcript text into a PR.
- It drives OpenChamber 1.24 (the installed `openchamber`). Use `--openchamber` to target another build.

## ANTI-PATTERNS
- Asserting only that a request was accepted. Assert the feature's concrete effect.
- Waiting before subscribing. Waits match future events only, so stale idle or delta frames cannot satisfy a new turn.
- Letting harness cleanup mask a failed shutdown assertion. The shutdown assert runs before cleanup.
- Claiming processes by command-line match. Ownership requires the cwd to be inside the run root and an exact private HOME in `/proc/<pid>/environ`.

## GOTCHAS
- `docs/development.md` and CONTRIBUTING point at `contrib/omo/omo-smoke.ts` and `contrib/omo/smoke/`.
- `omo/smoke/checks/90-routes.ts` reads the static route table in `docs/api-surface.md`; parameterized routes are probed through their lifecycle checks where needed.
- The lifecycle checks need Linux `/proc` and GNU `tail --pid`.
