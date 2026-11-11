# antechamber: OpenChamber extension

One OpenChamber 2.x extension that installs [antechamber](../../README.md) and OmO, keeps them at the versions this
release pins, and adds the OmO views to OpenChamber:

- **OmO Graph**, a rail panel (and a full-screen page) drawing the OmO sub-agents behind the open session as a live
  graph. See [docs/GRAPH.md](docs/GRAPH.md).
- **OmO Work**, a section of the Work Status panel with the session's todo phases, goal timer and other wake
  sources. See [docs/WORK.md](docs/WORK.md).
- **OmO tool headers**: eval cells read `JS Eval` (or `Python Eval`) and their summary instead of "Shell Command",
  and a sub-agent card reads its agent type and description instead of "Agent Task".
- **The runtime**: `bin/opencode-antechamber`, the program OpenChamber runs as its OpenCode server. Its first start
  installs, with Bun, the antechamber release whose version is this extension's version, and the `omo-ai` that
  release pins, into `~/.antechamber/runtime/<version>`.

It replaces the separate OmO Graph, OmO Work and OmO Compatibility extensions of antechamber 1.x.

## Requirements

- OpenChamber **2.3.2 or newer**, web or desktop. VS Code and mobile load no extensions.
- [Bun](https://bun.sh) 1.4 or newer on the machine OpenChamber runs on, on `PATH` or in `~/.bun/bin`.
- Network access to the npm registry the first time each version starts.

## Install

1. In OpenChamber, open **Settings → Extensions → Add → URL** and enter
   `https://github.com/eliottness/antechamber#extension/antechamber`. Keep the `#extension/antechamber` part: the
   repository root is antechamber itself and is not an extension.
2. Approve what it asks for: **sessions**, to follow the open session and open sub-agent sessions, and **a local
   service that runs `bun`**, which installs the runtime and reads the OmO task store and antechamber's run records.
3. Open the **OmO** rail panel and its settings (the sliders icon). The **Runtime** block shows the install and the
   launcher's path. The service starts installing as soon as a panel or the Work section opens.
4. In **Settings → OpenCode CLI**, set the path to that launcher,
   `<OpenChamber data dir>/extensions/antechamber/bin/opencode-antechamber`. OpenChamber restarts its server on
   antechamber.

Other ways to add it: a **Folder** (`extensions/antechamber` of an npm install or a built checkout; `antechamber
setup` prints it), or the release **ZIP**
(`https://github.com/eliottness/antechamber/releases/latest/download/antechamber-openchamber.zip`). OpenChamber
checks only Git installs for updates.

For a server you reach over HTTP:

```bash
curl -sX POST "$OC/api/guests" -H 'content-type: application/json' \
  -d '{"url":"https://github.com/eliottness/antechamber#extension/antechamber"}'
curl -sX PUT "$OC/api/guests/antechamber/capabilities" -H 'content-type: application/json' \
  -d '{"granted":["sessions","service"]}'
```

## Updating

Every antechamber release publishes the extension at its own version to the `extension/antechamber` branch, and
OpenChamber offers it under **Update** in Settings → Extensions. Updating the extension is updating antechamber and
OmO: the next time OpenChamber starts its server, the launcher installs the new pair. OpenChamber's own OpenCode
Update action runs the launcher's `upgrade`, which only points here.

The previous runtime stays installed for an adapter that is still running from it; older ones are removed.

## Settings

The launcher reads these from OpenChamber's environment (the service never sees them, because OpenChamber starts
extension services with a minimal environment):

| Variable | Default | Effect |
|---|---|---|
| `ANTECHAMBER_RUNTIME_DIR` | `~/.antechamber/runtime` | Where runtimes are installed |
| `ANTECHAMBER_RUNTIME_SPEC` | unset | A local antechamber tarball or folder to run instead of the pinned release (development) |

Every other antechamber setting (`ANTECHAMBER_PI_BINARY`, `ANTECHAMBER_STATE_DIR`, ...) works as documented in
[docs/configuration.md](../../docs/configuration.md). If your deployment moves the state or agent directories, enter the
same paths in the Graph panel's settings and the Work section's **Data path**.

## How it works

```
OpenChamber --spawn--> bin/opencode-antechamber --exec--> bun <runtime>/node_modules/antechamber/dist/cli.js serve
                          |                                   `--spawn--> <runtime>/node_modules/omo-ai/bin/omo.js --mode rpc
                          `--bun runtime/launcher.js resolve (install when missing)

panel / section (sandboxed iframes) --serviceRequest--> OpenChamber host --loopback + token--> service/main.js
                                                         /graph   reads the OmO task store and the session registry
                                                         /status  relays antechamber's /antechamber/work-status routes
                                                         /runtime reports and starts the runtime install
```

The launcher and the service share one install: a lock directory beside the runtime lets whichever starts first
install, and the other waits. `bun install` runs in a staging directory with `omo-ai` trusted (its postinstall
prepares OmO's engine), and the runtime is moved into place only once antechamber's CLI is there.

## Development

From the repository root: `npm run build:extension` bundles the panel and the section (browser IIFEs), the service
(ESM for OpenChamber's runtime) and the launcher (ESM for Bun); `npm test`, `npm run typecheck`, `npm run lint` and
`npm run format:check` cover it; `npm run pack:extension -- out.zip` writes the release archive. To run a local
build through the launcher, `npm pack` antechamber and point `ANTECHAMBER_RUNTIME_SPEC` at the tarball.

Sources: `src/graph/` (panel, layout, task store, `/graph`), `src/work/` (section, `/status` relay),
`src/runtime/` (install manager and launcher), `src/service.ts` (the one service).
