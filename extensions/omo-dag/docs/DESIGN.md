# OmO Graph — design

## Surfaces used

| OpenChamber SDK surface | Used for |
|---|---|
| `contributes.panel` (rail) + `contributes.page` | the graph, docked or full screen |
| `capabilities: ["sessions"]` | `onSession` to follow the open chat, `openSession` to jump to a node |
| `contributes.service` | a read-only Node process that reads the OmO task store |
| `onSessionLifecycle` | refresh right after a turn starts/ends |
| `setBadge` | number of running sub-agents on the rail icon |
| `storage` | the optional data-path overrides |

The panel is a sandboxed iframe with no filesystem or network access. The
`filesystem` capability could read `~/.omo/agent/**` directly, but one graph
needs ~100 small JSON files plus a directory scan per refresh; the service
does that in ~2 ms with an mtime cache and returns one JSON document.

## Data sources

1. **OmO task records**: `<agentDir>/projects/*/senpi-task/tasks/st_*.json`,
   plus every store listed in `<agentDir>/rpc/task-stores.json`. Fields used:
   `task_id`, `status`, `parent_session_id`, `root_session_id`,
   `child_session_id`, `host_session.session_path`, `task_summary` /
   `description` / `name`, `agent_type` / `category`, `model`, the
   `created_at` / `started_at` / `terminal_at` timestamps,
   `final_response`, `error_message`, `run_stats`, `spawn_spec.prompt`.
2. **Connector registry**: `<stateDir>/sessions.json`, mapping OpenChamber
   session ids to OmO session ids and titles. For a sub-agent it also keeps
   `task.details` (status, summary, category, model, `run_stats`,
   `final_response`), `task.input` and `task.terminalAt`.

OmO disposes a task's own `st_*.json` once its run is over, so for an older run
the registry is the only surviving record of most sub-agents. Run members the
task files no longer describe are rebuilt from their registry entry, which
carries its own timestamps: the end is when the connector saw the task finish,
and the start is that end minus the recorded duration. A live task record always
wins over the registry copy.

Task discovery reads regular `.json` files and skips directories and symlinks.
The service resolves configured root spellings before using them as cache
keys; its recency-updated task-store cache holds at most 32 root sets. Graph
responses are capped at 1,000,000 serialized characters. If the full graph
exceeds that bound, the service keeps the root and a valid task prefix, removes
edges to omitted tasks, and returns `truncated.omittedNodes`; the panel
validates that field and displays the count.

The connector names root sessions `ses_<md5(piSessionId)>` (`ocIdFor` in
`src/session-store.ts`). Sub-agent links use their recorded registry ID when
available. Unregistered tasks use `ses_<md5(task_id)>` while the task ID has
one parent, or `ses_<md5(parent_session_id + ":" + task_id)>` when it collides
across parents. Discovery retains both colliding task records, and the graph
uses the same identity rules so `openSession` opens the correct child.
Legacy deletion tombstones retain their owning parent's bare identity, even
when they predate task metadata in the registry.

## Graph model (`src/graph.ts`)

- **Run**: every task whose `root_session_id` equals the resolved root, plus
  every registry sub-agent whose `parentPiId` is the root or a session owned by
  a member already found. The
  root is resolved from the open session: it is either a root itself, a
  sub-agent (resolved through its parent-qualified identity or registry), or a
  registry entry.
- **Spawn edges**: `parent_session_id` → task. A task launched from inside a
  sub-agent has that sub-agent's own session id as its parent (its
  `child_session_id`, the session UUID inside `host_session.session_path`, or
  its task id). That makes it a nested node.
- **Uses edges** (dashed): a task's prompt names another task of the same run
  (`st_…` or `agent://st_…`) that was created before it. This is how OmO
  workflows pass an upstream result to a dependent. OmO does not store
  workflow edges on disk, so the graph draws nothing it cannot see. In
  particular it does not invent dependencies from timing.
- **Waves / columns**: per spawn parent, a task moves one wave to the right
  of every sibling that had finished before it was created, and to the right
  of anything it uses. Siblings launched together share a wave. This matches
  how a `parallel(…)` wave, then a dependent wave, shows up in the records.
- **State**: `running`/`starting` → running, `queued`/`pending`/`suspended` →
  queued, `completed`, `failed`/`error`/`lost`/`denied`/`plan_error` →
  failed, `cancelled`/`canceled`/`killed` → cancelled. The raw status is kept
  for the label, so `lost` reads as `lost`.

## Layout (`src/layout.ts`)

Columns are fixed-width, and panel CSS dimensions come from the same card-size
constants used by the layout. Within a column, cards stack in the order of their
parents' rows, then by creation time, so a fan-out stays next to the card
that launched it. The orchestrator is centred on its direct children. Edges
leave a card's right side and enter the left side as horizontal cubic
Béziers. Several edges sharing one side are spread over the card's middle
band (Archify's "spread shared endpoints deterministically" rule) instead of
piling onto one point.

## Interaction (`src/panel.ts`, `panel/index.html`)

- Hover or focus a card: direct inputs (amber) and outputs (accent) are fully
  lit, the transitive upstream/downstream reach stays half-lit, and
  everything else dims. The inspector strip shows the full facts.
- Click (not after a drag): `openSession(node.sessionId)`.
- Running nodes: pulsing dot, glow, a ticking duration, and a moving pulse
  along their incoming edge. The live wave's label is underlined.
- Refresh: every 1.5 s while anything is running or queued, otherwise every
  5 s. Polling pauses while the panel is hidden. The DOM is only rebuilt when
  the response body changes, and cards are reused, so hover state survives
  updates.
- All colours come from the host theme tokens (`--oc-*`), so light and dark
  follow OpenChamber. `prefers-reduced-motion` turns off the pulses.

## Security boundary

- The service only reads. It exposes `GET /health` and
  `GET /graph?session=ses_…`, checks the host bearer token on every request,
  and binds to `127.0.0.1` on the port the host assigns.
- The optional `agentDir` / `stateDir` query parameters let the panel point
  it at other directories. It reads only `*.json` task records and
  `sessions.json` under them. The service runs with the user's permissions
  (OpenChamber's approval dialog says so), so this is not a sandbox. It just
  keeps the surface small.
- Prompts and final responses stay local. They reach only the panel the user
  opened.

## Known limits

- Dependencies inside a workflow that are not visible in a prompt are not
  drawn. Those tasks appear in waves by timing only. Recording workflow edges
  in OmO (or in the connector's registry) would let the graph draw them
  exactly.
- The graph covers OmO tasks. Plain pi sessions without sub-agents show
  "No sub-agents yet".
