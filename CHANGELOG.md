# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Keep pending prompts alive while the agent is running or compacting instead of terminating useful work at the
  ordinary RPC deadline. Silent requests still time out, and prompt admission has a bounded overall wait.

## [0.2.9] - 2026-10-16

### Fixed

- Mobile: sessions whose newest 30 messages contain no user prompt no longer
  open blank on OpenChamber's mobile surface. v1 `GET /session/{id}/message`
  now returns `x-next-cursor` and honors `before`, so the client pages back
  until it finds the start of a turn.

## [0.2.8] - 2026-10-15

- fix(session): resend bare /<skill> commands as /skill:<name>

## [0.2.7] - 2026-10-15

### Fixed

- OmO Graph: panning no longer selects the wave labels, so pressing near the
  graph can no longer start a native text drag. That drag cancelled the pan
  after a few pixels, and before 0.2.3 it left the graph following the mouse
  with the button released.

## [0.2.6] - 2026-10-15

- fix(omo-graph): stop ending the pan on blur and lost capture

## [0.2.5] - 2026-10-15

### Added

- OmO terminal monitors now appear in OpenChamber as read-only child sessions of
  the session that started them. They are listed under Subagents and keep a live
  sidebar dot while the watch runs, and their transcript shows the watched
  command, filter, event count and how the watch ended. A session with a live
  watch is no longer evicted as idle, which used to stop the watch.
- MCP servers configured in OmO now appear in OpenChamber's MCP status, and the
  Authorize button for a server that needs sign-in runs OmO's native
  `/mcp auth` flow in the running session. Status and authorization use the
  most recently used live session in the directory. The flow never adds a
  message to the conversation, and it never revives a dormant session.
- Completing an MCP sign-in with a pasted code or redirect URL (OpenChamber's
  callback page or paste box) now works through `/mcp/{name}/auth/callback`.
  The code goes to OmO's waiting loopback listener, or to
  `/mcp auth-complete` when OmO parked the flow.
- OpenChamber 2.x now lists OmO MCP servers (`GET /api/mcp`) and can sign in
  through `mcp_*` integrations. These run OmO's headless `/mcp auth-start` and
  `/mcp auth-complete` with a paste-the-code step. A completed sign-in emits
  `mcp.status.changed`.

### Fixed

- OmO Graph: dragging the graph no longer stops after a fraction of a second.
  The previous stuck-pan fix also ended the drag when the panel lost focus or
  pointer capture, which can happen while the button is still held; the drag
  now ends only on release, cancel, or a move without the button held.

### Fixed

- Invoking a skill as `/<name>` (as OpenChamber offers it) no longer fails with
  `Unknown command /<name>. Did you mean /skill:<name>?`. When OmO suggests the
  matching skill, antechamber resends the prompt as `/skill:<name>`.

## [0.2.4] - 2026-10-15

### Added

- feat(cli): `antechamber setup --auto-update` points OpenChamber at a launcher that installs the latest release in the background on every start; it is now the recommended install path
- feat(cli): `antechamber upgrade` installs the latest release with the package manager that owns the global install, so OpenChamber 2.3.2's Update button now upgrades antechamber
- feat(api): `POST /global/upgrade` upgrades antechamber itself instead of returning `UnsupportedError`
- feat(config): `ANTECHAMBER_AUTO_UPDATE=1` enables the post-start background update

## [0.2.3] - 2026-10-15

### Fixed

- OmO Graph: panning no longer gets stuck following the mouse after the button
  is released outside the panel (or the pointer is cancelled, capture is lost
  or the window loses focus); a move without the primary button held now ends
  the drag.

## [0.2.2] - 2026-10-15

### Fixed

- Sub-agent sessions spawned without a `task` tool call (for example `agent()`
  inside an `eval` cell) now open from their OmO task record instead of
  returning `session not found`, and appear in the session list as soon as
  they exist or complete, so their OmO Graph cards are clickable.

### Changed

