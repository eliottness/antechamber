# OmO Graph: OpenChamber extension

A live, interactive graph of the OmO sub-agents behind the OpenChamber session
you are looking at. It ships with [antechamber](../../README.md) and runs in
OpenChamber's extension sandbox, next to the antechamber server that runs your
sessions on OmO.

- **One graph per run.** Open any session and the panel shows its
  orchestrator plus every task OmO launched for it. Tasks are arranged in
  waves (columns), the way [omo.dev](https://omo.dev) draws a `mass ulw`
  workflow. Opening a sub-agent's own session shows the same run, with that
  sub-agent outlined.
- **Live state on every card.** Each card shows a status dot, a status line
  such as `running · 2m 03s`, `completed · 41s` or `failed`, the agent or
  category, the model, and the first line of the result. Running cards glow,
  and their incoming edges carry a moving pulse. The rail icon shows a badge
  with the number of running agents.
- **Hover to trace** (Archify-style focus). Hovering or keyboard-focusing a
  card highlights its **input edges** (amber) and **output edges** (accent).
  Its transitive upstream and downstream reach stays half-lit, and everything
  else dims. The inspector strip shows tokens, cost, tool calls, input and
  output counts, and the result or error.
- **Click to open.** Clicking a card opens that sub-agent's session, or the
  orchestrator's, in the chat.
- **Pan and zoom.** Drag the background, and scroll or pinch to zoom. `0`
  fits the graph; the target button centres on the current or first running
  agent.

The panel docks in the right rail. The same page is also available full
screen from the sidebar's Extension pages menu.

## Requirements

- OpenChamber **1.22 or newer**, on web or desktop. It is verified against
  1.24.2 and uses only the v1 extension API that 2.x hosts also accept. VS
  Code and mobile do not load extensions.
- antechamber running its default OmO backend, so that sub-agent sessions
  exist in OpenChamber. A plain pi backend (`ANTECHAMBER_PI_BINARY=pi`) has no
  sub-agents to draw.
- The OmO task store on the same machine as the OpenChamber server
  (`~/.omo/agent` by default).

The built files run on OpenChamber's own runtime and need nothing else
installed.

## Install

In OpenChamber, open **Settings → Extensions → Add** and pick the source that
fits where OpenChamber runs:

- **Folder**, when OpenChamber runs on the machine where antechamber is
  installed. `antechamber setup` prints the path to paste:
  - npm install: `$(npm root -g)/antechamber/extensions/omo-dag`. The
    published package ships the built extension, and `npm update -g` updates
    the folder in place.
  - source checkout: `<checkout>/extensions/omo-dag`, after `npm run build`
    (which also writes `panel/main.js` and `service/main.js`).
- **URL**, from anywhere, including a remote OpenChamber you only reach in a
  browser:
  `https://github.com/eliottness/antechamber/releases/latest/download/antechamber-omo-graph.zip`.
  Every GitHub release attaches this archive. Append a version instead of
  `latest` (`.../releases/download/vX.Y.Z/antechamber-omo-graph.zip`) to pin
  one.
- **ZIP file**, for offline hosts: the same archive, downloaded, or built with
  `npm run build && npm run pack:extension -- antechamber-omo-graph.zip`.

Don't use the repository's Git URL. OpenChamber clones the repository root,
which is antechamber itself, and rejects it as `invalid-manifest`.

Approve the request. The extension asks for two things:

- **sessions**, to follow the open session and open sub-agent sessions;
- **a local service**, to read the OmO task store.

Then open it from the rail icon.

For a server you reach over HTTP:

```bash
curl -sX POST "$OC/api/guests" -H 'content-type: application/json' \
  -d '{"path":"/abs/path/to/extensions/omo-dag"}'
curl -sX PUT "$OC/api/guests/omo-dag/capabilities" -H 'content-type: application/json' \
  -d '{"granted":["sessions","service"]}'
```

Add your UI auth if the instance has a password. A folder install serves the
files in place: after `npm run build`, reopen the panel. To restart a running
service, toggle the extension off and on.

## Deploying alongside antechamber

1. Build antechamber in the deployment checkout (`npm ci && npm run build`).
   That one build covers both the server and the extension.
2. Install `<checkout>/extensions/omo-dag` once in the OpenChamber instance
   and approve it.
3. If deployments move between checkouts, install a stable symlink once (for
   example `~/.local/share/antechamber/omo-dag -> <checkout>/extensions/omo-dag`)
   so an upgrade only re-points the link.

When antechamber uses the default locations, the service needs no
configuration (see [Data paths](#data-paths)). To roll back, pause or remove
the extension. It never writes to the OmO store, the antechamber registry, or
the server.

## Data paths

By default the service reads:

| What | Default |
|---|---|
| OmO agent directory | `~/.omo/agent`, then `~/.pi/agent` (both are scanned for tasks) |
| antechamber state directory | `~/.config/antechamber`, then `~/.config/openchamber-pi-connector` (entries in the first win) |

OpenChamber starts extension services with a minimal environment, so the
service does not see `ANTECHAMBER_STATE_DIR` or the agent-directory variables
(`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`). If
your deployment sets any of them, enter the same locations in the panel's
**Data paths** popover (the sliders icon). They are saved in the extension's
OpenChamber storage.

## How it works

See [docs/DESIGN.md](docs/DESIGN.md) for the data model, the layout, and the
security boundary. In short:

```
panel (sandboxed iframe) ──serviceRequest GET /graph?session=ses_…──▶ OpenChamber host
      ▲   openSession / setBadge / onSession                         │ loopback + bearer
      │                                                              ▼
      └──────────────── JSON graph ◀──────────── service/main.js (Node, read-only)
                                                   reads ~/.omo/agent/projects/*/senpi-task/tasks/*.json
                                                   and antechamber's sessions.json
```

## Development

The extension is part of the antechamber repository's toolchain. All
commands run from the repository root:

| Command | What it covers for the extension |
|---|---|
| `npm run build:extension` | bundles `src/panel.ts` into `panel/main.js` (browser IIFE) and `src/service-main.ts` into `service/main.js` (Node ESM) with esbuild |
| `npm test` | runs `extensions/*/test/*.test.ts` alongside the server tests |
| `npm run typecheck` | checks `extensions/omo-dag/tsconfig.json` (DOM + Node) after the server |
| `npm run lint` / `npm run format:check` | Biome, same rules as the rest of the repository |

The sources are:

- `src/graph.ts`: task records to graph, plus input validation;
- `src/layout.ts`: columns, rows and edge routing;
- `src/store.ts`: cached disk reads;
- `src/service.ts`: HTTP;
- `src/poller.ts`: the refresh loop, which runs one request at a time and
  drops stale answers after a session or path change;
- `src/panel.ts` and `panel/index.html`: the UI.

`test/connector-parity.test.ts` imports antechamber's own `ocIdFor` and
`SessionRegistryEntry`, so a change to session ids or registry fields on the
server side fails the test suite rather than breaking the graph silently.
