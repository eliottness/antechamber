# Architecture

## Goal

OpenChamber talks to an OpenCode server over HTTP + SSE via
`@opencode-ai/sdk/v2`. The pi coding agent (and OmO, a pi-compatible
distribution) exposes headless operation via RPC mode (`pi --mode rpc`, JSONL
over stdin/stdout) and an in-process SDK (`AgentSession` from
`@earendil-works/pi-coding-agent`).

`antechamber` bridges the two:

```
OpenChamber ──HTTP/SSE (OpenCode API subset)──▶ antechamber ──JSONL stdio──▶ pi/omo --mode rpc
```

OpenChamber is configured to use an **external OpenCode server** pointing at
this adapter. No OpenChamber fork, no pi fork.

## Two backend strategies

| Strategy | Mechanism | Pros | Cons |
|---|---|---|---|
| SDK embed | `AgentSession` in-process | No subprocess overhead, typed API | Ties adapter lifecycle to pi internals |
| RPC subprocess | spawn `pi --mode rpc` per session | Process isolation, version-tolerant, language-stable protocol | One process per session, JSONL framing rules (LF-only) |

Default: **RPC subprocess** (pi documents strict JSONL framing; Node `readline`
is not compliant because it splits on U+2028/U+2029, so we split on `\n` only).
SDK embed stays an option behind the same internal interface.

RPC transport errors and stdout EOF close the client, reject pending requests,
and dispose the owned child process. A response correlated to the wrong command
is an upstream protocol error. A command timeout also closes the transport, so
the process cannot accept another operation whose native completion is unknown.
These boundaries are implemented in `src/pi-rpc.ts`.

## Mapping concerns

### Session model

- OpenCode: one server, many sessions, sessions belong to a directory/project.
- pi: one process per session; session persistence as JSONL files
  (`--session-dir`, `switch_session`, `fork`).
- Adapter owns a process pool keyed by session id, and a directory registry
  mapping OpenCode "project/directory" to pi working directory + session dir.

### OmO session tree

Fork/revert/unrevert use `get_entries` (`entries`, `leafId`) and OmO's
session-tree RPCs. Explicit-message `fork {entryId}` copies the history before
the selected user message. OpenChamber restores that prompt into its composer,
matching OmO's default `"before"` position; including an unanswered user tail
would make the UI report a failed reply. With no messageID, `position: "at"`
includes the complete active leaf. Fork returns `{cancelled}` (and sometimes `text`), not
the new identity: the connector reads `get_state.sessionId/sessionFile`.
The RPC process switches to that new file. It is transferred to the forked
OpenChamber session; the original becomes dormant and resumes its original
file in its own process when next used.

The connector records OpenChamber messageID -> OmO entry id in its registry,
preserving client-generated live IDs across restarts. Restored messages
without a recorded mapping use the existing `msg_r<JSONL offset>` scheme.
Revert navigates to the selected user's parent with `intent: "resume"`:
without that intent OmO's tree selection would skip user/custom-message
parents. The registry saves the previous leaf, current leaf, and cutoff
messageID. Repeated revert retains the original redo leaf. Unrevert restores
it; a new prompt clears the cutoff and starts a branch at the earlier leaf.
Revival reapplies the saved leaf rather than assuming the newest JSONL
message is the active branch. The reverted transcript is retained for redo.

Native progress is checkpointed at `agent_end`, successful `compaction_end`, and
process exit. Checkpoints advance only to descendants of the saved leaf.

The registry also stores the published part IDs in message order under each
stable message ID. On history reconstruction, those IDs are restored onto the
parsed parts so clients keep their live identities after a restart. History
with no saved mapping keeps the deterministic IDs derived from native entries.
Adapter-authored local cards are excluded from this mapping.

Fork admission holds the lifecycle slot across native tree navigation, client
transfer, and publication of the child owner. A concurrent create or revival
therefore cannot observe the in-flight transfer as an available process slot.

