# OmO Work: OpenChamber extension

An **OmO Work** section in OpenChamber's Work Status panel, for the background
work of the session you are looking at. It ships with
[antechamber](../../README.md) and needs OpenChamber **2.3.2 or newer** (web or
desktop). OpenChamber 1.x has no extension sections, and VS Code and mobile
load no extensions.

For the open session it shows:

- **Todo**: OmO's todo list grouped by phase, with progress per phase. The
  phase in progress is open; click any phase to open or close it.
- **Goal**: the goal continuation timer, what it waits on, and **Fire now**.
- **Other activity**: any other wake source OmO reports.

Terminal monitors, detached eval cells and background terminal sessions are not
listed here: antechamber reports them to OpenChamber as background commands,
so the session reads as working while they run and OpenChamber lists them above
the composer with their output (and Stop, for eval cells).

The section sizes itself to its content, up to OpenChamber's 320 px limit, and
scrolls inside beyond that.

## Install

In OpenChamber, open **Settings → Extensions → Add**:

- **Folder**, when OpenChamber runs on the machine where antechamber is
  installed: the path `antechamber setup` prints,
  `$(npm root -g)/antechamber/extensions/omo-work` for npm installs or
  `<checkout>/extensions/omo-work` after `npm run build`.
- **URL**: `https://github.com/eliottness/antechamber#extension/omo-work`, a
  Git install that OpenChamber offers to update after each release. The
  release archive,
  `https://github.com/eliottness/antechamber/releases/latest/download/antechamber-omo-work.zip`,
  also installs by URL, but OpenChamber never updates ZIP installs.
- **ZIP file**: that archive, or
  `npm run build && npm run pack:work-extension -- antechamber-omo-work.zip`.

Approve its **local service**. The section then appears in the Work Status
panel; the panel's sections dialog can hide or reorder it.

## Requirements

- antechamber with the `/antechamber/work-status` routes (the release that
  added this extension or newer), running as OpenChamber's OpenCode server.
  After upgrading antechamber, restart OpenChamber so it runs the new adapter;
  `antechamber doctor` reports the running version.
- The extension service runs on the OpenChamber host and reads antechamber's
  run records, so antechamber must run on the same machine.

## How it works

```
section (sandboxed iframe) --serviceRequest /status?session=ses_...--> OpenChamber host
                                                                     | loopback + host token
                                                                     v
                              service/main.js --Bearer <run token>--> antechamber
                              reads <state dir>/run/<pid>.json        /antechamber/work-status/<session>
```

`antechamber serve` writes `<state dir>/run/<pid>.json` (mode 0600) with its
URL and a random token that opens only the `/antechamber/work-status` routes. The service
picks the running server whose agent holds the session and relays the snapshot
and the Fire now action. It keeps no state. See [docs/DESIGN.md](docs/DESIGN.md) for the snapshot, refresh,
server choice and security boundary, and
[docs/architecture.md](../../docs/architecture.md#omo-work-status-section) for
where each piece of data comes from in OmO.

The state directory defaults to `~/.config/antechamber`, then
`~/.config/openchamber-pi-connector`. OpenChamber starts extension services
with a minimal environment, so if your deployment sets `ANTECHAMBER_STATE_DIR`,
enter the same path under **Data path** in the section header. It is saved in
the extension's OpenChamber storage.

## Limitations

OmO does not publish continuation holds over RPC (the loop guard keeps them
in-process), so the section cannot show them.

## Development

From the repository root: `npm run build:extension` bundles `src/status.ts`
into `status/main.js` (browser IIFE) and `src/service-main.ts` into
`service/main.js` (Node ESM); `npm test`, `npm run typecheck`, `npm run lint`
and `npm run format:check` cover it. `src/model.ts` imports the snapshot types
from the adapter (`src/work-status.ts`), so a shape change on either side fails
the typecheck.
