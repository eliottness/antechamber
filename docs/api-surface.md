# OpenCode API surface implemented by antechamber

Supported frontend: **OpenChamber 2.3.2+**. The caller audit uses the 2.3.2 and
2.7.0 source trees and installed 2.5.3 build. OpenChamber 2.x uses the
`@opencode/client` `/api/*` contract; unprefixed routes listed here remain
only for verified compatibility probes or uncertain callers.

The HTTP inventory below is maintained against `src/routes-v1.ts`,
`src/routes-v2.ts`, `src/misc-routes.ts`, and `src/server.ts`. Each row gives
the successful status and response shape; resource-dependent 4xx responses
are called out where they are part of the contract. JSON is returned unless a
row says `204`, `SSE`, or `WebSocket`. Requests also pass through the shared
authentication, origin, body-size, and JSON validation in `src/http.ts`;
WebSocket upgrades use the shared authentication and origin checks.

## HTTP route inventory

Static rows use the format consumed by the OmO route smoke. Parameterized
routes use separate method and path columns so the smoke does not probe
invented resource IDs.

### Static HTTP routes

| Route | Success | Response or behavior |
|---|---:|---|
| `GET /global/health` | 200 | JSON `{healthy: true}` and optional configured compatibility `version`. |
| `GET /global/upgrade` | 409 | `UnsupportedError`; use the `upgrade` CLI command. static-only. |
| `GET /skill` | 200 | Empty array; skill inventory is unavailable. |
| `GET /formatter` | 200 | Empty array; formatter inventory is unavailable. |
| `GET /mcp` | 200 | `{name: McpStatus}` from RPC `get_loaded_surfaces` on the most recently used live session in the directory, else on the most recently used live session in any directory, else on a short-lived `--no-session` agent started for the read (cached 30 s); empty object only when that agent cannot start or OmO has no such RPC. |
| `GET /file` | 200 | Directory entries confined to the selected session directory. |
| `GET /api/info` | 200 | OpenCode API version, process ID, server URL, and temporary path. |
| `GET /api/location` | 200 | Current directory and project location. |
| `GET /api/config` | 200 | Bare `ConfigEntry[]` (OpenCode 2.x contract): one `{type: "document", path: "antechamber", info: {default_agent}}` entry that OpenChamber folds with `mergeConfigDocuments`. |
| `GET /api/shell` | 200 | `{location, data: Shell.Info[]}`: OmO's running background work in the directory (terminal monitors, background terminal sessions, detached eval cells) as OpenCode shells, `metadata.sessionID` naming the session. See [OmO background work as shells](architecture.md#omo-background-work-as-opencode-shells). |
| `GET /api/websearch/provider` | 200 | `{location, data: []}`; no web-search providers are configured through antechamber. |
| `GET /api/provider` | 200 | `{location, data: Provider[]}` from the agent catalog. |
| `GET /api/model` | 200 | `{location, data: Model[]}` from the agent catalog; repeated `types` (`chat`, `image`) filter by output capability, so an image-only request returns `[]` unless OmO exposes an image-output model. |
| `GET /api/debug/location` | 200 | Bare `[]`: antechamber keeps no persistent per-location service instances. |
| `GET /api/experimental/usage/limits` | 200 | `{location, data: null}`, as OpenCode answers without a Console login; antechamber has no Console budget. |
| `POST /api/experimental/fs/watch` | 204 | Takes or renews a 24-hour lease on a file inside the selected directory, as OpenCode 2.2.5 does; at most 256 per directory (the oldest is dropped). 404 `FileNotFoundError` if it is missing, 400 outside the directory. Edits and removal emit `filesystem.changed {file, event: "change" \| "unlink"}`; an atomic save keeps the watch, and a removed file keeps its lease and reports `change` when it is created again. |
| `DELETE /api/experimental/fs/watch` | 204 | Ends the lease for the submitted path (a symlink or a removed file included), however often it was renewed. |
| `POST /api/experimental/generate/text` | 200 | `{data: {text}}` from a one-off `--no-session --no-tools` OmO turn, the model chosen with `--provider`/`--model` at start so OmO's saved default is never changed. One deadline covers the whole run; at most two run at once (503 `ServiceUnavailableError` beyond); a caller that disconnects, or server stop, ends it. 400 for an invalid request, 503 if OmO cannot generate. |
| `GET /api/model/default` | 200 | `{location, data: Model \| null}` for the active model, same `variants` shape. |
| `GET /api/agent` | 200 | `{location, data: Agent[]}`; the default model and thinking level are `model: {id, providerID, variant?}`. |
| `GET /api/command` | 200 | `{location, data: Command[]}`. |
| `GET /api/skill` | 200 | `{location, data: []}`; skill inventory is unavailable. |
| `DELETE /api/debug/location` | 204 | Empty, as OpenCode answers. OpenChamber evicts a location after git worktree changes; antechamber keeps no per-location instance, so there is nothing to evict. |
| `GET /api/credential` | 200 | `{location, data: []}`; no credentials are retained. |
| `POST /api/credential` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| `GET /api/integration` | 200 | `{location, data: IntegrationInfo[]}`: one `mcp_{name}` integration (`metadata.source: "mcp"`, one `oauth` method) per OAuth-capable OmO MCP server, read like `GET /api/mcp`. Providers are not integrations here. |
| `GET /api/plugin` | 200 | `{location, data: []}`; no OpenCode plugins are loaded by OmO. |
| `POST /api/plugin/check` | 200 | Read-only update query returning `{location, data: []}`; there are no plugins to check. |
| `POST /api/plugin/update` | 400 | `UnsupportedError`; plugin updates are unavailable with OmO. Unsupported. |
| `POST /api/experimental/generate` | 503 | `{_tag: "ServiceUnavailableError", message: "No generation model is available through antechamber/OmO", service: "opencode"}`. |
| `GET /api/experimental/session/stats` | 400 | `UnsupportedError`; session statistics are unavailable with OmO. Unsupported. |
| `GET /api/mcp` | 200 | `{location, data: McpServer[]}` (`name`, v2 `status`, `integrationID` for OAuth-capable servers) from RPC `get_loaded_surfaces` on the newest live session in the directory, else in any directory, else on a short-lived `--no-session` agent started for the read (cached 30 s). A new chat, a dormant project and a just-started adapter therefore list the servers too. |
| `POST /api/mcp` | 400 | `UnsupportedError`; MCP is unavailable with OmO. Unsupported. |
| `DELETE /api/mcp` | 400 | `UnsupportedError`; MCP is unavailable with OmO. Unsupported. |
| `GET /api/fs/find` | 200 | `{location, data: [{path, type: "file" \| "directory"}]}`; `type=directory` returns matching directories, including ancestors of matching files, with a trailing slash. |
| `GET /api/project` | 200 | Project records for the default directory and directories with restorable sessions. |
| `GET /api/permission/request` | 200 | `{location, data: Permission[]}` for the selected directory, in OpenCode 2.2.5's v2 shape: `action`, `resources`, `save`, `metadata` and, for a tool request, `source: {type: "tool", messageID, id}`. `save` lists only the scope OmO stores on "Allow always" (the displayed patterns for read, edit, list and glob; `*` for grep and eval) and is empty for scopes OmO's UI frame does not expose. |
| `GET /api/question/request` | 200 | `{location, data: Question[]}`. |
| `GET /api/permission/saved` | 200 | `{data: []}`; saved permissions are unavailable. |
| `GET /api/form` | 200 | `{location, data: FormInfo[]}` for pending questions owned by sessions in the selected directory. |
| `POST /api/vcs/init` | 204 | Initializes a Git repository in the selected directory. |
| `GET /api/vcs` | 200 | `{location, data: {provider: "git", branch}}`. |
| `GET /api/vcs/base` | 200 | OpenCode 2.0.28 `VcsBaseOutput`: `{location, data: {name, ref, source: "reflog" \| "default"} \| null}`. Resolves the checkout source branch from HEAD's reflog, then origin's default branch, then main/master; `ref` is its commit ID. Null outside Git, before the first commit, or when no base can be found. |
| `GET /api/vcs/status` | 200 | OpenCode 2.0.28 `VcsStatusOutput`: `{location, data: [{file, additions, deletions, status: "added" \| "deleted" \| "modified"}]}`. Git index/worktree and untracked files, with net HEAD line counts (binary counts are zero); cancelled staged/unstaged changes remain listed. Empty outside Git. All four VCS read routes use the same directory selectors as `/api/vcs`, run read-only Git with optional locks disabled, and cap each command at 5 seconds / 16 MiB (combined patches also at 16 MiB); invalid queries or Git failures return 400 `{name: "BadRequestError", data: {message}}`, not empty success. |
| `GET /api/vcs/branch` | 200 | OpenCode 2.0.28 `VcsBranchListOutput`: `{location, data: string[]}` of sorted local branch names; optional substring `search` and non-negative integer `limit` (default 100). Empty outside Git. |
| `GET /api/vcs/diff` | 200 | OpenCode 2.0.28 `VcsDiffOutput`: `{location, data: [{file, patch, additions, deletions, status: "added" \| "deleted" \| "modified"}]}`. Required `mode=working` compares HEAD to the worktree; `branch` compares the merge-base to the worktree (both include untracked files); `committed` compares the merge-base to HEAD. Optional `base` selects a commit for branch/committed (otherwise the detected base); `context` is a non-negative integer (default 3). Empty outside Git. |
| `GET /api/session` | 200 | `{data: Session[], cursor: {previous, next}}`; supports location, search, parent (`parentID=null` selects root sessions), `archived` (`false` live only, `true` archived only), order, cursor, and limit. |
| `POST /api/session` | 200 | `{data: Session}`; validates the requested location, model, agent, ID, and metadata. |
| `GET /api/session/active` | 200 | `{data: Record<sessionID, {type: "running"}>}`. |

