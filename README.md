# antechamber

A local OpenCode-compatible HTTP/SSE server that lets [OpenChamber](https://github.com/openchamber/openchamber) drive [OmO](https://github.com/code-yeongyu/oh-my-openagent) instead of OpenCode. Plain [pi](https://github.com/badlogic/pi-mono) also works as an opt-in backend.

[![CI](https://github.com/eliottness/antechamber/actions/workflows/ci.yml/badge.svg)](https://github.com/eliottness/antechamber/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/eliottness/antechamber?style=flat&labelColor=100F0F&color=205EA6)](./LICENSE)

## What it is

OpenChamber only speaks the OpenCode HTTP/SSE API. OmO (and pi, which it
builds on) are headless agents with their own RPC protocol (JSONL over stdio). antechamber sits
between them: it implements the subset of the OpenCode API that OpenChamber
actually uses, and translates every call into an OmO RPC session.

```
OpenChamber (UI)  --OpenCode API (HTTP/SSE)-->  antechamber  --JSONL/stdio-->  omo --mode rpc
                                                                                (one process per session)
```

No fork of OpenChamber or pi is required. Point OpenChamber at antechamber as
an **external OpenCode server** and sessions run on OmO.

## Features

- Session create/list/rename/archive/delete, prompt streaming (text and
  reasoning deltas), and abort, mapped onto pi/OmO RPC sessions.
- Tool calls rendered as native OpenChamber tool parts (bash, write, edit,
  and so on), including subagent/task cards.
- Approvals and questions bridged through pi's extension-UI protocol.
- Todo list bridging from pi/OmO's todo tool to OpenChamber's task panel.
- Fork, revert, and unrevert backed by the agent's session tree, not a
  filesystem snapshot. Reverting changes conversation context only; it never
  touches files on disk.
- Session diff endpoint (unified patch) independent of OpenChamber's own git
  integration.
- Session persistence and revival across connector restarts, with explicit
  ownership tracking for detached task-host processes it spawned.
- Idle reaping and a live-process cap (`ANTECHAMBER_MAX_LIVE`) so long-running
  deployments don't accumulate agent processes.

## Supported backends

| Backend | Status |
|---|---|
| [OmO](https://github.com/code-yeongyu/oh-my-openagent) (`omo`, package `omo-ai`) | **default and supported**: titles, steering, subagent cards, structured questions, and private task-host teardown are built and tested against it |
| [pi](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`) | opt-in, best effort: set `ANTECHAMBER_PI_BINARY=pi`; OmO-specific features are unavailable |

antechamber spawns `omo` from `PATH` unless `ANTECHAMBER_PI_BINARY` names
another executable (see [docs/configuration.md](docs/configuration.md)).

## Compatibility

| OpenChamber | API | Status |
|---|---|---|
| >= 2.0.4 | v2 (`@opencode-ai/sdk/v2`) | primary target; antechamber advertises `opencode v2.0.18` on `--version` |
| 1.24.x | v1 | supported |
| other versions | - | not tested |

OpenChamber changes which OpenCode API calls it makes between releases. If a
feature breaks on a newer OpenChamber, run `npm run smoke` to see which check
failed, then open an issue with the output. See
[docs/api-surface.md](docs/api-surface.md) for the exact endpoints antechamber
implements.

## Quick start

Needs Node.js 22+ and OmO's `omo` command on PATH (`bun add -g omo-ai`).

```bash
git clone https://github.com/eliottness/antechamber.git
cd antechamber
npm ci
npm run build
```

Point OpenChamber at the built launcher through an isolated data directory so
your main OpenChamber setup stays untouched:

```bash
mkdir -p ~/.config/antechamber-openchamber
printf '{\n  "opencodeBinary": "%s/bin/opencode-antechamber"\n}\n' "$PWD" \
  > ~/.config/antechamber-openchamber/settings.json

OPENCHAMBER_DATA_DIR=~/.config/antechamber-openchamber openchamber serve --port 57124
# open http://127.0.0.1:57124
```

That starts a second OpenChamber instance whose sessions run on OmO, leaving
your main OpenChamber setup on plain OpenCode.

OpenChamber spawns whatever `settings.opencodeBinary` points at as
`serve --hostname H --port P`, waits for the stdout line
`opencode server listening on <url>`, then health-checks `/global/health`.
`bin/opencode-antechamber` implements that contract on top of `dist/cli.js`;
it requires `npm run build` to have run first. `bin/opencode-pi` is a
deprecated shim kept for settings files written before the project was
renamed from `openchamber-pi-connector`.

You can also run antechamber directly, outside of OpenChamber's managed
lifecycle:

```bash
antechamber --port 4096 --host 127.0.0.1 --directory /path/to/project
# or, OpenCode-compatible:
antechamber serve --hostname 127.0.0.1 --port 4096
```

## Configuration

All settings are environment variables prefixed `ANTECHAMBER_`. The
deprecated `OCPI_` prefix is still accepted as a fallback for existing
deployments. Full reference, defaults, and units: [docs/configuration.md](docs/configuration.md).

| Variable | Purpose |
|---|---|
| `ANTECHAMBER_PI_BINARY` | agent executable to spawn (default `omo`; set to `pi` for plain pi) |
| `ANTECHAMBER_PI_ARGS` | extra whitespace-split args passed to that binary |
| `ANTECHAMBER_STATE_DIR` | session registry directory |
| `ANTECHAMBER_AGENT` | agent name override advertised to OpenChamber |
| `ANTECHAMBER_IDLE_TIMEOUT_MS` | idle session reap timeout |
| `ANTECHAMBER_MAX_LIVE` | cap on concurrent live agent processes |
| `ANTECHAMBER_DEBUG` / `ANTECHAMBER_DEBUG_LOG` | request/event debug logging |

## Security

antechamber is a local development tool: by default it binds to loopback
with no authentication, and it can run arbitrary shell commands on behalf of
the agent. Treat it the same way you'd treat a local dev server with shell
access, not a service to expose on a network.

Hardening controls (full reference in [docs/configuration.md](docs/configuration.md#security)):

- Optional HTTP Basic auth, matching OpenCode's own contract:
  `OPENCODE_SERVER_PASSWORD` (plus `OPENCODE_SERVER_USERNAME`, default
  `opencode`).
- Requests carrying a non-loopback browser `Origin` are rejected unless listed
  in `ANTECHAMBER_ALLOWED_ORIGINS`.
- Binding to a non-loopback host requires a password, `ANTECHAMBER_ALLOW_INSECURE=1`,
  or the `--insecure-no-auth` flag.
- Request bodies are capped by `ANTECHAMBER_MAX_BODY_BYTES` (default 10 MiB);
  SSE subscribers, file search and agent RPC frames have fixed bounds.

## Platform notes

Linux is the primary supported platform. OmO's private task-host teardown
(killing detached supervisor processes antechamber spawned) needs Linux
pidfds (`os.pidfd_open`, Linux 5.3+) and `python3` on PATH; Node has no pidfd
API. On other platforms that teardown step is skipped with one warning instead
of crashing; antechamber never falls back to signalling numeric PIDs. macOS is untested.

## Limitations / non-goals

- Not a reimplementation of OpenChamber's own platform features (scheduler,
  relay, goals). Those stay in OpenChamber.
- Not a way to use pi/OmO as an LLM provider inside OpenCode. pi/OmO are full
  agents with their own loop; antechamber adapts at the session-protocol
  level, not the model level.
- Some OpenCode routes have no pi/OmO equivalent and are stubbed or return
  `400`/`501` (OAuth-based provider auth, MCP connect/disconnect, session
  share). See [docs/api-surface.md](docs/api-surface.md) for the exact list.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The smoke scripts (`npm run smoke`, `npm run omo-smoke`, `npm run probe`,
`npm run model-smoke`, `npm run v2-smoke`) drive a real `omo` (or `pi`)
process end to end and cost model tokens; they are not part of `npm test`
and are not run in CI. See [docs/development.md](docs/development.md).

## Docs

- [docs/architecture.md](docs/architecture.md) - design and session-model mapping
- [docs/api-surface.md](docs/api-surface.md) - OpenCode endpoints implemented, stubbed, or unsupported
- [docs/configuration.md](docs/configuration.md) - full environment variable reference
- [docs/development.md](docs/development.md) - source layout, testing, smoke scripts
- [docs/backends/omo.md](docs/backends/omo.md) - OmO backend details (agent name, task hosts, transcripts)

## Credits

antechamber began as a fork of
[openchamber-pi-connector](https://github.com/qingzhu521/openchamber-pi-connector)
by qingzhu521 (xiuli.qz), released under the MIT license, and was substantially
extended from there (OpenCode v2 API support, OmO support, session fork/revert,
subagent and task cards, approvals, todos, thinking levels, shell runs, diffs,
session persistence, lifecycle caps, and more).

Also relies on [OpenChamber](https://github.com/openchamber/openchamber),
[OmO](https://github.com/code-yeongyu/oh-my-openagent) by code-yeongyu, and
[pi](https://github.com/badlogic/pi-mono) by badlogic / earendil.

## License

MIT. See [LICENSE](./LICENSE), which retains the original
openchamber-pi-connector copyright notice alongside the antechamber one.
