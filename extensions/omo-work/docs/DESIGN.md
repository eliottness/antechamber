# OmO Work: design

OmO Work is an OpenChamber 2.x Work Status section for the background work of
the open session. This document covers its parts, its data, its security
boundary and its limits. Where each field comes from in OmO is documented in
[docs/architecture.md](../../../docs/architecture.md#omo-work-status-section).

## Parts

```
OpenChamber Work Status panel
  └─ section frame (status/index.html + status/main.js, sandboxed iframe)
       │ host.serviceRequest  GET /status, GET /eval, POST /eval/stop, POST /goal/fire
       ▼
OpenChamber host ── loopback + OPENCHAMBER_SERVICE_TOKEN ──▶ service/main.js (Node, on the host)
                                                              │ reads <state dir>/run/<pid>.json
                                                              │ Bearer <run token>
                                                              ▼
                                         antechamber  /antechamber/work-status/<session>[...]
                                                              │ snapshot from its bridges,
                                                              ▼ eval_cells.* / goal RPC to OmO
                                                         omo --mode rpc
```

- **Manifest**: `contributes.statusSection` with its own entry, a host
  `service`, and a `panel` block with no entry. OpenChamber 2.x's manifest
  parser requires a `panel` object, but without `panel.entry` there is no rail
  icon or panel; the section is the only surface.
- **Frame** (`src/status.ts`, `src/view.ts`): renders the snapshot. It follows
  the open session through `host.onSession`, sizes itself through
  `host.setHeight`, and publishes one host header control, **Data path**, when
  the host supports status controls.
- **Service** (`src/service.ts`, `src/discovery.ts`): stateless relay. It finds
  running antechamber servers through their run records and forwards the
  frame's requests.
- **Adapter** (`src/work-status.ts` in antechamber): builds the snapshot and
  runs the actions.

## Snapshot

`GET /antechamber/work-status/<session>` answers one JSON object, version 1:

| Field | Content |
|---|---|
| `live` | the session's agent process is running; peek, Stop and Fire now need it |
| `todo` | todo phases in OmO's order, each `{name, tasks: [{content, status}]}`, status `pending`, `in_progress`, `completed` or `cancelled` |
| `monitors` | live watches (newest first), then the five most recently ended, each with its last 20 matched lines and, once ended, a readable reason |
| `evalCells` | detached eval cells from `eval_cells.list`, or from the codemode wake source when the list is unavailable (`evalCellsListed: false`) |
| `background` | background terminal sessions whose process is alive |
| `goal` | the goal continuation timer (`armed`, `kind`, `dueAtMs`) and the wake-source counts it waits on, or `null` |
| `wakeSources` | other active wake sources without a dedicated view |

The frame checks the envelope (`src/model.ts`) and imports these types from the
adapter, so a shape change on either side fails the typecheck.

## Refresh

The frame polls `/status` one request at a time:

- every 1.5 s while anything can change on its own (a live monitor, a running
  or queued cell, a background session, an armed timer, a task in progress);
- every 5 s otherwise, and while the page is hidden;
- every 10 s after an error, keeping the last snapshot on screen with the
  error above it.

A session switch bumps a generation counter, so a late answer for the previous
session is dropped. Elapsed times and countdowns tick every second from the
snapshot without refetching. An open eval cell's output is re-read on each
poll while the cell runs, and once more when its state changes, so a finished
cell shows its last lines.

The adapter caches `eval_cells.list` for one second per session, so several
open sections cost one RPC.

## Choosing the server

Several antechamber servers can run at once, and each can answer for a session
it only knows from disk. For `/status`, the service asks the servers in order,
newest first, and prefers the first answer with `live: true`, else the first
successful one. It remembers which server answered for each session and sends
that session's actions there.

Run records without a `token` (older antechamber versions) and records of dead
processes are skipped. A wildcard bind address (`0.0.0.0`, `::`) is dialed on
loopback.

## Security boundary

- **Token scope**: `serve` generates a random 256-bit token at start and writes
  it into `<state dir>/run/<pid>.json` (file 0600, directory 0700). The adapter
  accepts it as `Authorization: Bearer <token>` only when the normalized path
  starts with `/antechamber/work-status/`, so dot segments, `%2e` and
  backslashes cannot reach other routes. It never replaces the server password
  for anything else.
- **Who can read it**: only processes running as the same user, which can
  already read antechamber's state directory and drive OmO directly.
- **Frame**: the sandboxed iframe holds no token. It reaches the service only
  through the host, which adds its own per-service token. All text from OmO is
  inserted with `textContent`, never as HTML.
- **Inputs**: session IDs must match `ses_[0-9A-Za-z]+` and cell IDs
  `[\w.:-]{1,128}`, in both the service and the adapter. Output peeks are
  capped at 64 KiB.
- **Actions**: Stop and Fire now map to OmO's own RPC requests
  (`eval_cells.stop`, `goal_continuation_fire_now`). The extension kills no
  process itself.

## Limits

- No Stop for monitors or background terminal sessions, and no continuation
  holds: OmO exposes neither over RPC.
- Eval cells need OmO's codemode. Without it, or while the agent process is
  stopped, the section shows the cells OmO last reported, without output or
  Stop.
- Background sessions come from OmO's terminal manifest, which OmO writes on
  start and exit; their command is shown but not their output.
- The service must run on the machine that runs antechamber, since it reads
  the run records.
