# OpenCode MITM capture

`opencode-mitm` is a drop-in `opencodeBinary` wrapper for OpenChamber. It starts
the real OpenCode server on a private ephemeral loopback port, exposes the
requested public address through a transparent Node HTTP proxy, and appends
redacted JSONL capture events to `OPENCODE_MITM_LOG`.

It uses Node built-ins only. The launcher runs the TypeScript files with
`node --experimental-strip-types`; `tsx` is also suitable for running
`catalog.ts` directly.

## Safety and scope

- The real binary is `OPENCODE_MITM_REAL_BINARY`, or `opencode` on `PATH`.
- `--version` and `-v` are executed against that real binary unchanged.
- `serve --hostname H --port P ...` runs the real server as
  `serve --hostname 127.0.0.1 --port <ephemeral> ...`; the proxy listens on
  `H:P`.
- The launcher prints the public listener banner OpenChamber needs before
  forwarding the real server's stdout and stderr unchanged. `SIGINT`,
  `SIGTERM`, and `SIGHUP` terminate both child processes.
- Never put secrets in the capture file. Authorization and Cookie headers,
  values named like API keys or tokens, home-directory paths, and hostnames are
  redacted. Captured text stops at 64 KiB per event.

## Prerequisites

1. Make the launcher executable:

   ```sh
   chmod +x /absolute/path/to/antechamber/contrib/opencode-mitm/opencode-mitm
   ```

2. Ensure the OpenChamber process can find Node 22 or later and the real
   OpenCode binary. Set explicit paths when necessary:

   ```sh
   export OPENCODE_MITM_REAL_BINARY=/absolute/path/to/opencode
   export OPENCODE_MITM_NODE_BINARY=/absolute/path/to/node
   export OPENCODE_MITM_LOG=/secure/path/opencode-mitm.jsonl
   ```

   `OPENCODE_MITM_LOG` is required. Its parent directory must already exist.

## OpenChamber 1.24.2

Set `settings.opencodeBinary` to the absolute launcher path in the
OpenChamber Settings UI, or place the same property in the instance settings:

```json
{
  "opencodeBinary": "/absolute/path/to/antechamber/contrib/opencode-mitm/opencode-mitm"
}
```

Export `OPENCODE_MITM_LOG` in the environment that starts OpenChamber, then
restart its server. Version 1.24.2 invokes:

```text
<opencodeBinary> serve --hostname H --port P
```

It recognizes `opencode server listening on http://…` on stdout and then
polls `GET /global/health` until the proxied real server reports
`{"healthy":true}`. The wrapper advertises the proxy address, so those polls
and all later API traffic are captured.

## OpenChamber 2.3.2

Use the same `settings.opencodeBinary` value and inherited environment:

```json
{
  "opencodeBinary": "/absolute/path/to/antechamber/contrib/opencode-mitm/opencode-mitm"
}
```

OpenChamber 2.3.2 first calls `opencodeBinary --version`; the wrapper passes
that through unchanged. It requires real OpenCode 2.0.20 or newer. During
startup it accepts the wrapper's listener banner and polls `GET /api/info`,
which must identify a supported OpenCode 2.x server. A real OpenCode 1.x
binary remains usable with OpenChamber 1.24.2 only.

## Standalone launch

This is the same command OpenChamber uses:

```sh
OPENCODE_MITM_LOG="$PWD/opencode-mitm.jsonl" \
OPENCODE_MITM_REAL_BINARY="$(command -v opencode)" \
/absolute/path/to/antechamber/contrib/opencode-mitm/opencode-mitm \
  serve --hostname 127.0.0.1 --port 47160
```

The first listener line names `127.0.0.1:47160`. The later real-server banner
contains only its private loopback port and is forwarded for diagnostics.

## Capture format

Each JSONL object contains:

```json
{
  "t": "2026-10-14T12:34:56.789Z",
  "kind": "request | response | sse | ws",
  "id": "shared HTTP exchange or WebSocket connection id",
  "method": "GET",
  "path": "/session/:id",
  "query": "",
  "status": 200,
  "headers": {},
  "body": {}
}
```

- `request` and `response` record each HTTP exchange without buffering the
  forwarded stream.
- `sse` adds `event` and records each completed SSE event frame while the
  stream remains live.
- `ws` adds `channel`, `direction`, `opcode`, `fin`, and `payloadBytes`.
  Frames are piped unchanged in both directions; text and JSON payloads are
  recorded up to the capture limit.

## Generate a route catalog

```sh
node --experimental-strip-types \
  /absolute/path/to/antechamber/contrib/opencode-mitm/catalog.ts \
  "$OPENCODE_MITM_LOG" > opencode-catalog.md
```

The report groups HTTP requests by `METHOD /templated/:id/path`, lists observed
statuses and request/response field-path type unions, and includes an example.
It also catalogs SSE event names and WebSocket channels.
