# test - HERMETIC SUITE

## OVERVIEW
Node's built-in runner (`node:test`) runs through `tsx --test --import ./test/setup.ts test/*.test.ts`. No real `pi`/`omo`, no network.
This file exists because `test` scores about 10 (31 files plus a fixture tree) and is a distinct domain: a fake-agent harness.

## STRUCTURE
```
test/
├── *.test.ts      # flat; named by behavior, not mirroring src/
├── setup.ts       # deletes ANTECHAMBER_*, OCPI_*, OPENCODE_SERVER_*, *_CODING_AGENT_DIR
├── bug-harness.ts # temp state dir + SessionManager + V2EventTranslator + fake agent
└── fixtures/
    ├── *.mjs        # fake agent processes speaking JSONL RPC
    ├── omo-tools/   # per-tool recorded payloads (generated)
    ├── omo-rpc/     # run1.jsonl: recorded real RPC session (generated)
    └── *.py, detached-fixture*.ts  # pidfd / detached-process probes
```

## WHERE TO LOOK
| Need | Use |
|------|-----|
| Fake agent for a turn | `bugHarness(t)`; sets `ANTECHAMBER_PI_BINARY` to `fixtures/turn-omo.mjs` |
| Fake OmO HTTP/endpoint behavior | `fixtures/fake-omo-endpoints.mjs`, `fake-omo.mjs` |
| Approval / question RPC flows | `fixtures/approval-rpc.mjs`, `question-rpc.mjs` |
| Diff route | `fixtures/diff-omo.mjs` |
| Detached task-host teardown | `fixtures/fake-omo-host.mjs`, `detached-fixture*.ts`, `pidfd-host-probe.py` |
| Tool-card mapping | `fixtures/omo-tools/<tool>.json` via `tool-map.test.ts` |
| Biggest suites | `fork-revert.test.ts` (1407), `subagents.test.ts`, `endpoints.test.ts` |

## CONVENTIONS
- The fake agent is selected by pointing `ANTECHAMBER_PI_BINARY` at a fixture script. Save and restore the env in the test.
- State goes in `mkdtempSync(tmpdir())` and is removed in teardown, including on failure.
- Waits subscribe to the event (an SSE envelope, RPC event or process exit) before triggering the action, with a bounded timeout.
- Generated fixtures:
  - Regenerate `omo-tools/*.json` with `contrib/omo/omo-fixtures.ts`. It redacts secrets, clips strings to 400 chars, and keeps at most 3 samples per tool.
  - Regenerate `omo-rpc/run1.jsonl` with `contrib/omo/capture-omo-rpc.ts`.
  - Do not hand-edit either.
- `fixtures.test.ts` enforces the tool-fixture wrapper keys: `arguments`, `content`, `details`, `isError`.
- Typecheck covers `test/` (`tsconfig.check.json`); the build does not.

## FIXTURES MUST MATCH OMO
- A fixture encodes what we believe OmO does. A regression that hinges on real OmO behavior (cancellation, timing, ordering, error text) needs that behavior added to the fixture first, citing the OmO bundle file or log line it comes from.
- Size test data to the bug. Paging, expansion and history bugs need histories longer than the client's limits (OpenChamber 1.24: 30/50 first page, up to 120/150 expansion), not three messages.
- A regression test must fail with the fix disabled. Check this once before committing.

## ANTI-PATTERNS
- Fixed sleeps, `setTimeout` guesses, polling loops.
- Depending on the developer's HOME, an installed `omo`/`pi`, or exported env. `setup.ts` strips the env, so do not re-read it.
- Leaving spawned processes or session hosts alive after a failure.
- Covering a regression only with a `contrib/` smoke script. Smokes are not in CI.
- Committing fixtures with personal paths, hostnames or credentials.
