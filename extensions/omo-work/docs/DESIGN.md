# OmO Work: design

OmO Work is an OpenChamber 2.x Work Status section for the open session's work
that OpenChamber has no surface for: the todo list, the goal continuation timer
and other wake sources. Monitors, eval cells and background terminal sessions
are OpenChamber's own background commands, reported by antechamber as OpenCode
shells ([docs/architecture.md](../../../docs/architecture.md#omo-background-work-as-opencode-shells)),
so the section does not list them. This document covers its parts, its data, its security
boundary and its limits. Where each field comes from in OmO is documented in
[docs/architecture.md](../../../docs/architecture.md#omo-work-status-section).

## Parts

```
OpenChamber Work Status panel
  └─ section frame (status/index.html + status/main.js, sandboxed iframe)
       │ host.serviceRequest  GET /status, POST /goal/fire
       ▼
OpenChamber host ── loopback + OPENCHAMBER_SERVICE_TOKEN ──▶ service/main.js (Node, on the host)
                                                              │ reads <state dir>/run/<pid>.json
                                                              │ Bearer <run token>
                                                              ▼
                                         antechamber  /antechamber/work-status/<session>[...]
                                                              │ snapshot from its bridges,
                                                              ▼ goal RPC to OmO
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
| `live` | the session's agent process is running; Fire now needs it |
| `todo` | todo phases in OmO's order, each `{name, tasks: [{content, status}]}`, status `pending`, `in_progress`, `completed` or `cancelled` |
| `monitors` | live watches (newest first), then the five most recently ended, each with its last 20 matched lines and, once ended, a readable reason |
| `evalCells` | detached eval cells from `eval_cells.list`, or from the codemode wake source when the list is unavailable (`evalCellsListed: false`) |
| `background` | background terminal sessions whose process is alive |
| `goal` | the goal continuation timer (`armed`, `kind`, `dueAtMs`) and the wake-source counts it waits on, or `null` |
| `wakeSources` | other active wake sources without a dedicated view |

The frame shows `todo`, `goal` and `wakeSources`. `monitors`, `evalCells` and
`background` stay in the snapshot, and the adapter keeps its
`/antechamber/work-status/<session>/eval/<cell>[/stop]` routes, for section
versions installed before these moved to OpenChamber's background commands
(ZIP installs never update). The frame checks the envelope (`src/model.ts`) and
imports these types from the adapter, so a shape change on either side fails
the typecheck.

## Refresh

The frame polls `/status` one request at a time:

- every 1.5 s while anything it shows can change on its own (an armed timer,
  another wake source, a task in progress);
- every 5 s otherwise, and while the page is hidden;
- every 10 s after an error, keeping the last snapshot on screen with the
  error above it.

A session switch bumps a generation counter, so a late answer for the previous
session is dropped. Elapsed times and countdowns tick every second from the
snapshot without refetching.

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
- **Inputs**: session IDs must match `ses_[0-9A-Za-z]+`, in both the service
  and the adapter.
- **Actions**: Fire now maps to OmO's own RPC request
  (`goal_continuation_fire_now`). The extension kills no process itself.

## Limits

- No continuation holds: OmO does not publish them over RPC.
- The service must run on the machine that runs antechamber, since it reads
  the run records.
