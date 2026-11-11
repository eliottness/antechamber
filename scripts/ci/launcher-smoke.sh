#!/usr/bin/env bash
# Packs this checkout, installs it through the extension's launcher into an empty runtime dir, and serves
# /global/health from it with a fake agent. Needs a build (npm run build) and Bun. Linux and macOS CI run it.
set -euo pipefail
work="$(mktemp -d)"
npm pack --pack-destination "$work" > /dev/null
export ANTECHAMBER_RUNTIME_DIR="$work/runtime" ANTECHAMBER_RUNTIME_SPEC="$(ls "$work"/antechamber-*.tgz)"
launcher=extensions/antechamber/bin/opencode-antechamber
test "$($launcher --version)" = "$(bun dist/cli.js --version)"
test ! -e "$ANTECHAMBER_RUNTIME_DIR"
$launcher upgrade | grep -q 'Settings -> Extensions'
mkdir "$work/agent"
ANTECHAMBER_STATE_DIR="$work/state" ANTECHAMBER_PI_BINARY="$PWD/test/fixtures/turn-omo.mjs" PI_CODING_AGENT_DIR="$work/agent" \
  $launcher serve --hostname 127.0.0.1 --port 4097 > "$work/out.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; cat "$work/out.log"' EXIT
for _ in $(seq 1 1200); do grep -q '^opencode server listening on http://127.0.0.1:4097$' "$work/out.log" && break; sleep 0.1; done
curl -fsS http://127.0.0.1:4097/global/health | grep -q '"healthy":true'
ls "$ANTECHAMBER_RUNTIME_DIR"/local-*/node_modules/omo-ai/bin/omo.js
kill -TERM "$server"
wait "$server"
