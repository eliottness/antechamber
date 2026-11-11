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
- OmO's todo list, grouped by phase, in the extension's OmO Work section.
- Fork, revert, and unrevert backed by the agent's session tree, not a
  filesystem snapshot. Reverting changes conversation context only; it never
  touches files on disk.
- Session diff endpoint (unified patch) independent of OpenChamber's own git
  integration.
- Session persistence and revival across connector restarts, with explicit
  ownership tracking for detached task-host processes it spawned.
- Idle reaping and a live-process cap (`ANTECHAMBER_MAX_LIVE`) so long-running
  deployments don't accumulate agent processes.
- [One OpenChamber extension](#the-openchamber-extension) that installs and
  updates antechamber and OmO for you, draws the OmO sub-agents behind the open
  session as a live graph (**OmO Graph**), shows the todo phases and goal timer
  in the Work Status panel (**OmO Work**), and titles OmO's tool cards.

## Supported backends

| Backend | Status |
|---|---|
| [OmO](https://github.com/code-yeongyu/oh-my-openagent) (`omo`, package `omo-ai`) | **default and supported**: titles, steering, subagent cards, structured questions, and private task-host teardown are built and tested against it |
| [pi](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`) | opt-in, best effort: set `ANTECHAMBER_PI_BINARY=pi`; OmO-specific features are unavailable |

Each antechamber release depends on one exact `omo-ai` version and runs that
OmO, so the pair you get is the pair that was tested together.
`ANTECHAMBER_PI_BINARY` selects another executable; `omo` on `PATH` is the
fallback when the pinned one is not installed (see
[docs/configuration.md](docs/configuration.md)).

## Compatibility

| OpenChamber | API | Status |
|---|---|---|
| >= 2.3.2 | v2 (`/api/*`) | supported; antechamber advertises `opencode v2.999.0` on `--version` |
| other versions | - | not tested |

OpenChamber changes which OpenCode API calls it makes between releases. If a
feature breaks on a newer OpenChamber, run `npm run smoke` to see which check
failed, then open an issue with the output. See
[docs/api-surface.md](docs/api-surface.md) for the maintained route, response,
and event-stream inventory.

## Quick start

Needs [Bun](https://bun.sh) 1.4+ on the machine OpenChamber runs on.

### As an OpenChamber extension (recommended)

1. In OpenChamber 2.3.2 or newer, open **Settings → Extensions → Add → URL** and
   enter `https://github.com/eliottness/antechamber`.
2. Approve **sessions** and the **local service** (it runs `bun`).
3. Open the **OmO** rail panel's settings (the sliders icon). Once the **Runtime** block
   says antechamber is installed, click **Use as OpenCode CLI**, then **Reload OpenCode**
   in OpenChamber's OpenCode settings. A folder install shows the launcher path to paste
   into **Settings → OpenCode CLI** instead.

The launcher installs the antechamber release named by the extension's version,
and the OmO it pins, into `~/.antechamber/runtime/<version>` the first time it
starts. Updating the extension in Settings → Extensions is how antechamber and
OmO are updated. Details: [extensions/antechamber/README.md](extensions/antechamber/README.md).

### From npm

```bash
npm i -g antechamber
# or: bun add -g antechamber
antechamber doctor
antechamber setup --auto-update
```

The npm package brings its pinned OmO along. `setup` updates OpenChamber's
`opencodeBinary`, preserves all other settings, and backs up an existing
settings file before changing it. Restart OpenChamber after setup. Preview
changes with `antechamber setup --dry-run`.

`--auto-update` keeps antechamber current without any action from you. It
writes a small launcher, `~/.config/antechamber/opencode-antechamber`, and points
OpenChamber at it. Each time OpenChamber starts antechamber, the launcher
checks npm for a newer release once the server is up and installs it with the
package manager that owns the global install. The new version runs from the
next start; startup never waits on the network, and an offline start just
skips the check. It needs a global npm or bun install, so it is refused for
source checkouts and `npx`. Drop the flag (plain `antechamber setup`) to point
OpenChamber back at the `antechamber` bin and stop auto-updates.

`setup` ends by printing the bundled extension's folder (under
`$(npm root -g)/antechamber/extensions/antechamber`); add it with
**Settings → Extensions → Add → Folder** for the Graph, Work and tool headers.
OpenChamber can keep using the npm-installed `antechamber` as its OpenCode CLI.

For an isolated OpenChamber instance, leaving your main settings untouched:

```bash
antechamber setup --profile ~/.config/antechamber-openchamber
# setup prints the command for this profile:
OPENCHAMBER_DATA_DIR=~/.config/antechamber-openchamber openchamber serve --port 57124
```

For a systemd-managed OpenChamber, also capture the shell's PATH and the
absolute OmO executable in a user service drop-in:

```bash
antechamber setup --systemd
# default unit: openchamber.service; another unit: --systemd my-openchamber.service
systemctl --user daemon-reload && systemctl --user restart openchamber.service
# or explicitly let setup run those commands:
antechamber setup --systemd --restart
```

`--pi-binary /absolute/path/to/omo` overrides backend discovery for the drop-in.
Other drop-ins setting `ANTECHAMBER_*` or `OCPI_*` produce a warning: later
files can override the generated configuration. `setup` never runs systemctl
unless `--restart` is passed.

OpenChamber spawns whatever `settings.opencodeBinary` points at as
`serve --hostname H --port P`, waits for the stdout line
`opencode server listening on <url>`, then health-checks `/global/health`.
The installed `antechamber` bin implements this contract itself, including the
`--version` compatibility probe. `bin/opencode-antechamber` is only needed for
source checkouts; `bin/opencode-pi` remains a deprecated compatibility shim.

You can also run antechamber directly, outside of OpenChamber's managed
lifecycle:

```bash
antechamber --port 4096 --host 127.0.0.1 --directory /path/to/project
# or, OpenCode-compatible:
antechamber serve --hostname 127.0.0.1 --port 4096
```

## Commands

| Command | Purpose / options |
|---|---|
| `antechamber serve` | OpenCode-compatible server; `--hostname`/`--host`, `--port`, `--directory`. Bare `antechamber` also starts the server. |
| `antechamber setup` | Configure OpenChamber; `--settings <file>`, `--profile <dir>`, `--binary <path>`, `--dry-run`, `--systemd [unit]`, `--pi-binary <path>`, `--restart`, `--auto-update`. |
| `antechamber doctor` | Read-only Bun, backend, agent/state directories, teardown, OpenChamber and auth checks, plus the installed, latest released and running adapter versions (a running server older than the install needs an OpenChamber restart); `--json`, `--settings <file>`, `--profile <dir>`. Exits 1 on any FAIL; warnings do not fail. |
| `antechamber upgrade` | Install the latest release over a global npm or bun install, with the package manager that owns it. Refused for source checkouts, `npx`, and when the extension's launcher manages antechamber (see Upgrade, uninstall and rollback below). |
| `antechamber version` | Package version plus OpenCode API contract version. `--version`/`-v` deliberately print exactly `opencode v2.999.0` for OpenChamber. |
| `antechamber help` | Usage and options; also `--help`/`-h`. |

## Upgrade, uninstall and rollback

With `setup --auto-update` there is nothing to do: each start installs the
latest release for the next one. Otherwise:

```bash
antechamber upgrade
# equivalent: npm update -g antechamber (or: bun add -g antechamber)
```

Restart OpenChamber, or `systemctl --user restart openchamber.service` for a
managed service. Run `antechamber doctor` again. If the executable moved,
rerun `antechamber setup`.

OpenChamber can show an "OpenCode update" notice. Its **Update** button runs
`<opencodeBinary> upgrade`: for an npm install that upgrades antechamber itself
(a no-op when it is already current); for the extension's launcher it only says
to update the extension in Settings → Extensions. Click **Reload OpenCode**
afterwards to restart onto the new version.

To roll back wiring, copy the backup printed by setup over the settings file:

```bash
cp /path/settings.json.bak-antechamber-YYYYMMDDHHMMSS /path/settings.json
```

If you used `--systemd`, restore the printed `antechamber.conf` backup, or
remove only that generated drop-in if there was no previous file. Then run
`systemctl --user daemon-reload` and restart OpenChamber/the service. Restore
the old `opencodeBinary` before uninstalling:

```bash
npm uninstall -g antechamber
# or: bun remove -g antechamber
```

## From source

```bash
git clone https://github.com/eliottness/antechamber.git
cd antechamber
npm ci
npm run build
bun dist/cli.js doctor
bun dist/cli.js setup --binary "$PWD/bin/opencode-antechamber"
# isolated alternative:
bun dist/cli.js setup --profile ~/.config/antechamber-openchamber \
  --binary "$PWD/bin/opencode-antechamber"
```

Building needs Node.js 22+ for the development tooling; the built CLI runs on
Bun. The source launcher requires the built `dist/cli.js` and finds Bun on PATH,
in `$BUN_INSTALL/bin` or in `~/.bun/bin`. Pull updates, run
`npm ci && npm run build`, and restart OpenChamber.

`npm run build` also builds the extension; `setup` prints its folder
(`$PWD/extensions/antechamber`) to add in **Settings → Extensions → Add →
Folder**. To run a checkout through the extension's launcher instead, `npm pack`
it and set `ANTECHAMBER_RUNTIME_SPEC` to the tarball in OpenChamber's
environment.

## The OpenChamber extension

`extensions/antechamber` is one OpenChamber 2.3.2+ extension (web and desktop;
VS Code and mobile load no extensions). It replaces the OmO Graph, OmO Work and
OmO Compatibility extensions of antechamber 1.x: remove those, then add this
one.

| Part | What it does |
|---|---|
| Runtime | `bin/opencode-antechamber`, OpenChamber's OpenCode CLI: installs and runs the pinned antechamber and OmO with Bun |
| OmO Graph | a rail panel (and page) drawing the open session's OmO sub-agents as a live, clickable graph |
| OmO Work | a Work Status section with the session's todo phases, goal timer and other wake sources |
| Tool headers | eval cells read `JS Eval`/`Python Eval` and their summary; sub-agent cards read their agent and description |

Add it from **Settings → Extensions → Add**:

| Source | Add | Updates |
|---|---|---|
| **URL** (Git, recommended) | `https://github.com/eliottness/antechamber` (the repository root is the extension), or `…#extension/antechamber` for a clone of just the extension | OpenChamber offers **Update** after each release |
| **Folder** | `extensions/antechamber` of an npm install or a built checkout | changes with the installation |
| **ZIP** | `antechamber-openchamber.zip` from a GitHub release, or `npm run build && npm run pack:extension -- out.zip` | never; reinstall the new archive |

Both URLs install the same extension: the root `package.json` carries its
manifest, pointing into `extensions/antechamber/`, whose built files are
committed. It asks
for **sessions** and a **local service** (`bun`). Details, data paths and the
design: [extensions/antechamber/README.md](extensions/antechamber/README.md),
[docs/GRAPH.md](extensions/antechamber/docs/GRAPH.md),
[docs/WORK.md](extensions/antechamber/docs/WORK.md).

## Configuration

Connector settings use the `ANTECHAMBER_` prefix; the deprecated `OCPI_`
prefix is still accepted as a fallback. RPC capability passthrough also reads
`OMO_RPC_CLIENT_CAPABILITIES` and `SENPI_RPC_CLIENT_CAPABILITIES` directly.
Full reference, defaults, and units:
[docs/configuration.md](docs/configuration.md).

| Variable | Purpose |
|---|---|
| `ANTECHAMBER_PI_BINARY` | agent executable to spawn (default `omo`; set to `pi` for plain pi) |
| `ANTECHAMBER_PI_ARGS` | extra whitespace-split args passed to that binary |
| `ANTECHAMBER_STATE_DIR` | session registry directory |
| `ANTECHAMBER_AGENT` | agent name override advertised to OpenChamber |
| `ANTECHAMBER_IDLE_TIMEOUT_MS` | idle session reap timeout |
| `ANTECHAMBER_MAX_LIVE` | cap on concurrent live agent processes |
| `ANTECHAMBER_DEBUG` / `ANTECHAMBER_DEBUG_LOG` | request/event debug logging |
| `OMO_RPC_CLIENT_CAPABILITIES` / `SENPI_RPC_CLIENT_CAPABILITIES` | inherited RPC capabilities merged for the agent process |

## Security

antechamber is a local development tool: by default it binds to loopback
with no authentication, and it can run arbitrary shell commands on behalf of
the agent. Treat it the same way you'd treat a local dev server with shell
access, not a service to expose on a network.

Hardening controls (full reference in [docs/configuration.md](docs/configuration.md#security)):

- Optional HTTP Basic auth, matching OpenCode's own contract:
  `OPENCODE_SERVER_PASSWORD` (plus `OPENCODE_SERVER_USERNAME`, default
  `opencode`).
- Without a password, browser origins are limited to the adapter's own origin,
  HTTP(S) loopback origins (including a different loopback port), and origins
  listed in `ANTECHAMBER_ALLOWED_ORIGINS`; other origins get `403`. With a
  password, other origins may make authenticated requests but receive no CORS
  headers unless explicitly allowed.
- Binding to a non-loopback host requires a password, `ANTECHAMBER_ALLOW_INSECURE=1`,
  or the `--insecure-no-auth` flag.
- Request bodies are capped by `ANTECHAMBER_MAX_BODY_BYTES` (default 10 MiB);
  SSE subscribers, file search and agent RPC frames have fixed bounds.

## Platform notes

Linux is the primary supported platform. OmO's private task-host teardown
(killing detached supervisor processes antechamber spawned) uses Linux
pidfds (`os.pidfd_open`, Linux 5.3+) and `python3` on PATH, because Node has no pidfd
API; on Linux it never signals a numeric PID. macOS has no pidfd, so there it
reads `/bin/ps` and `/usr/sbin/lsof` and signals each owned process by PID after
re-checking its process group and start time (see
[the OmO backend notes](docs/backends/omo.md#private-task-host-teardown)). CI runs the suite on
macOS. On other platforms that teardown step is skipped with one warning instead of crashing.

## Limitations / non-goals

- Not a reimplementation of OpenChamber's own platform features (scheduler,
  relay, goals). Those stay in OpenChamber.
- Not a way to use pi/OmO as an LLM provider inside OpenCode. pi/OmO are full
  agents with their own loop; antechamber adapts at the session-protocol
  level, not the model level.
- Some OpenCode routes have no pi/OmO equivalent and are stubbed or return
  `400`/`501` (OAuth-based provider auth, MCP connect/disconnect, session
  share). See [docs/api-surface.md](docs/api-surface.md) for the maintained
  route and unsupported-response inventory.

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

Every commit on `main` is released as a new patch version: CI runs the checks,
bumps the package and extension versions, tags, publishes to npm with
provenance and creates the GitHub release from the CHANGELOG. See
[RELEASE.md](RELEASE.md).

## Docs

- [docs/architecture.md](docs/architecture.md) - design and session-model mapping
- [docs/api-surface.md](docs/api-surface.md) - OpenCode endpoints implemented, stubbed, or unsupported
- [docs/configuration.md](docs/configuration.md) - full environment variable reference
- [docs/development.md](docs/development.md) - source layout, testing, smoke scripts
- [docs/backends/omo.md](docs/backends/omo.md) - OmO backend details (agent name, task hosts, transcripts)
- [RELEASE.md](RELEASE.md) - automatic patch releases to npm and GitHub on every push to `main`

- [extensions/antechamber/README.md](extensions/antechamber/README.md) - the OpenChamber extension: runtime launcher, OmO Graph ([design](extensions/antechamber/docs/GRAPH.md)), OmO Work ([design](extensions/antechamber/docs/WORK.md)) and tool headers

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