- ci(release): every push to `main` now ships a patch release automatically; CI bumps the package and OmO Graph extension versions (now kept equal), rolls the CHANGELOG, tags, publishes to npm and attaches the extension zip to the GitHub release. The release guide moved to `RELEASE.md`

## [0.2.1] - 2026-10-15

### Fixed

- fix(extension): save OmO Graph data paths without form submission, which OpenChamber's iframe sandbox blocks
- fix(session): accept OmO messages stored as plain-string content when titling, binding and restoring sessions instead of crashing
- fix(api): answer OpenChamber's location eviction (`DELETE /api/debug/location`) with OpenCode's empty 204
- fix(api): answer the v2 routes OpenChamber 2.3.2 calls instead of a generic 404/501. Plugin list and check return an empty inventory, `/api/experimental/generate` returns OpenCode's typed 503, and plugin update, credential update/activate, integration connections and session generate/background/move return `UnsupportedError`
- fix(api): stop faking mutations. `POST /api/credential` and `PATCH /api/project/{projectID}` return `UnsupportedError` instead of keeping an in-memory credential or echoing an unsaved project
- fix(api): reject missing or empty prompt and synthetic-context input with a typed 400 before anything reaches OmO
- fix(vcs): back `/api/vcs/status`, `/api/vcs/diff`, `/api/vcs/branch` and `/api/vcs/base` with read-only git instead of fixed empty data
- fix(cli): refuse `opencode-antechamber upgrade` with the antechamber upgrade command, and document OpenChamber 2.3.2's OpenCode update notice

### Changed

- refactor: use `findLast` for last-match scans
- docs(api): unknown routes return 404 on both APIs; only unknown subpaths of an existing v2 session return 501

## [0.2.0] - 2026-10-14

### Added

- feat(api): add v2 credential, integration, file-search, VCS, and synthetic-context routes
- feat(events): replay retained SSE events and expose v2 shell, compaction, and execution terminals

### Fixed

- fix(session): preserve rich prompt parts, metadata, ancestry, and part identities across reloads
- fix(runtime): retain operation ordering after caller cancellation and finalize interrupted tool cards
- fix(rpc): close failed transports and reject responses correlated to the wrong command
- fix(http): allow passwordless loopback origins across ports while retaining explicit origin checks
- fix(security): validate registry records and write registry state with private permissions
- fix(cli): advertise OpenCode API compatibility as 2.0.20
- fix(api): return OpenCode 2.x bootstrap shapes for `/api/config`, `/api/shell`, `/api/websearch/provider` and `GET /api/mcp` so OpenChamber 2.3.2 can initialize workspaces
- fix(api): answer v2 synthetic context admission with the admitted record and return the bare interrupt flag, so OpenChamber 2.3.2 can send prompts and stop turns
- fix(extension): bound graph responses and display omitted-node counts
- fix(api): carry v2 prompt attachments, agent mentions and metadata into OmO's input, admission events and message history, and answer skill references with OpenCode's tagged not-found error
- fix(session): admit synthetic context and v1 `noReply` messages into OmO's conversation without a turn, keep them after restarts even when no prompt follows, and stop context from titling sessions
- fix(events): keep an unscoped v2 `/api/event` stream global, as OpenChamber 2.3.2 subscribes
- fix(rpc): after the agent exits during shutdown, kill only re-identified members of its process group

### Changed

- docs(api): document route statuses, response envelopes, stream framing, and unsupported capabilities
- docs(maintainers): correct smoke paths, typecheck commands, and release guidance

## [0.1.1] - 2026-10-14

### Added

- Sessions now report `cost` (USD) from OmO's per-message usage, live and from
  history, on v1 session payloads and v2 session reads. Subagent sessions carry
  their own cost, so OpenChamber's work-status panel shows the session total
  with its session/subagents breakdown.

### Fixed

- `/compact` now shows progress and its result. The session turns busy while
  OmO compacts, and the summary appears as a `/compact` turn with a summary
  reply, live and after reload. The compact RPC now waits up to OmO's own
  30-minute compaction budget instead of giving up after 60 seconds, which left
  the compaction running unseen until a later abort reported it cancelled.
