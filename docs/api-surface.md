# OpenCode API surface consumed by OpenChamber

Inventory extracted from `reference/openchamber` (commit: shallow clone of
`main`, 2026-09-20). Sources:

- `packages/ui/src/sync/event-reducer.ts`: authoritative SSE event contract.
- `packages/ui/src/sync/session-actions.ts`, `bootstrap.ts`,
  `stores/globalSessions.ts`, `lib/api/`: SDK call sites via
  `@opencode-ai/sdk/v2`.

## REST/SDK methods used

### Sessions (core)

| SDK method | Purpose in OpenChamber | pi counterpart |
|---|---|---|
| `session.list` | session list per directory | scan pi `--session-dir` JSONL files. `Session.cost` is the session's own spend: the sum of its assistant messages' OmO `usage.cost.total`, set once history is loaded and refreshed on each assistant `message_end` (announced with `session.updated`). Subagent sessions carry their own cost and `parentID`; OpenChamber's work-status rollup sums the subtree, so a parent never includes child spend. |
| `session.create` | new session | spawn `pi --mode rpc` (fresh session) |
| `session.get` | session detail | RPC `get_state` |
| `session.update` | rename/archive/metadata | adapter-side title + `time.archived` (persisted in the registry; `archived=true/false` list filtering honored on `/session` and `/experimental/session`) |
| `session.delete` | delete session | kill process + remove session file |
| `session.messages` | load message history | RPC `get_messages` |
| `session.promptAsync` | send prompt (async) | RPC `prompt`. **Echo contract** (verified against OpenChamber's event-reducer): reuse the client's optimistic `messageID` from the body for the user message and emit `message.updated` + `message.part.updated` (user text part) so the optimistic insert reconciles in place instead of rendering twice. |
| `session.abort` | stop generation | RPC `abort` |
| `session.fork` | fork from a message | RPC `fork` / `get_fork_messages`; conversation-only fork backed by the agent's session tree (see docs/architecture.md) |
| `session.revert` / `session.unrevert` | undo/redo conversation context | backed by the agent's native session-tree navigation; conversation-only, never touches files on disk |
| `session.summarize` | compact context | RPC `compact`, which answers only after the summary is written (timeout 31 min, above OmO's 30 min cap). `compaction_start` sets `time.compacting` and marks an idle session busy; `compaction_end` adds a user message with a `compaction` part (shown as `/compact`) and an assistant `summary: true` message with the summary text. History rebuilds the same pair from `compaction` entries, keyed by `firstKeptEntryId`. |
| `session.status` | busy/idle map | derive from RPC events |
| `session.todo` | todo list rendering | bridged from the agent's todo tool (`src/todo-bridge.ts`) |
| `session.shell` | run shell in session ctx | RPC `bash`, with cancellation via `abort_bash` |
| `session.command` | slash commands | RPC `prompt` with `/cmd` or `get_commands`. OmO skips native title generation for a first prompt starting with `/`, so any `/cmd args` prompt also sends `sessionTitlePrompt: args`. |
| `session.share` / `session.unshare` | share links | unsupported, returns `400 UnsupportedError`, no pi/OmO equivalent |

### Permissions & questions

| SDK method | pi counterpart |
|---|---|
| `permission.list` / `permission.reply` | extension-UI sub-protocol (`select`/`confirm` requests) |
| `question.list` / `question.reply` / `question.reject` | structured extension-UI `question` requests plus legacy `input`/`select`/`confirm`/`editor` dialogs |
| v2 `form.list` / `form.get` / `form.reply` / `form.cancel` | same pending question registry, projected to native FormInfo |

#### Structured questions (OpenChamber 1.24.2)

`GET /question` returns pending v1 question cards. `POST /question/{id}/reply`
accepts ordered `answers: string[][]` and an optional `comment`. Known option
labels become native selections; custom answers become text. Empty arrays
leave questions unanswered. A comment alone can settle a request.
`POST /question/{id}/reject` cancels it. Replies return `200 true` only after
the native acknowledgment; unknown or settled IDs return 404, refused native
responses return 409, and malformed answers return 400.

The v1 stream emits `question.asked`, then exactly one `question.replied` or
`question.rejected` when the native question resolves. A nonblocking request
survives tool completion, turn completion, and agent idle; its presence keeps
the process from idle eviction but does not change the session's busy/idle
status. Native `question_updated` frames refresh stored deadlines and drafts.
Deadlines do not cause adapter-local settlement: native timeout is authoritative.
The native extension delivers the later answer to the agent; the adapter sends
only a correlated `extension_ui_response`, never another answer prompt.

#### Forms (OpenChamber 2.x)

| Route | Result |
|---|---|
| `GET /api/form` | `{location, data: FormInfo[]}` |
| `GET /api/session/{sessionID}/form` | `{data: FormInfo[]}` |
| `GET /api/session/{sessionID}/form/{formID}` | `{data: FormInfo & {state: {status: "pending"}}}` |
| `POST /api/session/{sessionID}/form/{formID}/reply` | `{answer: {q1: "A", q2: ["B"], comment: "..."}}`; 204 after native acknowledgment |
| `DELETE /api/session/{sessionID}/form/{formID}` | cancel; 204 after native acknowledgment |

Unknown or settled form IDs return 404, native refusals return 409, and malformed
answers return 400. The v2 stream emits `form.created` with `{form}`,
`form.replied` with `{id, sessionID, answer}`, and `form.cancelled` with
`{id, sessionID}`. It does not emit legacy `question.v2.*` events.

Forms use stable `frm_` IDs, canonical native question IDs as field keys,
string or multiselect fields with custom options, and an optional reserved
`comment` field for structured requests. Metadata carries the native request
ID, `waitForAnswer`, deadline, and any received draft. Legacy dialogs also
appear as forms, with their original native label/value response contract.
Stock OpenChamber 2.x treats forms as blocking UI requests; metadata alone
does not make it label a nonblocking native question as "answer later".

#### Restart scope

Revival installs live subscriptions before requesting `get_state`, then merges
`pendingQuestions` by stable native tool request ID. A new connection UI ID
replaces the old reply target without changing the question or form public ID.
Live settlements prevent stale snapshots from resurrecting cards.

Dormant/scanned-session dangling-question detection **without spawning** is
deliberately omitted. Global and per-session lists expose pending state from
live/revived sessions, not yet-unrevived JSONL files. Revive a session through
a native RPC operation or prompt to hydrate its cards. Durable native
settlements, including graceful-shutdown cancellation, are not reconstructed
as pending cards.

The native runtime currently skips a tool ID with an `ask-user:resumed` marker
even after a second crash. Repeated-crash recovery needs a companion native
fix; this adapter does not invent a reply target absent from native state.

### Project / config / misc

| SDK method | pi counterpart |
|---|---|
| `project.current` / `project.list` | adapter directory registry |
| `config.get` / `config.update` | adapter config (pi flags, session dirs) |
| `config.providers` | RPC `get_available_models` (translated) |
| `command.list` | RPC `get_commands` |
| `app.agents` | static pi agent descriptors: `build` plus pi's own agent name |
| `path.get`, `vcs.get`, `lsp.status`, `find.*`, `file.*` | filesystem/git direct (adapter-side) |
| `auth.set`, `provider.oauth`, `mcp.connect/disconnect` | stub or proxy to pi config |

## SSE event contract (event-reducer.ts)

The reducer handles exactly these `type` values; the adapter must emit
compatible payloads for the subset it supports:

```
server.connected            session.created           session.updated
session.deleted             session.status            session.idle
session.error               session.diff              message.updated
message.removed             message.part.updated      message.part.delta
message.part.removed        permission.asked          permission.replied
question.asked              question.replied          question.rejected
todo.updated                project.updated           vcs.branch.updated
lsp.updated                 server.instance.disposed  global.disposed
```

Implemented: `server.connected`, `session.created`, `session.updated`,
`session.status`, `session.idle`, `session.error`, `message.updated`,
`message.part.updated`, `message.part.delta`, `permission.asked`,
`permission.replied`, `question.asked`, `question.replied`,
`question.rejected`, `todo.updated`, `session.diff`. `project.updated`,
`vcs.branch.updated`, and `lsp.updated` are not emitted (no corresponding
pi/OmO signal is adapted).

## pi RPC → OpenCode event mapping (draft)

| pi stdout event | OpenCode SSE |
|---|---|
| `message_update` / `assistantMessageEvent: text_delta` | `message.part.delta` + `message.part.updated` |
| `assistantMessageEvent: toolcall_start/delta/end` | `message.part.updated` (tool part; pending `{raw}` accumulates the streamed JSON fragments, running carries parsed `arguments`, result lands at `turn_end`) |
| `turn_end` (`toolResults[]`) | `message.part.updated` (tool part, completed `{output}` or error per `isError`, matched by `toolCallId`) |
| `bash_execution_update` | unmapped; folded into tool parts above |
| turn start / turn end | `session.status` (busy) / `session.idle` |
| `extension_ui_request` (confirm/select/input) | `permission.asked` / `question.asked`, bridged through the approvals module (`src/approvals.ts`) |
| `extension_error` / RPC error response | `session.error` |
| `get_entries` / `get_tree` (polled or on fork) | `session.updated` |

Tool part `state` mirrors `@opencode-ai/sdk` v2 (1.18.31) `ToolState`:
a discriminated union on `.status` with `input`/`output`/`title` inside the
state object (verified against the locally installed
`dist/v2/gen/types.gen.d.ts`). Live-observed pi shapes (probe, 2026-09-21):
`toolcall_start {contentIndex, id, toolName}` →
`toolcall_delta {delta}` (JSON argument fragments) →
`toolcall_end {toolCall:{id, name, arguments}}` →
`turn_end {toolResults:[{toolCallId, content:[{type:"text",text}], isError}]}`.

## Open items

- [x] How OpenChamber launches the agent backend: it spawns
      `$OPENCODE_BINARY serve --hostname H --port P` (managed lifecycle in
      `packages/web/server/lib/opencode/lifecycle.js`), parses the stdout line
      `opencode server listening on <url>`, then health-checks
      `GET /global/health`. `settings.opencodeBinary` (settings.json) is the
      reliable override; combine with `OPENCHAMBER_DATA_DIR` for an isolated
      test profile.
- [ ] Payload field-level schemas for each event type (from
      `@opencode-ai/sdk/v2` types).
- [x] The UI uses `@opencode-ai/sdk/v2`; note the v2 surface differs from v1
      (`question.list` → `GET /question`, `permission.list` →
      `GET /permission`, session list → `GET /experimental/session`,
      `GET /path`, `GET /vcs` are all probed during bootstrap and must exist).

## Bootstrap probes observed live (OpenChamber 1.21.0)

These are called at startup and 404s surface as console errors or blocked
send ("provider or model not selected"):

| Endpoint | Minimum viable response |
|---|---|
| `GET /provider` | `{all: Provider[], default: {providerID: modelID}, connected: string[]}` |
| `GET /config/providers` | `{providers: Provider[], default: {...}}` |
| `GET /question` | `[]` |
| `GET /permission` | `[]` |
| `GET /lsp` | `[]` |
| `GET /formatter` | `[]` |
| `GET /experimental/session` | `Session[]` (all directories) |
| `GET /path` | `{home, state, config, worktree, directory}` |
| `GET /vcs` | `{}` or `{branch}` |
| `GET /agent` | primary agents: `build` + pi's own name (aliases for the same pi agent, so OpenChamber's `build` default resolves and the picker has options) |
| `GET /global/health` | any 200 JSON |

Gotcha: OpenChamber's model picker ignores `default` when it can't match it
and silently falls back to the **first listed provider/model**, so antechamber
sorts pi's active model to the front for this reason.
