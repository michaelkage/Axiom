#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

# Axiom Android bridge bootstrap.
# Run inside Termux on a 64-bit ARM Android device.
# This installs a community Termux build of Ollama and starts Axiom's local gateway.

fail() { printf '\n[Axiom setup] ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '\n[Axiom setup] %s\n' "$*"; }

[[ -n "${PREFIX:-}" && -d "${PREFIX:-/nonexistent}" ]] || fail "Run this script inside the Termux app, not Android shell or Axiom's built-in terminal."
[[ "$(uname -m)" == "aarch64" ]] || fail "This Ollama Termux build currently targets 64-bit ARM (aarch64). Detected: $(uname -m)."
command -v pkg >/dev/null 2>&1 || fail "Termux package manager 'pkg' was not found."

OLLAMA_TERMUX_VERSION="0.33.1-termux"
AXIOM_RUNTIME_DIR="${HOME}/.local/share/axiom-gateway-runtime"
OLLAMA_LOG="${HOME}/.axiom-ollama.log"
OLLAMA_PID="${HOME}/.axiom-ollama.pid"

info "Updating Termux packages and installing Node.js, Git, and curl."
pkg update -y
pkg upgrade -y
pkg install -y nodejs-lts git curl coreutils

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 20 )) || fail "Axiom gateway requires Node.js 20+. Detected Node.js $(node --version)."

if ! command -v ollama >/dev/null 2>&1; then
  info "Installing the pinned ARM64 Termux Ollama distribution ($OLLAMA_TERMUX_VERSION)."
  npm install --global "@mmmbuto/ollama-termux@${OLLAMA_TERMUX_VERSION}"
  # The package installer verifies the matching GitHub release archive's SHA-256.
  ollama-termux
else
  info "Ollama is already installed; leaving the existing installation untouched."
fi

command -v ollama >/dev/null 2>&1 || fail "Ollama installer finished but the 'ollama' command is still unavailable."

if ! curl --silent --fail --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
  info "Starting Ollama in the background (logs: $OLLAMA_LOG)."
  nohup ollama serve >"$OLLAMA_LOG" 2>&1 </dev/null &
  echo "$!" > "$OLLAMA_PID"

  ready=0
  for attempt in $(seq 1 60); do
    if curl --silent --fail --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  (( ready == 1 )) || {
    tail -n 40 "$OLLAMA_LOG" >&2 || true
    fail "Ollama did not become ready. Check $OLLAMA_LOG."
  }
else
  info "An Ollama API is already responding on 127.0.0.1:11434."
fi

if [[ ! -d "$AXIOM_RUNTIME_DIR/.git" ]]; then
  mkdir -p "$(dirname "$AXIOM_RUNTIME_DIR")"
  info "Downloading Axiom gateway source into $AXIOM_RUNTIME_DIR."
  git clone --depth 1 --branch main https://github.com/michaelkage/Axiom.git "$AXIOM_RUNTIME_DIR"
else
  info "Updating the dedicated Axiom gateway checkout."
  git -C "$AXIOM_RUNTIME_DIR" pull --ff-only origin main || fail "Could not fast-forward the gateway checkout. Resolve it manually at $AXIOM_RUNTIME_DIR."
fi

cd "$AXIOM_RUNTIME_DIR/pwa"
[[ -f gateway/server.mjs ]] || fail "Axiom gateway source is missing from the checkout."

info "Ollama is ready at http://127.0.0.1:11434."
info "Starting the Axiom gateway at http://127.0.0.1:8787."
command -v am >/dev/null 2>&1 || fail "Android activity manager 'am' is unavailable. Open Termux normally and retry."
export OLLAMA_BASE_URL="http://127.0.0.1:11434"
export AXIOM_GATEWAY_HOST="127.0.0.1"
export AXIOM_GATEWAY_PORT="8787"

info "Starting the Axiom gateway in the background."
nohup node gateway/server.mjs > "${HOME}/.axiom-gateway.log" 2>&1 </dev/null &
GATEWAY_PID=$!
trap 'kill "$GATEWAY_PID" 2>/dev/null || true' EXIT INT TERM

ready=0
for attempt in $(seq 1 30); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:8787/health >/dev/null; then
    ready=1
    break
  fi
  kill -0 "$GATEWAY_PID" 2>/dev/null || break
  sleep 1
done
(( ready == 1 )) || {
  tail -n 40 "${HOME}/.axiom-gateway.log" >&2 || true
  fail "Axiom gateway did not become ready. Check ~/.axiom-gateway.log."
}

PAIRING_TOKEN="$(cat "${HOME}/.config/axiom/gateway-token")"
[[ "${#PAIRING_TOKEN}" -eq 64 ]] || fail "The gateway pairing credential is missing or invalid."
info "Gateway is ready. Handing pairing securely to the installed Axiom app."
am start -n com.axiom.mobile/.MainActivity -a android.intent.action.VIEW -d "axiom://gateway-pair?token=${PAIRING_TOKEN}" >/dev/null
unset PAIRING_TOKEN
info "Axiom will import the credential into Android Keystore and register its session automatically."
info "Keep Termux running while using the gateway. Stop it with Ctrl+C."
wait "$GATEWAY_PID"