Revert only changes conversation context. It never invokes a filesystem
restore, snapshot, or diff operation. The adapter publishes the cutoff as
`session.revert` and adds no transcript card: OpenChamber renders its own
reverted-message dock from that field. Unknown messageIDs are rejected with
HTTP 400 before navigation.

History refreshes and compact/bash RPCs share the conversation-operation queue
with prompt, fork, revert and unrevert. A refresh cannot read an intermediate
navigation state or overwrite the cursor before its operation completes.
Cancellation releases only the caller's HTTP waiter; it does not release the
native operation's queue lease. If a queued shell is cancelled, it rejects
after its predecessor completes and before dispatching a bash RPC. A dispatched
operation retains the ordering barrier until its native reply or timeout. A
dispatched shell continues to use `abort_bash`.

Adapter-authored shell cards and notices are retained in canonical in-memory
history, not appended to the revert-notice projection. While reverted, new
cards are inserted before the hidden redo branch and belong to the last visible
user turn, so completed shell output remains rendered. Refresh, unrevert and a
replacement prompt retain these cards; they are never matched to OmO JSONL
entries or sent to the model. This retention lasts for the connector process,
not across connector restarts: adapter-only cards are not persisted transcripts.

### Event translation

| OpenCode (SSE `event`) | pi (stdout JSONL) |
|---|---|
| `message.updated` / `message.part.updated` | `message_update` (`assistantMessageEvent`: `text_delta` etc.) |
| `message.part.updated` (tool part) | `message_update` (`toolcall_start`/`toolcall_delta`/`toolcall_end`) + `turn_end` (`toolResults[]` by `toolCallId`) |
| `session.status` / `session.idle` | turn lifecycle events (`agent_start`/`agent_end`-family) |
| `permission.asked` | pi extension-UI sub-protocol (`extension_ui_request`/`extension_ui_response`); semantics differ, map conservatively |
| `session.error` | `extension_error`, RPC error responses |

V1 prompt bodies retain supported text, file, and agent parts. Inline image
data becomes native image input, inline text files become prompt text, and
agent mentions become `@name` text; unsupported inline attachment MIME types
return 400. Slash-command file parts use the same adaptation. V1 `delivery`
defaults to `steer` and can select `queue`, which maps to native
`streamingBehavior: followUp`.

For text and reasoning, the adapter emits the v1 `message.part.delta` before
the authoritative `message.part.updated` snapshot; the snapshot does not
repeat the append delta. This preserves a single append in clients that also
replace their cached part from snapshots.

V2 failed steps publish usage and error data on `session.step.failed` with
`rawFinish: "error"`, followed by `session.execution.failed`. User
interruptions publish `session.execution.interrupted` with `reason: "user"`.
Successful executions use `session.execution.succeeded`; failed or interrupted
executions do not later publish a success terminal. These transitions are
translated in `src/v2.ts`.

When the RPC process exits during a turn, the adapter finalizes streaming text,
reasoning, and tool parts before publishing the session error and idle status.
This prevents cards from remaining in a running state after process exit
(`src/sessions.ts`, `src/pi-event-translation.ts`).

The v1 asynchronous prompt route keeps its HTTP 204 contract. If prompt submission
rejects, including a registry write before RPC dispatch, it emits `session.error`
and appends an assistant error message to canonical session history. The error
name and message are available through both SSE and the message GET route; a
failed disk write does not depend on another successful disk write to report
the failure. These adapter-authored error cards have the in-memory retention
described above, not restart durability.

### Shutdown ownership

The connector owns its per-session RPC process groups. It also owns detached
task-host shards for parent sessions it **created**, including forks. It does
not claim task hosts for sessions discovered/restored from another OmO client.
The registry saves `connectorOwned: true` for new sessions and forks so this
ownership survives connector restart. Unmarked legacy/discovered sessions are
not retroactively claimed.
Created session IDs remain tracked after removal or idle reaping, so their
private hosts are still covered by final connector shutdown.

This is a split ownership decision based on the installed OmO implementation
inspected on October 13, 2026:

