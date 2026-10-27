# OpenCode API surface implemented by antechamber

The SDK call-site notes below are based on `reference/openchamber` (shallow
clone of `main`, 2026-09-20). Route behavior is checked against the current
adapter source and the maintained inventory below. Sources:

- `packages/ui/src/sync/event-reducer.ts`: authoritative SSE event contract.
- `packages/ui/src/sync/session-actions.ts`, `bootstrap.ts`,
  `stores/globalSessions.ts`, `lib/api/`: SDK call sites via
  `@opencode-ai/sdk/v2`.

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
| `GET /global/upgrade` | 409 | `UnsupportedError`; upgrades use `POST`. Static-only. |
| `GET /session` | 200 | `OCSession[]`; accepts `directory` and `archived` filters. |
| `POST /session` | 200 | Created `OCSession`. |
| `GET /session/status` | 200 | Map of session IDs to status objects. |
| `GET /project/current` | 200 | Current `OCProject`. |
| `GET /project` | 200 | Array containing the current `OCProject`. |
| `GET /config` | 200 | OpenCode-compatible configuration object. |
| `GET /global/config` | 200 | Same configuration object as `/config`. |
| `GET /provider` | 200 | `{all, default, connected}` provider catalog. |
| `GET /config/providers` | 200 | `{providers, default}` provider catalog. |
| `GET /experimental/session` | 200 | Sessions sorted by update time; supports directory, roots, cursor, and limit. `archived=false` excludes archived sessions; `archived=true` does not filter to archived-only. |
| `GET /question` | 200 | Pending v1 question cards. |
| `GET /permission` | 200 | Pending v1 permission cards. |
| `GET /skill` | 200 | Empty array; skill inventory is unavailable. |
| `GET /lsp` | 200 | Empty array; LSP status is unavailable. |
| `GET /formatter` | 200 | Empty array; formatter inventory is unavailable. |
| `GET /experimental/tool/ids` | 200 | Empty array; experimental tool inventory is unavailable. |
| `GET /provider/auth` | 200 | Empty object; provider authentication state is unavailable. |
| `GET /mcp` | 200 | `{name: McpStatus}` from RPC `get_loaded_surfaces` on the most recently used live session in the directory, else on the most recently used live session in any directory; empty object when no session has a running agent or OmO has no such RPC. |
| `GET /command` | 200 | Agent slash-command descriptors. |
| `GET /path` | 200 | Home, state, config, worktree, and directory paths. |
| `GET /vcs` | 200 | `{branch, default_branch}` for the selected directory. |
| `GET /agent` | 200 | Supported agent descriptors. |
| `GET /file` | 200 | Directory entries confined to the selected session directory. |
| `GET /find/file` | 200 | Matching relative paths, confined to the selected session directory. |
| `PATCH /config` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| `POST /experimental/control-plane/move-session` | 400 | `UnsupportedError`; configure session directories in OmO. Unsupported. |
| `GET /global/event` | 200 | Global v1 SSE stream; see [SSE and WebSocket streams](#sse-and-websocket-streams). |
| `GET /api/info` | 200 | OpenCode API version, process ID, server URL, and temporary path. |
| `GET /api/location` | 200 | Current directory and project location. |
| `GET /api/config` | 200 | Bare `ConfigEntry[]` (OpenCode 2.x contract): one `{type: "document", path: "antechamber", info: {default_agent}}` entry that OpenChamber folds with `mergeConfigDocuments`. |
| `GET /api/shell` | 200 | `{location, data: []}`; OmO has no background shells to list. |
| `GET /api/websearch/provider` | 200 | `{location, data: []}`; no web-search providers are configured through antechamber. |
| `GET /api/provider` | 200 | `{location, data: Provider[]}` from the agent catalog. |
| `GET /api/model` | 200 | `{location, data: Model[]}` from the agent catalog; `variants` lists thinking levels as `{id, settings}[]`. |
| `GET /api/model/default` | 200 | `{location, data: Model \| null}` for the active model, same `variants` shape. |
| `GET /api/agent` | 200 | `{location, data: Agent[]}`; the default model and thinking level are `model: {id, providerID, variant?}`. |
| `GET /api/command` | 200 | `{location, data: Command[]}`. |
| `GET /api/skill` | 200 | `{location, data: []}`; skill inventory is unavailable. |
| `DELETE /api/debug/location` | 204 | Empty, as OpenCode answers. OpenChamber evicts a location after git worktree changes; antechamber keeps no per-location instance, so there is nothing to evict. |
| `GET /api/credential` | 200 | `{location, data: []}`; no credentials are retained. |
| `POST /api/credential` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| `GET /api/integration` | 200 | `{location, data: IntegrationInfo[]}`: one `mcp_{name}` integration (`metadata.source: "mcp"`, one `oauth` method) per OAuth-capable OmO MCP server in the newest live session of the directory, else of any directory; empty without one. Providers are not integrations here. |
| `GET /api/plugin` | 200 | `{location, data: []}`; no OpenCode plugins are loaded by OmO. |
| `POST /api/plugin/check` | 200 | Read-only update query returning `{location, data: []}`; there are no plugins to check. |
| `POST /api/plugin/update` | 400 | `UnsupportedError`; plugin updates are unavailable with OmO. Unsupported. |
| `POST /api/experimental/generate` | 503 | `{_tag: "ServiceUnavailableError", message: "No generation model is available through antechamber/OmO", service: "opencode"}`. |
| `GET /api/experimental/session/stats` | 400 | `UnsupportedError`; session statistics are unavailable with OmO. Unsupported. |
| `GET /api/mcp` | 200 | `{location, data: McpServer[]}` (`name`, v2 `status`, `integrationID` for OAuth-capable servers) from RPC `get_loaded_surfaces` on the newest live session in the directory, else in any directory; empty without one. |
| `POST /api/mcp` | 400 | `UnsupportedError`; MCP is unavailable with OmO. Unsupported. |
| `DELETE /api/mcp` | 400 | `UnsupportedError`; MCP is unavailable with OmO. Unsupported. |
| `GET /api/fs/find` | 200 | `{location, data: [{path, type: "file"}]}`. |
| `GET /api/project` | 200 | Project records for the default directory and directories with restorable sessions. |
| `GET /api/permission/request` | 200 | `{location, data: Permission[]}` for the selected directory. |
| `GET /api/question/request` | 200 | `{location, data: Question[]}`. |
| `GET /api/permission/saved` | 200 | `{data: []}`; saved permissions are unavailable. |
| `GET /api/form` | 200 | `{location, data: FormInfo[]}` for pending questions. |
| `POST /api/vcs/init` | 204 | Initializes a Git repository in the selected directory. |
| `GET /api/vcs` | 200 | `{location, data: {provider: "git", branch}}`. |
| `GET /api/vcs/base` | 200 | OpenCode 2.0.28 `VcsBaseOutput`: `{location, data: {name, ref, source: "reflog" \| "default"} \| null}`. Resolves the checkout source branch from HEAD's reflog, then origin's default branch, then main/master; `ref` is its commit ID. Null outside Git, before the first commit, or when no base can be found. |
| `GET /api/vcs/status` | 200 | OpenCode 2.0.28 `VcsStatusOutput`: `{location, data: [{file, additions, deletions, status: "added" \| "deleted" \| "modified"}]}`. Git index/worktree and untracked files, with net HEAD line counts (binary counts are zero); cancelled staged/unstaged changes remain listed. Empty outside Git. All four VCS read routes use the same directory selectors as `/api/vcs`, run read-only Git with optional locks disabled, and cap each command at 5 seconds / 16 MiB (combined patches also at 16 MiB); invalid queries or Git failures return 400 `{name: "BadRequestError", data: {message}}`, not empty success. |
| `GET /api/vcs/branch` | 200 | OpenCode 2.0.28 `VcsBranchListOutput`: `{location, data: string[]}` of sorted local branch names; optional substring `search` and non-negative integer `limit` (default 100). Empty outside Git. |
| `GET /api/vcs/diff` | 200 | OpenCode 2.0.28 `VcsDiffOutput`: `{location, data: [{file, patch, additions, deletions, status: "added" \| "deleted" \| "modified"}]}`. Required `mode=working` compares HEAD to the worktree; `branch` compares the merge-base to the worktree (both include untracked files); `committed` compares the merge-base to HEAD. Optional `base` selects a commit for branch/committed (otherwise the detected base); `context` is a non-negative integer (default 3). Empty outside Git. |
| `GET /api/session` | 200 | `{data: Session[], cursor: {previous, next}}`; supports location, search, parent, order, cursor, and limit. |
| `POST /api/session` | 200 | `{data: Session}`; validates the requested location, model, agent, ID, and metadata. |
| `GET /api/session/active` | 200 | `{data: Record<sessionID, {type: "running"}>}`. |

### Parameterized HTTP routes

| Method | Path | Success | Response or behavior |
|---|---|---:|---|
| GET | `/session/{sessionID}` | 200 | Session record; 404 if unknown. |
| PATCH | `/session/{sessionID}` | 200 | Updated session record; supports title, archive time, and metadata. |
| DELETE | `/session/{sessionID}` | 200 | Session removal result. |
| GET | `/session/{sessionID}/message` | 200 | Message list; optional `limit` returns the newest bounded page. When older messages remain, the `x-next-cursor` header carries the page's oldest message ID; pass it back as `before` to fetch the page that precedes it. A page extends back to the user parents referenced by its replies, even when it already contains a compaction turn. A page with no non-compaction user prompt otherwise extends back to the preceding non-compaction prompt, preserving the whole native turn even when it spans several compaction display turns. Either extension can exceed `limit`. An unknown `before` returns `[]`. |
| GET | `/session/{sessionID}/message/{messageID}` | 200 | One message; 404 if unknown. |
| GET | `/session/{sessionID}/children` | 200 | Direct child sessions. |
| GET | `/session/{sessionID}/todo` | 200 | Session todo items. |
| GET | `/session/{sessionID}/diff` | 200 | Unified diff for the session. |
| POST | `/session/{sessionID}/prompt_async` | 204 | Admits a prompt asynchronously; requires an array of text, file, and agent parts, optional `delivery: "steer" \| "queue"`, and a client message ID. Missing/non-array `parts` or an empty native prompt (no non-whitespace text, file content, image, or agent mention) returns 400 `{name: "InvalidRequestError", data: {message}}` before admission or agent activity, including with `noReply: true`. `noReply: true` admits the message into the native conversation without a turn, like v2 synthetic context. |
| POST | `/session/{sessionID}/message` | 200 | Message record after prompt admission; requires the same rich v1 parts and returns the same typed 400 for missing/non-array `parts` or an empty native prompt, including with `noReply: true`. |
| POST | `/session/{sessionID}/abort` | 200 | Boolean abort result. |
| POST | `/session/{sessionID}/fork` | 200 | Forked session record; optional `messageID` selects the fork boundary (a user message is excluded, an assistant reply is kept). |
| POST | `/session/{sessionID}/revert` | 200 | Session record with staged revert state; requires a user-message `messageID`. |
| POST | `/session/{sessionID}/unrevert` | 200 | Session record after restoring the saved leaf. |
| POST | `/session/{sessionID}/summarize` | 200 | Boolean success after compaction; 400 if compaction cannot run. A compaction OmO cancels without a user abort (e.g. its tool set changed while MCP servers connected) is retried up to twice. |
| POST | `/session/{sessionID}/shell` | 200 | Shell message; 400 for invalid input and 409 if the session is busy. |
| POST | `/session/{sessionID}/command` | 200 | Slash-command message envelope; 400 if the command is missing. |
| POST | `/session/{sessionID}/share` | 400 | `UnsupportedError`. Unsupported. |
| DELETE | `/session/{sessionID}/share` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/question/{requestID}/reply` | 200 | `true` after native acknowledgment; 404 unknown/settled, 409 native refusal. |
| POST | `/question/{requestID}/reject` | 200 | `true` after native acknowledgment; 404 unknown/settled, 409 native refusal. |
| POST | `/permission/{requestID}/reply` | 200 | `true` after reply; 404 unknown or invalid request. |
| PUT | `/auth/{providerID}` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/provider/{providerID}/oauth/authorize` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/provider/{providerID}/oauth/callback` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/mcp/{name}/auth` | 200 | `{authorizationUrl, oauthState}` announced by OmO's native `/mcp auth {name}` in the live session; the flow then finishes inside OmO (loopback callback, token exchange, reconnect). 400 without a live session, on an OmO error or when no URL appears within 30 s; 404 for an unknown server. |
| POST | `/mcp/{name}/auth/authenticate` | 200 | `McpStatus` after the same native flow completes (OmO opens the browser itself); joins a flow already running for that server. Same errors as `/mcp/{name}/auth`, plus 400 when OmO parked the flow for a pasted code. Both routes return 409 while a different auth flow for the server is running in the same agent; concurrent identical requests share one flow. |
| POST or DELETE | `/mcp/{name}/connect`, `/mcp/{name}/disconnect`, DELETE `/mcp/{name}/auth` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/mcp/{name}/auth/callback` | 200 | `McpStatus` once `{code}` (a bare code or the whole redirect URL) finishes the pending flow. A flow still waiting on OmO's loopback listener receives the redirect there; a parked flow (`mcp.oauthCallbackUrl` set) is finished with `/mcp auth-complete {name} {redirect}`. A bare code is rebuilt from the authorization request's `redirect_uri` and `state`. 400 when nothing is pending or OmO rejects the response. |
| POST | `/global/upgrade` | 200 | Upgrades antechamber itself to the latest npm release (the OpenCode `target` is ignored) and returns `{success: true, version, updated}`; OpenChamber 1.x then restarts the process. 409 `UnsupportedError` when this is not a global npm/bun install or `npm root -g` cannot run; registry and installer failures are `UnknownError` 500 without installer output or registry credentials. |
| GET | `/api/agent/{agentID}` | 200 | `{location, data: Agent}`; 404 for an unknown agent. |
| PATCH | `/api/project/{projectID}` | 400 | `UnsupportedError`; project updates are unavailable with OmO. Unsupported. |
| DELETE | `/api/credential/{credentialID}` | 204 | Idempotent no-op; no credentials are retained. |
| PATCH | `/api/credential/{credentialID}` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| POST | `/api/credential/{credentialID}/activate` | 400 | `UnsupportedError`; configure providers in OmO. Unsupported. |
| GET | `/api/integration/mcp_{name}` | 200 | `{location, data: IntegrationInfo}` for an OAuth-capable OmO MCP server; 404 otherwise. |
| POST | `/api/integration/mcp_{name}/connect/oauth` | 200 | `{location, data: IntegrationAttempt}` with `mode: "code"`: runs OmO's headless `/mcp auth-start {name}` and returns its authorization URL. |
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
| PATCH | `/api/session/{sessionID}` | 204 | Updates title, archive state, or metadata. Archive accepts OpenCode 2.1's `archived: boolean` (repeating the current state keeps the original time) and the older `time.archived` timestamp (0 unarchives). |
| DELETE | `/api/session/{sessionID}` | 204 | Removes the session. |
| GET | `/api/session/{sessionID}/message` | 200 | `{data: Message[], cursor}`; supports order, cursor, and limit. |
| GET | `/api/session/{sessionID}/message/{messageID}` | 200 | `{data: Message}`; 404 if unknown. |
| GET | `/api/session/{sessionID}/todo` | 200 | `{data: Todo[]}`. |
| POST | `/api/session/{sessionID}/compact`, `/api/session/{sessionID}/summarize` | 200 | `{data: true}` after compaction. |
| POST | `/api/session/{sessionID}/shell` | 204 | Runs a shell command; 400 for invalid input and 409 if busy. |
| POST | `/api/session/{sessionID}/command` | 204 | Runs the named slash command; 400 if missing. |
| POST or DELETE | `/api/session/{sessionID}/share` | 400 | `UnsupportedError`. Unsupported. |
| POST | `/api/session/{sessionID}/generate` | 400 | `UnsupportedError`; session generation is unavailable with OmO. Unknown sessions return 404. Unsupported. |
| POST | `/api/session/{sessionID}/background` | 400 | `UnsupportedError`; background session control is unavailable with OmO. Unknown sessions return 404. Unsupported. |
| POST | `/api/session/{sessionID}/move` | 400 | `UnsupportedError`; session moves are unavailable with OmO. Unknown sessions return 404. Unsupported. |
| POST | `/api/session/{sessionID}/prompt` | 200 | Admission record `{data: {id, sessionID, time, type: "user", payload: {text, files?, agents?}, delivery, metadata?}}`. Requires string `text`; missing/non-string text, or empty/whitespace text without files or agents, returns 400 `{_tag: "InvalidRequestError", message}` before admission or agent activity. Attachment-only prompts remain valid with string `text`. `files: [{uri, name?}]` and `agents: [{name, mention?}]` become prompt parts: OmO receives inline text attachments, images, file references and `@agent` mentions with the text, and the user message lists them back as `files: [{mime, name?, source: {type: "uri", uri}}]`, `agents` and `metadata` after reloads; the `session.inbox.enqueued` payload carries the same `files`, `agents` and `metadata`. Any `skills` reference answers 400 `{_tag: "InvalidRequestError", message: "Skill not found: <id>"}` because no skills are listed. |
| POST | `/api/session/{sessionID}/synthetic`, `/api/session/{sessionID}/context` | 200 | No-reply context admission returning `{data: {id, sessionID, time: {created}, type: "synthetic", payload: {text}}}` (the captured OpenCode 2.x record; OpenChamber 2.3.2 aborts the send on any other status). Requires non-whitespace string `text`; missing/non-string or empty/whitespace text returns 400 `{_tag: "InvalidRequestError", message}` before admission or agent activity. The text joins the native conversation as an OmO custom message (`send_custom_message`, `triggerTurn: false`) without starting a turn, so the next prompt carries it; it emits `session.inbox.enqueued` (payload `{text, metadata?}`) and `delivered`, lists as `type: "synthetic"`, becomes the saved native leaf so it survives restarts even without a later prompt, and never titles the session. `context` is a compatibility alias for `synthetic`. |
| POST | `/api/session/{sessionID}/interrupt` | 200 | Bare `{interrupted: boolean}`, as OpenCode 2.x returns it; OpenChamber reads `result.interrupted` directly. |
| POST | `/api/session/{sessionID}/fork` | 200 | `{data: Session}`; accepts `before` or legacy `messageID` (a user message is excluded, an assistant reply is kept, as `/btw` expects). |
| POST | `/api/session/{sessionID}/revert`, `/api/session/{sessionID}/revert/stage` | 200 | `{data: revert}`; requires a valid user-message boundary. |
| DELETE | `/api/session/{sessionID}/revert` | 204 | Clears a staged revert. |
| POST | `/api/session/{sessionID}/revert/commit` | 204 | Commits the staged conversation change; does not change files. |
| POST | `/api/session/{sessionID}/agent` | 204 | Selects a supported agent alias; unknown aliases return 400. |
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
| GET | `/api/session/{sessionID}/inbox` | 200 | `{data: []}`; inbox listing is unavailable. |
| GET | `/api/session/{sessionID}/diff` | 200 | `{data: Diff[]}`; supports `from`, `to`, and `context`. |
| GET | `/api/session/{sessionID}/context` | 501 | `NotImplemented`. |
| Any | `/api/mcp/{...}`, `/api/experimental/mcp/{...}` | 400 | `UnsupportedError`; MCP is unavailable with OmO. Unsupported. |

### SSE and WebSocket streams

| Method | Path | Success | Response or behavior |
|---|---|---:|---|
| GET | `/event` | 200 | Directory-scoped v1 SSE; events keep their raw v1 shape. |
| GET | `/global/event` | 200 | Global v1 SSE; broadcast event frames wrap events as `{directory, project, payload}`. |
| GET | `/api/event` | 200 | v2 SSE envelopes with `location` and `data`. Without a directory selector the stream is global (OpenChamber 2.3.2 opens it that way), live and on `Last-Event-ID` replay; `?directory=` or `x-opencode-directory` scopes it. |
| WebSocket | `/api/global/event/ws` | 101 | Global event stream; sends `ready`, then event frames with directory and payload; `lastEventId` replays retained events. |

The v1 local `/event` stream is not wrapped and remains data-only. The global
v1 stream wraps its initial connection event and subsequent events; subsequent
event frames carry an `id:` line and nested payload. The v2 SSE stream carries
event IDs and replays retained events after `Last-Event-ID`. Replay storage is
bounded to the most recent 1,024 records in process memory; reconnectable
global v1 and v2 frames use event IDs, while local v1 frames do not. V2 event
frames whose `data` has a top-level `sessionID` include
`durable: {aggregateID, seq, version: 1}` metadata. This is event identity and
sequence metadata, not an on-disk event log. The global WebSocket endpoint
sends `ready`, then `{type: "event", eventId, directory, scope: "global",
payload}` frames. `ready` includes `replayReset: true` when `lastEventId`
predates the retained window. It uses the same authentication and origin
checks as HTTP routes.

### antechamber routes (not OpenCode)

Served for the OmO Work extension service (`extensions/omo-work`). They accept
the server password like every route, or `Authorization: Bearer <token>` with
the token `serve` writes into `<state dir>/run/<pid>.json`; that token opens
nothing else.

| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/antechamber/work-status/{sessionID}` | 200 | Work snapshot `{version: 1, sessionID, live, generatedAt, todo, monitors, evalCells, evalCellsListed, background, goal, wakeSources}` (`src/work-status.ts`). 400 for a malformed ID, 404 for an unknown session. |
| GET | `/antechamber/work-status/{sessionID}/eval/{cellID}?tailBytes=N` | 200 | OmO `eval_cells.peek` (output tail, at most 64 KiB). 404 unknown cell, 409 when the agent is not running. |
| POST | `/antechamber/work-status/{sessionID}/eval/{cellID}/stop` | 200 | OmO `eval_cells.stop`; returns the stopped cell. Same errors as peek. |
| POST | `/antechamber/work-status/{sessionID}/goal/fire` | 204 | OmO `goal_continuation_fire_now`. 409 when the agent is not running or OmO refuses. |

OmO monitor child sessions are a v1-only projection: `GET /api/session`,
`GET /api/session/active` and `GET /api/event` omit them.

### Shared status behavior

- Unknown sessions and resources return typed 404 errors. Invalid JSON, body
  shapes, unsupported input values, and unsupported capabilities return typed
  400 errors unless a route above specifies another status.
- Native permission/question refusals return 409. A shell request against a
  busy session also returns 409.
- Unknown top-level routes return 404 `NotFoundError` (`no route: ...`) on
  both v1 and v2, including `/api/*`. Unrecognized subpaths beneath an
  existing `/session/{sessionID}` or `/api/session/{sessionID}` return 501
  `NotImplemented`; unknown session IDs return 404 instead. The explicit v2
  `GET /api/session/{sessionID}/context` route also returns 501.
- Passwordless requests with a disallowed browser origin return 403;
  configured Basic authentication failures return 401.

## OpenChamber SDK methods used

### Sessions (core)

| SDK method | Purpose in OpenChamber | pi counterpart |
|---|---|---|
| `session.list` | session list per directory | scan pi `--session-dir` JSONL files. `Session.cost` is the session's own spend: the sum of its assistant messages' OmO `usage.cost.total`, restored before metadata is returned and refreshed on each assistant `message_end` (announced with `session.updated`, translated to cumulative `session.usage.updated` on v2). Subagent sessions carry their own cost and `parentID`; OpenChamber's work-status rollup sums the subtree, so a parent never includes child spend. |
| `session.create` | new session | spawn `pi --mode rpc` (fresh session) |
| `session.get` | session detail | RPC `get_state` |
| `session.update` | rename/archive/metadata | adapter-side title + `time.archived` (persisted in the registry; `archived=true/false` list filtering honored on `/session` and `/experimental/session`) |
| `session.delete` | delete session | kill process + remove session file |
| `session.messages` | load message history | RPC `get_messages` |
| `session.promptAsync` | send prompt (async) | RPC `prompt`. Reuses the client's optimistic `messageID` and emits the user message and parts so the optimistic insert reconciles in place. V1 text, file, and agent parts are retained in history; inline image data becomes native image input, inline text files become prompt text, and agent mentions become `@name` text. |
| `session.abort` | stop generation | RPC `abort` |
| `session.fork` | fork from a message | RPC `fork` / `get_fork_messages`; conversation-only fork backed by the agent's session tree (see docs/architecture.md) |
| `session.revert` / `session.unrevert` | undo/redo conversation context | backed by the agent's native session-tree navigation; conversation-only, never touches files on disk |
| `session.summarize` | compact context | RPC `compact`, which answers only after the summary is written (timeout 31 min, above OmO's 30 min cap). `compaction_start` sets `time.compacting` and marks an idle session busy; `compaction_end` adds a user message with a `compaction` part (shown as `/compact`) and an assistant `summary: true` message with the summary text. History rebuilds the same pair from `compaction` entries, keyed by `firstKeptEntryId`. |
| `session.status` | busy/idle map | derive from RPC events |
| `session.todo` | todo list rendering | bridged from the agent's todo tool (`src/todo-bridge.ts`) |
| `session.shell` | run shell in session ctx | RPC `bash`, with cancellation via `abort_bash` |
| `session.command` | slash commands | RPC `prompt` with `/cmd` or `get_commands`. File parts are retained and adapted like ordinary v1 prompts. OmO skips native title generation for a first prompt starting with `/`, so any `/cmd args` prompt also sends `sessionTitlePrompt: args`. |
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
| `config.get` | adapter config and selected agent name; `PATCH /config` is unsupported |
| `config.providers` | RPC `get_available_models` (translated) |
| `command.list` | RPC `get_commands` |
| `app.agents` | static pi agent descriptors: `build` plus pi's own agent name |
| `path.get`, `vcs.get`, `lsp.status`, `find.*`, `file.*` | filesystem/git direct (adapter-side) |
| `mcp.status` | RPC `get_loaded_surfaces` on the newest live session in the directory |
| `mcp.auth.start`, `mcp.auth.authenticate` | RPC `prompt` `/mcp auth {name}` sent outside the conversation queue |
| `mcp.auth.callback` | loopback redirect to OmO's waiting listener, or RPC `prompt` `/mcp auth-complete {name} {redirect}` |
| v2 `mcp.list`, `integration.*` for `mcp_*` | `get_loaded_surfaces`; `/mcp auth-start` + `/mcp auth-complete`; `mcp.status.changed` after a sign-in |
| `auth.set`, `provider.oauth`, `mcp.connect/disconnect`, `mcp.auth.remove` | unsupported with OmO; configure providers and MCP in OmO |

## SSE event contract

V1 `/event` carries raw OpenCode v1 events scoped to the selected directory.
V1 `/global/event` carries broadcast events in `{directory, project, payload}`
envelopes; its initial `server.connected` frame is `{directory, payload}`.
V2 `/api/event` carries `{id, created, type, location, data}`
envelopes; it is global unless a directory selector scopes it. These are distinct wire shapes; the global wrapper is not used on
the directory-scoped v1 stream.

The adapter emits the supported v1 lifecycle, message/part, permission,
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
started/ended/failed events, shell started/ended events, permission events,
question forms, session ancestry/metadata, and text/reasoning deltas. Other
OpenCode events with no adapter source are not emitted.

## pi RPC → OpenCode event mapping

| pi stdout event | OpenCode SSE |
|---|---|
| `message_update` / `assistantMessageEvent: text_delta` | `message.part.delta` followed by `message.part.updated` snapshot |
| `assistantMessageEvent: toolcall_start/delta/end` | `message.part.updated` (tool part; pending `{raw}` accumulates streamed JSON, running carries renderer inputs; eval and terminal controls use `bash` cards, reported as `shell` on the v2 API). Execution updates carry live `metadata.output`; completion supplies `output`. |
| `turn_end` (`toolResults[]`) | `message.part.updated` (tool part, completed `{output}` or error per `isError`, matched by `toolCallId`; monitors and `agent()` calls in eval `details.toolCalls` also produce subagent cards, as on execution updates) |
| `bash_execution_update` | unmapped; folded into tool parts above |
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
