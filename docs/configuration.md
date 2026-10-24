# Configuration

Connector settings are read under their current `ANTECHAMBER_` name first; if
that's unset, antechamber falls back to the deprecated `OCPI_` name for
compatibility with existing deployments. Set either, but prefer the
`ANTECHAMBER_` name for anything new. A blank value (empty string) counts as
unset. The OmO/Senpi RPC capability variables below are direct passthrough
inputs and do not have `ANTECHAMBER_` or `OCPI_` aliases.

## Reference

| Variable | Legacy name | Default | Description |
|---|---|---|---|
| `ANTECHAMBER_PI_BINARY` | `OCPI_PI_BINARY` | `omo` (resolved on `PATH`) | Agent executable antechamber spawns per session. OmO is the supported default; set `pi` (or a path to it) to use plain pi on a best-effort basis. |
| `ANTECHAMBER_PI_ARGS` | `OCPI_PI_ARGS` | (none) | Extra arguments passed to the agent binary, split on whitespace. |
| `ANTECHAMBER_STATE_DIR` | `OCPI_STATE_DIR` | `~/.config/antechamber` | Directory for the session registry, archived child transcripts, and inline prompt attachments the agent RPC cannot carry natively (`attachments/`, such as uploaded PDFs; not cleaned up automatically). Falls back to `~/.config/openchamber-pi-connector` automatically when only that legacy directory exists, so existing session mappings survive an upgrade. `serve` also writes `run/<pid>.json` here (0600): its version and URL for `antechamber doctor`, and the token the OmO Work extension uses. Extension services do not see this variable; enter a custom value in the OmO Work and OmO Graph data-path settings. |
| `ANTECHAMBER_AGENT` | `OCPI_AGENT` | detected | Agent name antechamber advertises to OpenChamber. If unset, detected from `oh-my-pi.jsonc` next to the agent directory (`orchestrator.agentName`; `//` and `/* */` comments allowed), then `OmO` if `omo.jsonc` sits next to the agent directory (a standard OmO install), then `oh-my-pi` if that package is listed in `<agent dir>/settings.json`, then `build`. |
| `ANTECHAMBER_IDLE_TIMEOUT_MS` | `OCPI_IDLE_TIMEOUT_MS` | `900000` (15 minutes) | Milliseconds of inactivity before an idle agent session is reaped. A session with a live terminal monitor, detached eval cell or background terminal session is never reaped. Must be a positive integer. |
| `ANTECHAMBER_MAX_LIVE` | `OCPI_MAX_LIVE` | `8` | Maximum number of concurrently live agent processes. Must be a positive integer. |
| `ANTECHAMBER_DEBUG` | `OCPI_DEBUG` | unset (disabled) | Any non-empty value enables request/event debug logging. |
| `ANTECHAMBER_DEBUG_LOG` | `OCPI_DEBUG_LOG` | `<os tmpdir>/antechamber-debug-<uid>.log` (created mode `0600`) | Path for the debug log when `ANTECHAMBER_DEBUG` is set. A write failure disables logging for the rest of the process and prints one warning; it never crashes the server. |
| `ANTECHAMBER_AUTO_UPDATE` | `OCPI_AUTO_UPDATE` | unset | `1` makes `serve` check npm for a newer antechamber after it starts listening and install it in the background with the package manager that owns the global install; the new version runs from the next start. Failures and unsupported installs (source checkout, `npx`) are logged to stderr and never stop the server. The launcher written by `antechamber setup --auto-update` sets it. The installer is the `npm` beside the running `node` (else `npm` on PATH) or `$BUN_INSTALL/bin/bun` (default `~/.bun`, else `bun` on PATH), so a service PATH without those directories still works. The version lookup reads `npm_config_registry` (credentials in it are stripped) but not `.npmrc`. |
| `ANTECHAMBER_OPENCODE_COMPAT_VERSION` | `OCPI_OPENCODE_COMPAT_VERSION` | unset | Overrides the OpenCode version antechamber reports in `GET /global/health` and `GET /api/info`. Unset, `/global/health` omits `version`, so OpenChamber 1.x's update checker reports no available update, and `/api/info` reports `2.0.20`, the minimum OpenCode version OpenChamber 2.3.2 accepts. OpenChamber 2.3.2 compares that value with the latest OpenCode release and can show an "OpenCode update" notice whose Update button upgrades antechamber; see [Upgrade, uninstall and rollback](../README.md#upgrade-uninstall-and-rollback). |
| `OMO_CODING_AGENT_DIR` | `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` (read directly, in that order, matching OmO; no `ANTECHAMBER_`/`OCPI_` prefix) | `~/.omo/agent` (`~/.pi/agent` when the backend binary is `pi`) | Agent state directory: sessions, child transcripts, and config discovery (agent name, models). |
| `OMO_RPC_CLIENT_CAPABILITIES` | none | inherited, then adapter additions | Comma-separated RPC client capabilities inherited from the environment. Antechamber merges this list first with `SENPI_RPC_CLIENT_CAPABILITIES`, trims and deduplicates entries, then adds `auto_title_sessions` and `question`; it writes the combined list to both variables for the agent process. |
| `SENPI_RPC_CLIENT_CAPABILITIES` | none | inherited, then adapter additions | Comma-separated RPC client capabilities merged after `OMO_RPC_CLIENT_CAPABILITIES`. Entries are trimmed and deduplicated; antechamber always adds `auto_title_sessions` and `question`, then writes the combined list to both capability variables for the agent process. |

Non-prefixed CLI flags (`--port`, `--host`/`--hostname`, `--directory`) are
set on the command line, not through environment variables; see the README's
Quick start section and `antechamber --help`.