- `omo-ai/plugin/extensions/omo-task.js`, bundled functions `P2`, `A2`, `nI`
  and `bq`: a root task shard is `p-<key>.sock`, where `key` is the first
  16 hex characters of SHA-256 of `"p:" + parentSessionId`. Nested children
  inherit `shard_key` and attach to that same parent tree. Independent parent
  sessions get different shards, even within one project. The sidecar records
  `owner_session_id`, `owner_session_file` and participating task stores.
- `@code-yeongyu/senpi/dist/modes/rpc/host-ensure-start.js:51-64` detaches
  the supervisor. `host-lifecycle.js:362-393` spawns its engine without
  detaching it again; both therefore belong to the supervisor's process group.
  `host-lifecycle-policy.js:1-7` defines the default 15-minute idle window.
  The general host mechanism can serve multiple clients; that alone does not
  make a connector-created parent shard shared with unrelated parent sessions.
- `omo-ai/plugin/runtime/lsp-daemon/dist/paths.js:43-66` keys the LSP
  endpoint by HOME (or its explicit daemon-directory override) and package
  version, not by a session or project. `request-routing.js:12-29,70-81`
  supplies per-request context to the same daemon.
  `ensure-daemon.js:22-36,100-122` probes/reuses it and detaches only on
  startup. Killing it would interrupt other OmO sessions/projects.
  `daemon-server.js:11-15,74-89` actually specifies **30 idle minutes**,
  with connections and LSP clients preventing expiry. It is not the task
  supervisor's 15-minute policy. `index.js:565-582` also detaches the daemon's
  language servers; their observed parent ancestry, not just one process group,
  establishes that they belong to the same shared LSP infrastructure.

After its RPC groups stop, the connector finds private supervisors by the
exact shard basename derived from a newly created session ID plus that
session's working directory. It requires a detached group leader and records
Linux PID start times before signalling that group. Shutdown subscribes to
member death, sends SIGTERM, and escalates after five seconds with a ten-second
deadline. It refuses to signal any observed member of `openchamber.service`.
No broad command-line kill is used. The real-process regression proves that a
different session's supervisor and engine in the same directory stay alive.
Linux `/proc` and GNU `tail --pid` are required for this deployment's teardown.

The smoke assertion runs **before any harness termination**. Surviving RPC
groups, private task hosts and unknown processes fail immediately. Only the
shared LSP daemon and its observed descendants, outside recorded RPC groups, are reported as
`NON-CONNECTOR OmO-owned, outside connector scope`, with PID and command line.
That report is not evidence of connector teardown. The harness later cleans
its private HOME's helpers in its separate `finally` cleanup; cleanup can
never turn a failed shutdown assertion into a PASS.

### User shell cancellation and extension commands

The installed OmO RPC exposes two different abort commands. `abort` acknowledges
an agent-turn interruption but does not stop a user `bash` RPC. `abort_bash`
aborts the active user-shell execution. Probes on 2026-10-13 with
`omo --mode rpc --no-session --model anthropic/claude-haiku-4-5` observed:

- `abort` returned `{success: true}` while the same OS `sleep 600` process
  remained alive and the bash request remained unanswered.
- In a separate probe, `abort_bash` returned `{success: true}` and the pending
  bash returned `{output: "", cancelled: true, truncated: false}` within
  10 milliseconds. Both observed sleep PIDs were gone after `abort_bash`.
  A cancelled result can omit `exitCode`; the adapter normalizes it to `null`.

The connector dispatches `abort_bash` for an active shell before ordinary
`abort`, releases its correlated bash waiter immediately, and emits an error
tool state with `metadata.cancelled: true` and `Command cancelled`. The composer
returns to idle without waiting for the 60-second transport deadline. Removing
the correlation and its timeout prevents a late response from completing or
duplicating the cancelled card, reloading history, or changing a resumed turn.
The same abort signal covers the follow-up history and navigation RPCs, so
Stop also releases a shell whose bash result arrived but whose history refresh
is still pending. Aborted refresh replies are discarded before history mutation.
The adapter dispatch is not itself proof that an arbitrary remote shell has
stopped; the real local OmO probe and manual QA check the OS process as well.