- Reverting no longer adds a "Conversation reverted. Files were not changed."
  card to the transcript; OpenChamber's own reverted-message dock (driven by
  `session.revert`) already shows the state.
- Sessions opened with a slash command (for example `/skill:plan Build the
  importer`) now get a generated title. OmO skips titling slash-led prompts, so
  the adapter passes the command's arguments as the native `sessionTitlePrompt`.

## [0.1.0] - 2026-10-14

First standalone release under the `antechamber` name.

### Renamed

This project was previously published as `openchamber-pi-connector`. The
rename affects:

- Package and CLI binary: `openchamber-pi-connector` / `opencode-pi` to
  `antechamber` (`dist/cli.js`, bin name `antechamber`).
- Launcher script: `bin/opencode-antechamber` is the new OpenChamber launcher;
  `bin/opencode-pi` is kept as a deprecated shim that forwards to it, so
  existing `settings.opencodeBinary` values keep working.
- Environment variables: all settings now read the `ANTECHAMBER_` prefix
  first (for example `ANTECHAMBER_PI_BINARY`, `ANTECHAMBER_STATE_DIR`,
  `ANTECHAMBER_AGENT`, `ANTECHAMBER_IDLE_TIMEOUT_MS`, `ANTECHAMBER_MAX_LIVE`,
  `ANTECHAMBER_DEBUG`). The previous `OCPI_` prefix is still accepted as a
  deprecated fallback; migrate at your own pace.
- State directory: defaults to `~/.config/antechamber`. If that directory
  doesn't exist yet but the legacy `~/.config/openchamber-pi-connector`
  does, the legacy directory is used automatically so existing session
  registries keep working across the upgrade. Move the directory manually
  once you're ready to drop the fallback.
- No action needed for most users: both the binary and environment variable
  fallbacks mean an existing OpenChamber `settings.json` pointing at
  `opencode-pi` keeps working unchanged.

### Changed

- OmO is now the default backend: antechamber spawns `omo` unless
  `ANTECHAMBER_PI_BINARY` says otherwise, and the agent directory follows
  OmO's resolution (`OMO_CODING_AGENT_DIR` > `SENPI_CODING_AGENT_DIR` >
  `PI_CODING_AGENT_DIR`, default `~/.omo/agent`; `~/.pi/agent` when the backend
  is `pi`). A standard OmO install is advertised as the `OmO` agent without
  setting `ANTECHAMBER_AGENT`. Plain pi remains available as an opt-in,
  best-effort backend (`ANTECHAMBER_PI_BINARY=pi`).

### Added

- OmO Graph, an OpenChamber extension in `extensions/omo-dag`. It draws the
  OmO sub-agents behind the open session as a live graph:
  - cards are grouped in waves and show each sub-agent's state, duration,
    agent and model;
  - hovering a card highlights its input and output edges;
  - clicking a card opens the sub-agent's session.

  The extension is built by `npm run build`, is covered by `npm test`,
  typecheck and lint, and ships in the npm package. It reads OmO's task store
  and the session registry read-only, through an OpenChamber-managed local
  service.
- `antechamber setup` ends by printing the bundled OmO Graph extension folder
  to add in OpenChamber (Settings → Extensions → Add → Folder), and every
  GitHub release attaches `antechamber-omo-graph.zip`, installable from
  OpenChamber by URL
  (`https://github.com/eliottness/antechamber/releases/latest/download/antechamber-omo-graph.zip`).
- npm-first installation with `antechamber setup`: settings discovery,
  isolated profiles, executable selection, timestamped backups, idempotency,
  dry-run plans, and optional systemd user drop-ins with explicit restart.
- Read-only `antechamber doctor` diagnostics with text/JSON output, backend
  checks, agent/state directory checks, OpenChamber wiring and pidfd capability.
- Explicit `serve`, `setup`, `doctor`, `version`, and `help` commands. Package
  versions now come from `package.json`; the OpenChamber `--version` probe
  keeps advertising `opencode v2.0.18`.