## OpenChamber setup

`antechamber setup` sets `opencodeBinary` to this installation's absolute
`antechamber` executable on PATH, or its executable `dist/cli.js` if PATH
points at a different installation. `--binary <path>` selects an explicit
executable. The npm bin works directly; the `bin/opencode-antechamber`
launcher is only needed in source checkouts.

`--auto-update` instead writes `<state dir>/opencode-antechamber` (the
`ANTECHAMBER_STATE_DIR` default, `~/.config/antechamber`), a `/bin/sh`
launcher that exports `ANTECHAMBER_AUTO_UPDATE=1` and execs the executable
above, and points `opencodeBinary` at it. It requires a global npm or bun
install (detected from `npm root -g` or `$BUN_INSTALL`, default `~/.bun`) and
fails otherwise. `doctor` accepts the launcher when it targets this
installation. Running setup without the flag points `opencodeBinary` back at
the executable and leaves the launcher file unused.

Settings-file precedence:

1. `--settings <file>`.
2. `--profile <dir>` uses `<dir>/settings.json`, creates it when missing, and
   prints an `OPENCHAMBER_DATA_DIR=<dir> openchamber serve` command.
3. `OPENCHAMBER_DATA_DIR` uses that directory's `settings.json`.
4. `~/.config/openchamber/settings.json`.

Existing keys are preserved. Before modifying an existing file, setup copies
it to `<file>.bak-antechamber-<YYYYMMDDHHMMSS>` (UTC). Already configured files
are left untouched. Invalid JSON or non-object settings are rejected.
`--dry-run` prints the proposed change and backups without writing anything.

`--systemd [unit]` defaults to `openchamber.service`. It writes
`~/.config/systemd/user/<unit>.d/antechamber.conf` with the current PATH,
`ANTECHAMBER_PI_BINARY` set to the absolute `omo` executable found on PATH
(or `--pi-binary <path>`), `KillMode=control-group`, and `TimeoutStopSec=20`.
Existing drop-ins are backed up before changes. Other drop-ins setting
`ANTECHAMBER_*` or `OCPI_*` produce warnings; later files override earlier
ones. The printed daemon-reload/restart command runs only with `--restart`.
For a service using a custom data directory, target the same settings file
with `--settings` or `--profile`; `--profile` does not change the service's
`OPENCHAMBER_DATA_DIR` environment.

`antechamber doctor` checks the current environment without creating or
modifying directories or settings. It accepts the same `--settings` and
`--profile` selection and `--json` for a report with `checks` (name, status,
message) and `exitCode`. Missing backend/agent directories, unsupported Node,
or unwritable state directories are FAIL; optional OpenChamber configuration
and private-host teardown capability issues are WARN. Authentication presence
is informational and never exposes the password.

## Security

| Variable / flag | Default | Description |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | unset (no auth) | Enables HTTP Basic auth on every route, including `/global/health` and the SSE streams, matching [OpenCode's server contract](https://opencode.ai/docs/server/#authentication). Takes precedence over `ANTECHAMBER_SERVER_PASSWORD`. |
| `ANTECHAMBER_SERVER_PASSWORD` (legacy `OCPI_SERVER_PASSWORD`) | unset | Fallback password when `OPENCODE_SERVER_PASSWORD` is not set. |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic auth username. |
| `ANTECHAMBER_ALLOWED_ORIGINS` (legacy `OCPI_ALLOWED_ORIGINS`) | none | Comma-separated extra browser origins (`https://host:port`). The adapter's exact origin and HTTP(S) loopback origins (including a different loopback port) are allowed by default. Without a server password, another `Origin` gets `403` unless listed here. With a password, other origins may make authenticated requests but receive no CORS headers unless explicitly allowed. CORS headers echo allowed origins only. |
| `ANTECHAMBER_MAX_BODY_BYTES` (legacy `OCPI_MAX_BODY_BYTES`) | `10485760` (10 MiB) | Maximum request body; larger bodies get `413`. Malformed JSON or a non-object body gets `400`. |
| `ANTECHAMBER_ALLOW_INSECURE` (legacy `OCPI_ALLOW_INSECURE`) | unset | Set to exactly `1` to allow binding a non-loopback host without a password. |
| `--insecure-no-auth` (CLI flag) | absent | Same as `ANTECHAMBER_ALLOW_INSECURE=1`. |

Without a password (or one of the two opt-outs), `antechamber` refuses to start
on a non-loopback `--host`/`--hostname`.

Fixed limits that are not configurable: at most 64 concurrent SSE subscribers
(`503` beyond that), a subscriber whose unsent output exceeds 8 MiB is
disconnected, file search visits at most 1,024 directories (depth 32) and
returns at most 1,000 results, and directory listings return at most 1,000
entries. A single agent RPC message is capped at 64 MiB.

## Migrating from `openchamber-pi-connector`

If you have an existing deployment:

1. You don't have to change anything immediately. Every `OCPI_*` variable you
   already set keeps working as a fallback, and `bin/opencode-pi` still
   works as a shim for `bin/opencode-antechamber`.
2. When you're ready, rename your environment variables from `OCPI_*` to
   `ANTECHAMBER_*` (same suffix, same value) and update
   `settings.opencodeBinary` by running `antechamber setup` (or point at
   `bin/opencode-antechamber` in a source checkout).
3. Your existing state directory (`~/.config/openchamber-pi-connector` by
   default) is picked up automatically as long as `~/.config/antechamber`
   doesn't exist yet. Once you're ready to drop the legacy path entirely,
   move the directory: `mv ~/.config/openchamber-pi-connector ~/.config/antechamber`.
4. There is no change needed to session data or registry file formats; the
   rename only affects names, not content.
