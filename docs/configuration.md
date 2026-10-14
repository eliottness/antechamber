# Configuration

All settings are read from environment variables. Each one is read under its
current `ANTECHAMBER_` name first; if that's unset, antechamber falls back to
the deprecated `OCPI_` name for compatibility with existing deployments. Set
either, but prefer the `ANTECHAMBER_` name for anything new. A blank value
(empty string) counts as unset.

## Reference

| Variable | Legacy name | Default | Description |
|---|---|---|---|
| `ANTECHAMBER_PI_BINARY` | `OCPI_PI_BINARY` | `omo` (resolved on `PATH`) | Agent executable antechamber spawns per session. OmO is the supported default; set `pi` (or a path to it) to use plain pi on a best-effort basis. |
| `ANTECHAMBER_PI_ARGS` | `OCPI_PI_ARGS` | (none) | Extra arguments passed to the agent binary, split on whitespace. |
| `ANTECHAMBER_STATE_DIR` | `OCPI_STATE_DIR` | `~/.config/antechamber` | Directory for the session registry and archived child transcripts. Falls back to `~/.config/openchamber-pi-connector` automatically when only that legacy directory exists, so existing session mappings survive an upgrade. |
| `ANTECHAMBER_AGENT` | `OCPI_AGENT` | detected | Agent name antechamber advertises to OpenChamber. If unset, detected from `oh-my-pi.jsonc` next to the agent directory (`orchestrator.agentName`; `//` and `/* */` comments allowed), then `OmO` if `omo.jsonc` sits next to the agent directory (a standard OmO install), then `oh-my-pi` if that package is listed in `<agent dir>/settings.json`, then `build`. |
| `ANTECHAMBER_IDLE_TIMEOUT_MS` | `OCPI_IDLE_TIMEOUT_MS` | `900000` (15 minutes) | Milliseconds of inactivity before an idle agent session is reaped. Must be a positive integer. |
| `ANTECHAMBER_MAX_LIVE` | `OCPI_MAX_LIVE` | `8` | Maximum number of concurrently live agent processes. Must be a positive integer. |
| `ANTECHAMBER_DEBUG` | `OCPI_DEBUG` | unset (disabled) | Any non-empty value enables request/event debug logging. |
| `ANTECHAMBER_DEBUG_LOG` | `OCPI_DEBUG_LOG` | `<os tmpdir>/antechamber-debug-<uid>.log` (created mode `0600`) | Path for the debug log when `ANTECHAMBER_DEBUG` is set. A write failure disables logging for the rest of the process and prints one warning; it never crashes the server. |
| `ANTECHAMBER_OPENCODE_COMPAT_VERSION` | `OCPI_OPENCODE_COMPAT_VERSION` | unset | Overrides the `version` field `GET /global/health` reports. Unset means `null`, so OpenChamber's update checker reports no available update instead of reporting every adapter version as outdated. |
| `OMO_CODING_AGENT_DIR` | `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR` (read directly, in that order, matching OmO; no `ANTECHAMBER_`/`OCPI_` prefix) | `~/.omo/agent` (`~/.pi/agent` when the backend binary is `pi`) | Agent state directory: sessions, child transcripts, and config discovery (agent name, models). |

Non-prefixed CLI flags (`--port`, `--host`/`--hostname`, `--directory`) are
set on the command line, not through environment variables; see the README's
Quick start section and `antechamber --help` behavior in `src/cli.ts`.

## Security

| Variable / flag | Default | Description |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | unset (no auth) | Enables HTTP Basic auth on every route, including `/global/health` and the SSE streams, matching [OpenCode's server contract](https://opencode.ai/docs/server/#authentication). Takes precedence over `ANTECHAMBER_SERVER_PASSWORD`. |
| `ANTECHAMBER_SERVER_PASSWORD` (legacy `OCPI_SERVER_PASSWORD`) | unset | Fallback password when `OPENCODE_SERVER_PASSWORD` is not set. |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic auth username. |
| `ANTECHAMBER_ALLOWED_ORIGINS` (legacy `OCPI_ALLOWED_ORIGINS`) | none | Comma-separated extra browser origins (`https://host:port`). Loopback origins are always allowed; requests carrying any other `Origin` get `403`. CORS headers echo allowed origins only. |
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
   `settings.opencodeBinary` to point at `bin/opencode-antechamber`.
3. Your existing state directory (`~/.config/openchamber-pi-connector` by
   default) is picked up automatically as long as `~/.config/antechamber`
   doesn't exist yet. Once you're ready to drop the legacy path entirely,
   move the directory: `mv ~/.config/openchamber-pi-connector ~/.config/antechamber`.
4. There is no change needed to session data or registry file formats; the
   rename only affects names, not content.