### Parameterized HTTP routes

| Method | Path | Success | Response or behavior |
|---|---|---:|---|
| GET | `/session/{sessionID}/message/{messageID}` | 200 | One message; 404 if unknown. |
| GET | `/session/{sessionID}/children` | 200 | Direct child sessions. |
| GET | `/session/{sessionID}/diff` | 200 | Unified diff for the session. |
| POST | `/mcp/{name}/auth` | 200 | `{authorizationUrl, oauthState}` announced by OmO's native `/mcp auth {name}` in the directory's live session, else in an agent started for this flow alone; the flow then finishes inside OmO (loopback callback, token exchange, reconnect). 400 when that agent cannot start, on an OmO error or when no URL appears within 30 s; 404 for an unknown server. |
| POST | `/mcp/{name}/auth/authenticate` | 200 | `McpStatus` after the same native flow completes (OmO opens the browser itself); joins a flow already running for that server. Same errors as `/mcp/{name}/auth`, plus 400 when OmO parked the flow for a pasted code. Both routes return 409 while a different auth flow for the server is running in the same agent; concurrent identical requests share one flow. |
| POST or DELETE | `/mcp/{name}/connect`, `/mcp/{name}/disconnect`, DELETE `/mcp/{name}/auth` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/mcp/{name}/auth/callback` | 200 | `McpStatus` once `{code}` (a bare code or the whole redirect URL) finishes the pending flow. A flow still waiting on OmO's loopback listener receives the redirect there; a parked flow (`mcp.oauthCallbackUrl` set) is finished with `/mcp auth-complete {name} {redirect}`. A bare code is rebuilt from the authorization request's `redirect_uri` and `state`. 400 when nothing is pending or OmO rejects the response. |
| GET | `/api/agent/{agentID}` | 200 | `{location, data: Agent}`; 404 for an unknown agent. |
| PATCH | `/api/project/{projectID}` | 400 | `UnsupportedError`; project updates are unavailable with OmO. Unsupported. |
| DELETE | `/api/credential/{credentialID}` | 204 | Idempotent no-op; no credentials are retained. |
| PATCH | `/api/credential/{credentialID}` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| POST | `/api/credential/{credentialID}/activate` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| GET | `/api/integration/mcp_{name}` | 200 | `{location, data: IntegrationInfo}` for an OAuth-capable OmO MCP server; 404 otherwise. |
| POST | `/api/integration/mcp_{name}/connect/oauth` | 200 | `{location, data: IntegrationAttempt}` with `mode: "code"`: runs OmO's headless `/mcp auth-start {name}` (in the directory's live session, else in an agent started for this attempt and stopped when it completes, is cancelled or expires) and returns its authorization URL. |
| GET | `/api/integration/mcp_{name}/connect/oauth/{attemptID}` | 200 | `{location, data: IntegrationAttemptStatus}` (`pending`, `complete`, `failed`, `expired` after 10 min); 404 for an unknown attempt. |
| POST | `/api/integration/mcp_{name}/connect/oauth/{attemptID}/complete` | 204 | `{code}` (bare code or redirect URL) is finished with `/mcp auth-complete {name} {redirect}` in the session that started it; 400 when OmO rejects it, 404 for an unknown attempt. |
| DELETE | `/api/integration/mcp_{name}/connect/oauth/{attemptID}` | 204 | Forgets the attempt; OmO's parked state is replaced by the next start. |
| GET | `/api/integration/{integrationID}` | 404 | `NotFoundError` for any other integration. |
| POST | `/api/integration/{integrationID}/connect/key` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| POST | `/api/integration/{integrationID}/connect/external` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| POST | `/api/integration/{integrationID}/connect/oauth` (non-MCP) | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| GET | `/api/integration/{integrationID}/connect/oauth/{attemptID}` (non-MCP) | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| DELETE | `/api/integration/{integrationID}/connect/oauth/{attemptID}` (non-MCP) | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| POST | `/api/integration/{integrationID}/connect/oauth/{attemptID}/complete` (non-MCP) | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| POST | `/api/integration/{integrationID}/connect/command` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| GET | `/api/integration/{integrationID}/connect/command/{attemptID}` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| DELETE | `/api/integration/{integrationID}/connect/command/{attemptID}` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| DELETE | `/api/permission/saved/{permissionID}` | 204 | No saved-permission state is retained. |
| GET | `/api/session/{sessionID}` | 200 | `{data: Session}`; 404 if unknown. |
| PATCH | `/api/session/{sessionID}` | 204 | Updates title, archive state, or metadata. Archive accepts OpenCode 2.1's `archived: boolean` (repeating the current state keeps the original time) and the older `time.archived` timestamp (0 unarchives). Only real transitions emit events: `session.renamed` on a title change, `session.archived` / `session.unarchived` once per archive change; a metadata-only update emits only `session.metadata.updated`. |
| DELETE | `/api/session/{sessionID}` | 204 | Removes the session. |
| GET | `/api/session/{sessionID}/message` | 200 | `{data: Message[], cursor}`; supports order, cursor, and limit. Like OpenCode 2.2.5, the list carries an `idle` record (`outcome` succeeded, failed or interrupted) after each turn OmO actually ended (a turn still running tools has none) and a completed `compaction` record with its summary and reason; both survive an adapter restart, and synthetic messages keep their `description`. |
| GET | `/api/session/{sessionID}/message/{messageID}` | 200 | `{data: Message}`; 404 if unknown. |
| GET | `/api/session/{sessionID}/todo` | 200 | `{data: Todo[]}`. |
| POST | `/api/session/{sessionID}/compact`, `/api/session/{sessionID}/summarize` | 200 | `{data: {id, type: "compaction", time, status: "running", reason: "manual", summary: ""}}` as soon as the compaction is admitted; completion or failure arrives on `/api/event`. A request while a compaction is pending returns that pending compaction, as OpenCode does, and retrying with a completed compaction's `id` returns it; an `id` owned by a non-compaction message is 409 `ConflictError`; a compaction cut short by the agent stopping fails with `session.compaction.failed` and no longer blocks a new one; 400 for an invalid `id` or `delivery`. |
| POST | `/api/session/{sessionID}/shell` | 204 | Runs a shell command; 400 for invalid input and 409 if busy. |
| GET | `/api/shell/{shellID}` | 200 | `{location, data: Shell.Info}` for a running shell or one of the 25 most recently ended; 404 if unknown. |
| GET | `/api/shell/{shellID}/output` | 200 | `{location, data: {output, cursor, size, truncated}}` from byte `cursor`, at most `limit` bytes, ending on a character boundary: a monitor's command, filter and matched lines; an eval cell's output (`eval_cells.peek`); a notice for a background terminal session, whose output OmO does not expose. 404 if unknown. |
| DELETE | `/api/shell/{shellID}` | 204 | Stops an eval cell (`eval_cells.stop`). 400 `UnsupportedError` for a monitor or a background terminal session, which OmO cannot stop over RPC; 404 if unknown. |
| POST | `/api/session/{sessionID}/command` | 204 | Runs the named slash command with the same `parts`, `files` and `agents` inputs as the prompt route and forwards `delivery: "steer" \| "queue"`; 400 if the name is missing or `delivery` is invalid. |
| POST or DELETE | `/api/session/{sessionID}/share` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/api/session/{sessionID}/generate` | 400 | `UnsupportedError`; session generation is unavailable with OmO. Unknown sessions return 404. Unsupported. |
| POST | `/api/session/{sessionID}/background` | 400 | `UnsupportedError`; background session control is unavailable with OmO. Unknown sessions return 404. Unsupported. |
| POST | `/api/session/{sessionID}/move` | 400 | `UnsupportedError`; session moves are unavailable with OmO. Unknown sessions return 404. Unsupported. |
| POST | `/api/session/{sessionID}/prompt` | 200 | Admission record `{data: {id, sessionID, time, type: "user", payload: {text, files?, agents?}, delivery, metadata?}}`. Requires string `text`; missing/non-string text, or empty/whitespace text without files or agents, returns 400 `{_tag: "InvalidRequestError", message}` before admission or agent activity. Attachment-only prompts remain valid with string `text`. `files: [{uri, name?}]` and `agents: [{name, mention?}]` become prompt parts: OmO receives inline text attachments, images, file references and `@agent` mentions with the text, and the user message lists them back as `files: [{mime, name?, source: {type: "uri", uri}}]`, `agents` and `metadata` after reloads; the `session.inbox.enqueued` payload carries the same `files`, `agents` and `metadata`. Any `skills` reference answers 400 `{_tag: "InvalidRequestError", message: "Skill not found: <id>"}` because no skills are listed. |
| POST | `/api/session/{sessionID}/synthetic`, `/api/session/{sessionID}/context` | 200 | No-reply context admission returning `{data: {id, sessionID, time: {created}, type: "synthetic", payload: {text}}}` (the captured OpenCode 2.x record; OpenChamber 2.3.2 aborts the send on any other status). A note whose `metadata.openchamberShellCancellation` names a shell that cannot be stopped (anything but a running eval cell) returns 400 `UnsupportedError` and is not admitted: OpenChamber sends that note before `DELETE /api/shell/{shellID}` and stops nothing when it fails. Requires non-whitespace string `text`; missing/non-string or empty/whitespace text returns 400 `{_tag: "InvalidRequestError", message}` before admission or agent activity. The text joins the native conversation as an OmO custom message (`send_custom_message`, `triggerTurn: false`) without starting a turn, so the next prompt carries it; it emits `session.inbox.enqueued` (payload `{text, metadata?}`) and `delivered`, lists as `type: "synthetic"`, becomes the saved native leaf so it survives restarts even without a later prompt, and never titles the session. `context` is a compatibility alias for `synthetic`. |
| POST | `/api/session/{sessionID}/interrupt` | 200 | Bare `{interrupted: boolean}`, as OpenCode 2.x returns it; OpenChamber reads `result.interrupted` directly. |
| POST | `/api/session/{sessionID}/fork` | 200 | `{data: Session}`; accepts `before` or legacy `messageID` (a user message is excluded, an assistant reply is kept, as `/btw` expects). |
| POST | `/api/session/{sessionID}/revert`, `/api/session/{sessionID}/revert/stage` | 200 | `{data: revert}`; requires a valid user-message boundary. |
| DELETE | `/api/session/{sessionID}/revert` | 204 | Clears a staged revert. |
| POST | `/api/session/{sessionID}/revert/commit` | 204 | Commits the staged conversation change; does not change files. |
| POST | `/api/session/{sessionID}/agent` | 204 | Selects a supported agent alias; a real change emits `session.agent.selected` with `previous`, repeating the current agent emits nothing. Unknown aliases return 400. |
| POST | `/api/session/{sessionID}/model` | 204 | Selects the requested model; invalid selection returns 400. |
| GET | `/api/session/{sessionID}/form` | 200 | `{data: FormInfo[]}`. |
| GET | `/api/session/{sessionID}/form/{formID}` | 200 | `{data: FormInfo & {state: {status: "pending"}}}`; 404 if unknown/settled. |
| POST | `/api/session/{sessionID}/form/{formID}/reply` | 204 | Replies after native acknowledgment; 404 unknown/settled, 409 native refusal. |
| DELETE | `/api/session/{sessionID}/form/{formID}` | 204 | Cancels after native acknowledgment; 404 unknown/settled, 409 native refusal. |
| GET | `/api/session/{sessionID}/question` | 200 | `{data: Question[]}`. |
| GET | `/api/session/{sessionID}/question/{requestID}` | 200 | `{data: Question}`; 404 if unknown. |
| POST | `/api/session/{sessionID}/question/{requestID}/reply` | 204 | Replies after native acknowledgment; 404 unknown/settled, 409 native refusal. |
| POST | `/api/session/{sessionID}/question/{requestID}/reject` | 204 | Rejects after native acknowledgment; 404 unknown/settled, 409 native refusal. |
| GET | `/api/session/{sessionID}/permission` | 200 | `{data: Permission[]}`. |
| GET | `/api/session/{sessionID}/permission/{requestID}` | 200 | `{data: Permission}`; 404 if unknown. |
| POST | `/api/session/{sessionID}/permission/{requestID}/reply` | 204 | Replies using `decision` (or legacy `reply`); 404 if unknown or invalid. |
| GET | `/api/session/{sessionID}/inbox` | 200 | `{data: SessionInbox.Info[]}`: accepted user inputs not yet delivered to OmO, in enqueue order, with delivery, text, attachments and metadata. |
| POST | `/api/session/{sessionID}/view` | 204 | `{idle: number}` advances a persisted viewed watermark (never backwards, never past the session's last idle boundary; a future or missing boundary changes nothing), emits `session.viewed {sessionID, idle}` on an advance and is returned as `time.viewed` on session reads. 400 for a missing `idle`. |
| PUT | `/api/experimental/session/{sessionID}/instructions/entries/{key}` | 204 | Stores `{value}` for the session (OpenChamber's guidance, checkout, memory, pins and response style). Changed entries reach OmO as one hidden custom message before the next prompt, rendered like OpenCode's `api/<key>` instructions (`<context key="...">`); an unchanged value is not sent again. What OmO already holds is read from the active branch (each delivery records the full map), so after a revert, unrevert, fork or compaction the entries that branch lost are sent again. A rejected delivery is logged and retried on the next prompt. 404 for an unknown session. |
| DELETE | `/api/experimental/session/{sessionID}/instructions/entries/{key}` | 204 | Marks the entry removed (idempotent). If OmO had received it, the next prompt carries OpenCode's "no longer applies" notice. 404 for an unknown session. |
| GET | `/api/session/{sessionID}/diff` | 200 | `{data: Diff[]}`; supports `from`, `to`, and `context`. |
| GET | `/api/session/{sessionID}/context` | 501 | `NotImplemented`. |
| Any | `/api/mcp/{...}`, `/api/experimental/mcp/{...}` | 400 | `UnsupportedError`; MCP is unavailable with OmO. Unsupported. |

### SSE and WebSocket streams

| Method | Path | Success | Response or behavior |
|---|---|---:|---|
| GET | `/api/event` | 200 | v2 SSE envelopes with `location` and `data`. Without a directory selector the stream is global (OpenChamber 2.3.2 opens it that way), live and on `Last-Event-ID` replay; `?directory=` or `x-opencode-directory` scopes it. `permission.asked` carries the same v2 card as `GET /api/permission/request`; `session.created` includes the session's `model` and precedes any model-selection event; OmO's `compaction_progress` fragments arrive as `session.compaction.delta {sessionID, text}` (none when OmO sends no partial text). Catalog changes are pushed when they really happen: `project.updated` when a session opens in a new directory; `provider.updated` and `model.updated` when the catalog changes; `command.updated` when a directory's OmO commands change; `vcs.branch.updated {branch?}` when a read directory's Git HEAD moves (watched, no polling). A finished turn re-reads providers, models and commands through that session's running agent; with no live agent only reads of `/api/provider`, `/api/model` or `/api/command` refresh, at most once a minute, so no OmO process is started on a timer. |
| GET | `/api/global/event` | 200 | Alias of `/api/event`, with the same scope and replay contract. |
| WebSocket | `/api/global/event/ws` | 101 | Global event stream; sends `ready`, then event frames with directory and payload; `lastEventId` replays retained events. |

The SSE streams `/api/event` and `/api/global/event` carry event IDs and
replay retained events after `Last-Event-ID`. Replay storage is bounded to
the most recent 1,024 records in process memory. V2 event
frames whose `data` has a top-level `sessionID` include
`durable: {aggregateID, seq, version: 1}` metadata. This is event identity and
sequence metadata, not an on-disk event log. The global WebSocket endpoint
sends `ready`, then `{type: "event", eventId, directory, scope: "global",
payload}` frames. `ready` includes `replayReset: true` when `lastEventId`
predates the retained window. It uses the same authentication and origin
checks as HTTP routes.

### antechamber routes (not OpenCode)

Served for the OmO Work section of the OpenChamber extension (`extensions/antechamber`, `src/work/`). They accept
the server password like every route, or `Authorization: Bearer <token>` with
the token `serve` writes into `<state dir>/run/<pid>.json`; that token opens
nothing else.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/antechamber/work-status/{sessionID}` | 200 | Work snapshot `{version: 1, sessionID, live, generatedAt, todo, monitors, evalCells, evalCellsListed, background, goal, wakeSources}` (`src/work-status.ts`). 400 for a malformed ID, 404 for an unknown session. |
| GET | `/antechamber/work-status/{sessionID}/eval/{cellID}?tailBytes=N` | 200 | OmO `eval_cells.peek` (output tail, at most 64 KiB). 404 unknown cell, 409 when the agent is not running. |
| POST | `/antechamber/work-status/{sessionID}/eval/{cellID}/stop` | 200 | OmO `eval_cells.stop`; returns the stopped cell. Same errors as peek. |
| POST | `/antechamber/work-status/{sessionID}/goal/fire` | 204 | OmO `goal_continuation_fire_now`. 409 when the agent is not running or OmO refuses. |

OmO monitor child sessions are an internal compatibility projection: `GET /api/session`,
`GET /api/session/active` and `GET /api/event` omit them.

### Shared status behavior

- Unknown sessions and resources return typed 404 errors. Invalid JSON, body
  shapes, unsupported input values, and unsupported capabilities return typed
  400 errors unless a route above specifies another status.
- Native permission/question refusals return 409. A shell request against a
  busy session also returns 409.
- Unknown top-level routes return 404 `NotFoundError` (`no route: ...`) on
  both retained compatibility and v2 routes, including `/api/*`. Retired
  routes use this same 404 response. Unrecognized subpaths beneath an
  existing `/api/session/{sessionID}` return 501
  `NotImplemented`; unknown session IDs return 404 instead. The explicit v2
  `GET /api/session/{sessionID}/context` route also returns 501.
- Passwordless requests with a disallowed browser origin return 403;
  configured Basic authentication failures return 401.

## Native questions and forms

Pending native questions share one registry. Structured questions retain
ordered selections, custom text, comments, drafts and deadlines. A
nonblocking request survives tool completion and agent idle without
changing the session status. Native settlement is authoritative; the adapter
sends a correlated `extension_ui_response`, never another answer prompt.

### Forms (OpenChamber 2.x)

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

## SSE event contract

`/api/event` and `/api/global/event` carry `{id, created, type, location, data}`
envelopes, global unless a directory selector scopes the subscription.

Internally the adapter emits the canonical lifecycle, message/part, permission,
question, todo, and diff events. Text and reasoning deltas use a dedicated
`message.part.delta` event before the updated-part snapshot; the snapshot does
not repeat that append delta. This ordering lets clients apply the delta once
and then reconcile to the authoritative part state.

The v2 translator maps user interruptions to
`session.execution.interrupted` with `reason: "user"`, provider or session
errors to `session.execution.failed`, and successful turns to
`session.execution.succeeded`. Failed assistant steps use
`session.step.failed` with `rawFinish: "error"`, the error, cost, and token
usage; they do not also emit a successful step or execution terminal.
Interrupted and failed executions likewise do not later emit a success
terminal. Successful steps use `session.step.ended`.

V2 also projects staged/cleared/committed revert events, compaction
started/ended/failed events, shell started/ended events, `shell.created` /
`shell.exited` for OmO background work, permission events,
question forms, session ancestry/metadata, and text/reasoning deltas. Other
OpenCode events with no adapter source are not emitted.

## pi RPC → OpenCode event mapping

| pi stdout event | OpenCode SSE |
|---|---|
| `message_update` / `assistantMessageEvent: text_delta` | `message.part.delta` followed by `message.part.updated` snapshot |
| `assistantMessageEvent: toolcall_start/delta/end` | `message.part.updated` (tool part; pending `{raw}` accumulates streamed JSON, running carries renderer inputs; eval and terminal controls use `bash` cards, reported as `shell` on the v2 API). Execution updates carry live `metadata.output`; completion supplies `output`. |
| `turn_end` (`toolResults[]`) | `message.part.updated` (tool part, completed `{output}` or error per `isError`, matched by `toolCallId`; monitors and `agent()` calls in eval `details.toolCalls` also produce subagent cards, as on execution updates) |
| `bash_execution_update` | user shell (`session.shell`): `message.part.updated` on the running `bash` card with live `metadata.output` (v2 `session.tool.progress`); matched by the request's `executionId` |
| turn start / turn end | `session.status` (busy) / `session.idle` |
| `extension_ui_request` (confirm/select/input) | `permission.asked` / `question.asked`, bridged through the approvals module (`src/approvals.ts`) |
| `extension_error` / RPC error response | `session.error` |
| agent stopped on its own (command timeout, broken pipe, frame overflow, exit) | `session.error` `AgentStoppedError` naming the reason, plus a notice card (`message.updated` / `message.part.updated`, id `msg_agentstop_<time>`) replayed after restarts until the next prompt |
| `get_entries` / `get_tree` (polled or on fork) | `session.updated` |

Tool part `state` mirrors `@opencode-ai/sdk` v2 (1.18.31) `ToolState`:
a discriminated union on `.status` with `input`/`output`/`title` inside the
state object (verified against the locally installed
`dist/v2/gen/types.gen.d.ts`). Live-observed pi shapes (probe, 2026-09-21):
`toolcall_start {contentIndex, id, toolName}` →
`toolcall_delta {delta}` (JSON argument fragments) →
`toolcall_end {toolCall:{id, name, arguments}}` →
`turn_end {toolResults:[{toolCallId, content:[{type:"text",text}], isError}]}`.

## Client and lifecycle compatibility

OpenChamber launches the configured binary with `serve --hostname H --port P`,
checks `--version`, and reads `/api/info`. Its external compatibility probe
still falls back to `/global/health` when the info probe fails. Update actions
execute the binary's `upgrade` CLI command. These CLI contracts and health
probe remain supported.
