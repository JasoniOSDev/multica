#!/usr/bin/env bash
#
# join-inhouse.sh — point THIS machine's Multica daemon at the in-house
# self-hosted server (devBox) and register it as an agent runtime, in one shot.
#
#   Usage:  scripts/join-inhouse.sh <mul_PAT> [profile]
#
#   - <mul_PAT>  Personal Access Token from the in-house UI
#                (http://10.37.16.72:3000 -> Settings -> tokens), account 417033420@qq.com.
#   - [profile]  Local profile name to isolate this connection (default: inhouse).
#
# Override the target via env if it ever moves:
#   MULTICA_INHOUSE_SERVER (default http://10.37.16.72:18081)
#   MULTICA_INHOUSE_WS     (default Happy_Inhouse id)
#
# Prereqs on the machine: the `multica` CLI on PATH (official, or the fork build
# `multica-dev` for native ccrcode) and at least one agent CLI (claude/codex/
# openclaw; plus `ccr` for ccrcode). The machine must reach the server's network.
#
set -euo pipefail

PAT="${1:-}"
PROFILE="${2:-inhouse}"
SERVER="${MULTICA_INHOUSE_SERVER:-http://10.37.16.72:18081}"
WS="${MULTICA_INHOUSE_WS:-767b6df7-d6fe-4360-86da-5cf123329f39}"  # Happy_Inhouse

if [ -z "$PAT" ]; then
  echo "Usage: $0 <mul_PAT> [profile]"
  echo "  Get a PAT at ${SERVER%:*}:3000 -> Settings -> tokens (account 417033420@qq.com)."
  exit 2
fi

# Prefer the fork source-built CLI (has native ccrcode); fall back to official.
MULTICA="$(command -v multica-dev 2>/dev/null || command -v multica 2>/dev/null || true)"
if [ -z "$MULTICA" ]; then
  echo "ERROR: no multica CLI on PATH."
  echo "  Official:  brew install multica  (or the install script)"
  echo "  Fork (for ccrcode):  git clone https://github.com/JasoniOSDev/multica && cd multica && make build"
  echo "      then: ln -sf \"\$PWD/server/bin/multica\" ~/.local/bin/multica-dev"
  exit 1
fi

# The Multica desktop app injects MULTICA_TOKEN/SERVER_URL/WORKSPACE_ID into the
# environment, which OVERRIDE the profile config and send requests to the cloud.
# Strip every MULTICA_* var so the profile is authoritative.
mc() { env $(env | grep -oE '^MULTICA_[A-Z_]+' | sed 's/^/-u /' | tr '\n' ' ') "$MULTICA" --profile "$PROFILE" "$@"; }

echo "[1/5] reachability -> $SERVER"
curl -fsS -o /dev/null --max-time 8 "$SERVER/health" \
  || { echo "  ERROR: cannot reach $SERVER (need the internal network / VPN)"; exit 1; }

echo "[2/5] login (profile: $PROFILE) using \"$MULTICA\""
mc login --token "$PAT" --server-url "$SERVER" >/dev/null

echo "[3/5] select workspace Happy_Inhouse"
mc workspace switch "$WS" >/dev/null 2>&1 || true

echo "[4/5] start daemon"
mc daemon restart >/dev/null 2>&1 || mc daemon start >/dev/null
sleep 4

echo "[5/5] verify"
mc daemon status 2>/dev/null | sed 's/^/  /'
echo "  runtimes registered:"
mc runtime list --output json 2>/dev/null \
  | python3 -c "import sys,json;[print('   -',r['provider'],r['status']) for r in json.load(sys.stdin)]" \
  || mc runtime list 2>/dev/null

echo
echo "Done — this machine is now an agent runtime in Happy_Inhouse."
echo "Notes: the daemon does NOT auto-start on reboot (re-run this, or add a service)."
echo "       For a SECOND daemon on the SAME machine, also pass a unique --daemon-id."