Print-only extension commands do not necessarily emit `agent_start` or
`agent_end`. The real `get_commands` catalog includes `/ttsr`, which reports
its status through `extension_ui_request {method: "notify"}` and returns
`prompt {success: true, data: {disposition: "handled"}}`. The connector renders
notifications received during a slash invocation as assistant text and treats
that handled response as completion, returning the session to idle. Prompts
that start an agent turn still use the agent lifecycle events for completion.

This is a connector-only mapping of the installed OmO protocol, not a change
to OmO or its settings.

### Background monitors

OpenChamber has no surface for an agent's background watches, but it already
lists child sessions under Subagents and gives each sidebar row a live dot.
The connector therefore shows each OmO terminal monitor as a read-only child
session of the session that started it: `busy` while the watch is live, `idle`
once it ends. Its transcript is one `bash` tool card holding the watched
command, the filter, the event count and how the watch ended. The parent
session's own status is untouched, so the composer, queued messages, fork and
revert keep working while a watch waits. A live watch does keep the parent's
agent process out of idle eviction (`ANTECHAMBER_IDLE_TIMEOUT_MS`), because
evicting it would stop the watch.

Evidence, from the installed `@code-yeongyu/senpi` bundle inspected on
October 15, 2026:

- `core/extensions/builtin/terminal/extension-state.js` (`bundleSinks`) sends
  `pi.rpc.emit("terminal_monitor_state", {activeCount, monitors})` on every
  monitor change and fire, and `pi.rpc.emit("terminal_monitor_ended", event)`
  when one ends. `session-bundle.js` (`bind`) re-publishes the snapshot when
  the terminal bundle binds, so a revived session reports its restored
  persistent watches again.
- `modes/rpc/connection-handler.js` forwards those as
  `{type: "extension_event", name, data}` only to clients that advertise the
  `extension_events` capability, which the connector now does.
- `core/extensions/builtin/monitor-state-event.js` defines the ended reasons
  `exit`, `timeout`, `killed` and `disposed`.
- Background bash sessions (`terminal-background-sessions`) are published
  only on OmO's in-process event bus, not over RPC, so they are not shown yet.

Monitor child sessions live only in memory, like adapter-authored cards. A
watch the user deletes is not recreated by a later snapshot. When the agent
process exits, its watches are marked ended.

### MCP status and authorization

OpenChamber scopes MCP calls by directory, while OmO owns MCP per session
process. The connector answers them from the most recently used session in the
directory that has a running agent. It never revives a dormant session for MCP,
and a status read does not itself refresh the idle timer (only agent events do). Evidence below is from the
installed `@code-yeongyu/senpi` 2026.10.13 bundle (omo-ai 5.1.33); it is covered
by the hermetic fixture `test/fixtures/mcp-omo.mjs`, not by a dated live probe.

- `get_loaded_surfaces` returns `mcpServers: [{name, toolCount, status,
  authStatus}]` (`dist/modes/rpc/rpc-types.d.ts`, `connection-handler.js`). The
  status is the connection state or the config state (`idle`, `connected`,
  `needs_auth`, `disabled`, `untrusted`, ...). Lazy `idle` servers are usable and
  map to OpenCode `connected`. An OAuth server with `authStatus: "notLoggedIn"`
  that is not connected maps to `needs_auth`.
- No MCP RPC exists for authorization. The `/mcp` extension command
  (`core/extensions/builtin/mcp/commands.js`, `auth/commands-auth.js`) runs the
  interactive flow when the runner has a UI context, which RPC mode does. It
  binds a `127.0.0.1` loopback listener, launches the browser with `xdg-open`
  (or `open`), and records the URL as `appendEntry("mcp-auth", "Open this URL to
  authorize <name>:\n<url>")`. That append is published as an `entry_appended`
  event. OmO then exchanges the code itself, reconnects the server and
  reattaches MCP tools to the session. The listener gives up after 5 minutes.