- Public npm publication configuration with provenance and an executable
  built CLI, plus installation, upgrade and rollback documentation.
- Tag-driven release workflow: a `vX.Y.Z` tag runs the checks, publishes to
  npm with provenance (trusted publishing or `NPM_TOKEN`) and creates the
  GitHub release from this file. See [docs/releasing.md](docs/releasing.md).
- Security hardening: optional HTTP Basic auth (`OPENCODE_SERVER_PASSWORD`),
  `Origin` checks for unauthenticated servers, a non-loopback-bind guard, and
  request/SSE/search limits. See [docs/configuration.md](docs/configuration.md#security).
- OpenCode v2 API support (`@opencode-ai/sdk/v2`), alongside the original v1
  surface, covering the endpoints OpenChamber >= 2.0.4 depends on.
- [OmO](https://github.com/omo-ai) backend support (a pi-compatible
  coding-agent distribution, aka senpi / oh-my-pi), including OmO-specific
  session-tree fork/revert/unrevert, subagent and task cards, todo bridging,
  and thinking-level mapping.
- Session fork, revert, and unrevert backed by the agent's native session
  tree rather than a filesystem snapshot.
- Subagent and task cards rendered as native OpenChamber tool parts.
- Approval and question bridging through the agent's extension-UI protocol.
- Thinking-level selection surfaced through OpenChamber's model picker.
- Shell run cards (user-invoked `!command` execution) with cancellation.
- Session diff endpoint returning a unified patch independent of
  OpenChamber's own git integration.
- Session persistence and revival across connector restarts.
- Idle session reaping and a configurable cap on concurrent live agent
  processes (lifecycle caps).

### Fixed

- Slash commands sent through `POST /session/:id/command` (for example
  `/skill:<name> ...`) now reuse OpenChamber's client `messageID`, so the user
  message no longer appears twice in the chat.
- With a server password configured, requests carrying a non-loopback
  `Origin` (forwarded by OpenChamber's proxy for LAN browsers and the desktop
  app) are no longer rejected with 403; the password is the boundary.
- Turn statistics now use the native assistant stop reason independently of
  usage, normalize tool-call finishes, and preserve tokens, cost, errors, and
  response-model attribution in v1 and v2 history. Restored messages retain
  their provider-to-append duration when valid timestamps are available.
- Native session titles replace provisional first-message titles and persist
  through reload and revival. Explicit user titles win over delayed native
  generation; scans read the latest native name even beyond the transcript
  head limit. Both OmO and Senpi client capability variables now advertise
  `auto_title_sessions` and `question` while preserving inherited capabilities.
  Historical title generation for old unnamed sessions is deferred to a
  follow-up; existing native names are restored without adding a conversation
  turn.
- Busy prompts now carry native steer/follow-up admission behavior and stable
  client message IDs instead of waiting behind a running turn until the RPC
  timeout. v1 defaults to steering; v2 validates and honors steer/queue delivery,
  publishes inbox acceptance and consumption, and restores durable pending
  input without duplicating consumed user cards or changing assistant parents.
- Structured `ask_user_question` requests now remain visible after a
  nonblocking tool finishes. OpenChamber 1.24.2 receives v1 question
  events and lists; OpenChamber 2.x receives native forms, including
  multiselect, custom text, partial answers, comments, and cancellation.
  Replies use correlated native acknowledgments rather than sending a
  duplicate prompt.
- Pending native questions hydrate on session revival with stable public
  IDs and refreshed connection IDs. Dormant-session dangling-question
  scanning without revival is deliberately omitted: those questions enter
  lists only after revival. Native repeated-crash recovery limitations
  remain; no native recovery code is changed.

### History

Everything before this release lived under the `openchamber-pi-connector`
name, originally authored by qingzhu521 (xiuli.qz) as a minimal pi-backed
OpenCode-API adapter for OpenChamber, and MIT-licensed. This fork retained
that license and extended the project substantially; see the README's
Credits section.
