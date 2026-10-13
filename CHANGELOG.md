# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Security hardening in progress: optional HTTP Basic auth
  (`OPENCODE_SERVER_PASSWORD`), non-loopback `Origin` rejection, a
  non-loopback-bind guard, and a request body size limit. See
  [docs/configuration.md](docs/configuration.md) for exact variable names
  once landed.

## [0.1.0] - 2026-10-13

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

### Added

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

### History

Everything before this release lived under the `openchamber-pi-connector`
name, originally authored by qingzhu521 (xiuli.qz) as a minimal pi-backed
OpenCode-API adapter for OpenChamber, and MIT-licensed. This fork retained
that license and extended the project substantially; see the README's
Credits section.
