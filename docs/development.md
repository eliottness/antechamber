# Development

## Source layout

One line per module in `src/`:

| File | Responsibility |
|---|---|
| `cli.ts` | CLI entry point: arg parsing, `--version`, default vs. `serve` mode, startup/shutdown signal handling |
| `server.ts` | HTTP + SSE server; v1 OpenCode route handling and request dispatch |
| `v2.ts` | OpenCode v2 API translation layer (session/message shapes, v2 event translator) |
| `sessions.ts` | `SessionManager`: owns per-session state, history reconstruction, prompt/abort/fork/revert orchestration |
| `session-store.ts` | Session registry persistence (directory mapping, archived state, message-ID mapping) |
| `session-tree.ts` | Agent session-tree parsing (JSONL entries, fork/revert navigation) |
| `session-hosts.ts` | Linux pidfd-based teardown of detached OmO task-host processes antechamber owns |
| `session-commands.ts` | Slash commands, shell execution, compaction, share (unsupported) |
| `session-diff.ts` | `GET /session/:id/diff` unified-patch computation |
| `pi-rpc.ts` | Low-level pi/OmO RPC subprocess management: spawn, JSONL framing, request/response correlation |
| `approvals.ts` | Permission/question bridging through the agent's extension-UI protocol |
| `subagents.ts` | Subagent/task card tracking and child-transcript resolution |
| `todo-bridge.ts` | Translates the agent's todo tool calls into OpenCode todo state |
| `thinking-levels.ts` | Maps OmO thinking levels onto OpenChamber's model/variant picker |
| `tool-map.ts` | Maps pi/OmO tool-call events onto OpenCode v2 `ToolState` |
| `catalog.ts` | Model/agent catalog construction from the running agent |
| `agent-name.ts` | Agent name detection (env override, `oh-my-pi.jsonc`, package detection, fallback) |
| `agent-dir.ts` | Resolves the pi/OmO agent directory (`PI_CODING_AGENT_DIR` / `OMO_CODING_AGENT_DIR`) |
| `lifecycle.ts` | Idle session reaping and the live-process cap |
| `misc-routes.ts` | Filesystem/search routes and unsupported-capability stubs (MCP, OAuth, skills, LSP, formatter) |
| `config.ts` | Environment variable reading (`ANTECHAMBER_`/`OCPI_` prefix fallback), state directory resolution |
| `types.ts` | Shared OpenCode v1 type definitions |

## Testing

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs `test/*.test.ts` under Node's built-in test runner
(`tsx --test`). These tests are hermetic: they don't require a real `pi` or
`omo` binary on PATH, and use fixtures under `test/fixtures/` (fake RPC
processes, fake OmO endpoints, recorded tool-call payloads) to exercise the
adapter logic in isolation.

Keep new tests hermetic and free of fixed sleeps. If a test needs to wait on
an async state change (an RPC event, a process exit), subscribe to that
signal with a bounded timeout rather than polling or sleeping a fixed
duration.

## Smoke scripts

The scripts under `contrib/` drive a real agent process end to end and make
real model calls, so they cost tokens and are not run in CI:

| Script | Command | What it checks |
|---|---|---|
| `contrib/smoke.ts` | `npm run smoke` | End-to-end smoke against a real `pi` process: bootstrap probes, a full tool round, abort, rename, delete |
| `contrib/omo-smoke.ts` | `npm run omo-smoke` | End-to-end smoke against a real `omo` process, including OmO-specific features (fork/revert/unrevert, subagents, approvals, shell, compaction). Runs in an isolated HOME and private state directory; see `contrib/smoke/README.md`. |
| `contrib/probe.ts` | `npm run probe` | Dumps raw pi/OmO RPC events to a JSONL file for protocol inspection |
| `contrib/model-consistency.ts` | `npm run model-smoke` | Checks that model selection/resolution stays consistent across requests |
| `contrib/v2-smoke.ts` | `npm run v2-smoke` | Checks the OpenCode v2 API surface specifically |

`contrib/smoke/` holds the shared smoke-test harness (`core.ts`, `context.ts`,
and the `checks/` modules loaded by `contrib/omo-smoke.ts`); see
`contrib/smoke/README.md` for how checks are structured, the `--only`
selector, and how to add a new check module.

OmO-specific maintainer tooling (deployment scripts, version-pin tracking,
and similar operational material that isn't part of the general smoke suite)
is expected to live under `contrib/omo/` going forward rather than at the
repository root or in `docs/`.

## Adding a feature that touches the OpenCode API

1. Check `docs/api-surface.md` for the route/event you're implementing and
   whether OpenChamber actually calls it.
2. Implement the v1 route in `server.ts` and, if OpenChamber's v2 API path
   differs, the v2 translation in `v2.ts`.
3. Add a unit test under `test/` using the existing RPC/HTTP fixtures rather
   than a real agent process.
4. If you're adding or renaming behavior tied to an environment variable,
   update `docs/configuration.md` in the same change.
5. If you changed what a route returns or which routes exist, update
   `docs/api-surface.md`.