- An extension command dispatched by `prompt` runs before the turn gate
  (`core/agent-session.js` `_prompt`). It does not create a user message or
  an LLM turn, and without a `clientMessageId` it writes no admission entry
  (`modes/rpc/client-admissions.js`). The `prompt` response arrives only after
  the handler returns, so the connector gives it a 10-minute transport budget.
  It sends the command outside the conversation queue and holds the session
  active so the reaper cannot stop the listener. Before sending, it checks
  `get_commands` for the extension command `mcp`, so a missing command can never
  reach the model as prompt text. Handler failures arrive as `notify` errors.
- The `mcp-auth` entries persist in the session JSONL as custom entries. They
  are not LLM context, and history rebuilding does not render them.
- The headless pair documented in `docs/mcp.md` ("Auth") is `/mcp auth-start
  <name>` followed by `/mcp auth-complete <name> <redirect-url>`. `auth-start`
  opens no listener and no browser. Its authorization request carries
  `redirect_uri` (the `mcp.oauthCallbackUrl` setting, else
  `http://127.0.0.1:0/callback`) and a single-use `state` that only the same
  process can consume (`auth/oauth.js` `completeAuthorization`, `consumeState`).
  `/mcp auth` parks the same pending state, instead of listening, when
  `mcp.oauthCallbackUrl` is set (`auth/callback.js` `openCallbackChannel`).
  OpenChamber sends only the bare `code`, so the connector rebuilds
  `redirect_uri?code=…&state=…` from the authorization URL it saw. It runs
  `auth-complete` in the session that started the flow, and drops the attempt
  if that session's agent changed or 10 minutes have passed.
- A code that arrives while `/mcp auth` is still waiting on its loopback
  listener is delivered to that listener as the browser's redirect would be.
  The connector always runs on the same host as its agent. This covers a
  browser that cannot reach the loopback port: the user pastes the failed
  redirect URL or its code instead. OmO validates the state, and a rejected
  redirect is reported without waiting for the listener to time out.
- OpenChamber 2.x has no MCP auth routes. It signs in through `mcp_*`
  integrations (`IntegrationInfo` with `metadata.source: "mcp"`) and the attempt
  protocol `connect/oauth`, `connect/oauth/{attemptID}`, `.../complete`. The
  connector serves these with `auth-start` (`mode: "code"`, so the UI shows its
  paste box) and `auth-complete`. Providers settings already hide `mcp_*`
  integrations. A completed sign-in emits `mcp.status.changed`, which makes
  OpenChamber re-read `/api/mcp`.

Limitations: one-click `/mcp auth` needs a browser that can reach OmO's
loopback port; otherwise the user pastes the code. Point `mcp.oauthCallbackUrl`
at OpenChamber's `/mcp/oauth/callback` to complete remote sign-ins without
pasting. When OpenChamber opens the URL itself and OmO's `xdg-open` also
works, two tabs may open. OpenChamber 2.3.2 shows the sign-in only on the MCP
settings page, and that page lists servers from OpenCode config files, so
servers defined only in OmO get status there but no sign-in button. Tokens are
stored globally, but other live sessions in the directory keep their own MCP
connections until they reconnect.

### Capability gaps to decide explicitly

- **Permissions/questions**: OpenCode has permission prompts and elicitation;
  pi handles interactive prompts through its extension-UI protocol. The
  adapter must map or auto-resolve these deterministically.
- **Todos / file diffs**: OpenCode exposes todo and file-diff state that
  OpenChamber renders. pi emits tool-call events; the adapter reconstructs
  file-change state from edit/write tool calls.
- **Models/providers**: OpenCode `/provider` and `/config` endpoints vs pi's
  `get_available_models` / `set_model`. Adapter translates at the boundary.
- **Compaction**: pi `compact` / `set_auto_compaction` ↔ OpenCode
  `session.summarize`.

## Reference sources

Upstream repos are shallow-cloned into `reference/` (gitignored) for local
inspection:

- `reference/openchamber`: https://github.com/openchamber/openchamber
- `reference/pi-mono`: https://github.com/badlogic/pi-mono
