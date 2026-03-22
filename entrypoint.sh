#!/bin/sh
set -e

BASE_URL="https://unitedstates.github.io/congress-legislators"
DATA_DIR="${CONGRESS_DATA_DIR:-/data/congress}/legislators"

mkdir -p "$DATA_DIR"

# ── Refresh legislator data on startup ────────────────────────────────────────
# Controlled by REFRESH_LEGISLATORS_ON_START env var (default: true).
# Set to "false" to skip the download and use whatever is already on disk
# (useful if the volume already has recent data and you want faster startup).

if [ "${REFRESH_LEGISLATORS_ON_START}" != "false" ]; then
  echo "[entrypoint] Fetching latest legislator data from theunitedstates.io..."

  fetch() {
    local name="$1"
    local dest="$DATA_DIR/$name"
    if curl -fsSL --max-time 30 "$BASE_URL/$name" -o "$dest.tmp"; then
      mv "$dest.tmp" "$dest"
      echo "[entrypoint] ✓ $name"
    else
      echo "[entrypoint] ✗ Failed to fetch $name — using cached version if available"
      rm -f "$dest.tmp"
    fi
  }

  fetch "legislators-current.json"
  fetch "legislators-historical.json"

  echo "[entrypoint] Legislator data ready."
else
  echo "[entrypoint] Skipping legislator refresh (REFRESH_LEGISLATORS_ON_START=false)."
fi

# ── Start the MCP server ──────────────────────────────────────────────────────
exec node /app/dist/index.js