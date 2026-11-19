#!/usr/bin/env bash
# Runs a real OpenChamber (@openchamber/web, OPENCHAMBER_VERSION or latest) with this checkout as its OpenCode CLI:
# packs antechamber, lets the extension launcher install it and its pinned OmO into an empty runtime dir, and drives
# the real OmO through OpenChamber's /api proxy, up to one completed prompt. The model is scripts/ci/mock-openai.mjs,
# a local OpenAI-compatible fake, so no provider or API key is involved. Needs a build (npm run build), Node and Bun.
# ANTECHAMBER_RUNTIME_DIR, when set, keeps the installed runtime for later steps.
set -euo pipefail
work="$(mktemp -d)"
npm pack --pack-destination "$work" --loglevel=error > /dev/null
export ANTECHAMBER_RUNTIME_DIR="${ANTECHAMBER_RUNTIME_DIR:-$work/runtime}"
spec="$(ls "$work"/antechamber-*.tgz)"
export ANTECHAMBER_RUNTIME_SPEC="$spec"
pin="$(node -p 'require("./package.json").dependencies["omo-ai"]')"

npm install --prefix "$work/openchamber" --no-audit --no-fund --loglevel=error \
  "@openchamber/web@${OPENCHAMBER_VERSION:-latest}" > /dev/null
openchamber="$work/openchamber/node_modules/@openchamber/web"
echo "OpenChamber $(node -p "require('$openchamber/package.json').version"), OmO $pin"

server="" mock=""
cleanup() {
  kill $server $mock 2> /dev/null || true
  wait $server $mock 2> /dev/null || true
  [ -f "$work/openchamber.log" ] && tail -n 80 "$work/openchamber.log"
  [ -f "$work/mock.log" ] && { echo "--- mock provider"; tail -n 20 "$work/mock.log"; }
  rm -rf "$work"
}
trap cleanup EXIT

mock_port=4099
MOCK_PORT="$mock_port" node scripts/ci/mock-openai.mjs > "$work/mock.log" 2>&1 &
mock=$!

# A private HOME and agent dir with OmO's first run already done (as the OmO smoke does), and the mock as its only
# configured model provider.
home="$work/home" project="$work/project" agent="$work/home/.omo/agent"
mkdir -p "$project" "$agent/omo-senpi/omo-native"
printf '{"completedAt":"%s","version":1}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$agent/omo-senpi/omo-native/onboarding-completed"
cat > "$agent/models.json" << JSON
{
  "providers": {
    "mock": {
      "name": "antechamber CI mock",
      "baseUrl": "http://127.0.0.1:$mock_port/v1",
      "api": "openai-completions",
      "apiKey": "mock",
      "models": [
        {
          "id": "mock-pong",
          "name": "Mock pong",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
JSON

port=4098 base="http://127.0.0.1:4098"
HOME="$home" OMO_CODING_AGENT_DIR="$agent" ANTECHAMBER_STATE_DIR="$work/state" \
  ANTECHAMBER_PI_ARGS="--omo-senpi-onboarding-disabled --model mock/mock-pong --thinking off" \
  OPENCODE_BINARY="$PWD/extensions/antechamber/bin/opencode-antechamber" \
  node "$openchamber/bin/cli.js" serve --foreground --port "$port" --host 127.0.0.1 > "$work/openchamber.log" 2>&1 &
server=$!

dir="directory=$(node -p 'encodeURIComponent(process.argv[1])' "$project")"
api() { curl -fsS --max-time 60 "$@"; }
# Each argument is a JavaScript expression over the parsed body `d`, so it stays single-quoted.
# shellcheck disable=SC2016
json() { node -e 'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => { const d = JSON.parse(s); process.stdout.write(String(new Function("d", `return ${process.argv[1]}`)(d))); })' "$1"; }

# The provider catalog comes from a fresh `omo --mode rpc`, so it answering proves the real OmO speaks RPC.
# The first start installs the runtime (bun install of antechamber and OmO), hence the long wait.
for _ in $(seq 1 600); do api "$base/api/provider?$dir" > "$work/providers.json" 2> /dev/null && break; sleep 1; done
# shellcheck disable=SC2016
json 'Array.isArray(d.data) ? d.data.map((p) => `${p.id}:${Object.keys(p.models).length}`).join(" ") || "(none)" : ""' \
  < "$work/providers.json" | sed 's/^/providers: /'
echo
# OmO read the private models.json: the mock model is in the catalog.
test "$(json 'd.data.some((p) => p.id === "mock" && "mock-pong" in p.models)' < "$work/providers.json")" = true

# A reused ANTECHAMBER_RUNTIME_DIR keeps earlier local-* runtimes; this run's is the newest. The launcher names them
# local-<hash>, so sorting ls by time is safe.
# shellcheck disable=SC2012
installed="$(ls -dt "$ANTECHAMBER_RUNTIME_DIR"/local-*/node_modules/omo-ai | head -n 1)"
version="$(node -p "require('$installed/package.json').version")"
test "$version" = "$pin" || { echo "the launcher installed OmO $version, not the pinned $pin" >&2; exit 1; }

session="$(api -X POST -H 'content-type: application/json' -d '{}' "$base/api/session?$dir" | json 'd.data.id')"
echo "session $session created through OpenChamber"

api -X POST -H 'content-type: application/json' -d '{"text":"e2e ping from antechamber CI"}' \
  "$base/api/session/$session/prompt?$dir" > /dev/null
answer=""
for _ in $(seq 1 180); do
  # A transient HTTP error is retried on the next pass rather than failing the run.
  answer="$(api "$base/api/session/$session/message?$dir" 2> /dev/null |
    json 'd.data.filter((m) => m.type === "assistant").flatMap((m) => m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ")' 2> /dev/null || true)"
  [ "$answer" = pong ] && break
  sleep 1
done
echo "assistant: $answer"
test "$answer" = pong || { echo "the mock's reply never reached OpenChamber" >&2; exit 1; }
# The reply came from this run's prompt, through OmO's provider client, not from a cached or canned answer.
grep -qF 'user="e2e ping from antechamber CI"' "$work/mock.log" ||
  { echo "OmO never sent the prompt to the mock provider" >&2; exit 1; }
