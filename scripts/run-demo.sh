#!/usr/bin/env bash
# One-command reproducible proof of the full ONYX demo journey on devnet:
#   create (sealed market) -> place a sealed bet -> liquidity seeded live via
#   /api/house-counter -> reveal -> permissionless batch match -> real
#   validate_stat oracle settlement -> claim payout.
#
# This is the deterministic fallback harness: if the live demo flakes during
# judging, this single command re-proves the entire lifecycle against real
# devnet, start to finish, using fresh throwaway accounts every run (never
# touches the pre-existing proven L0/ER markets).
#
# Usage: cd onyx && bun run demo   (or: ./scripts/run-demo.sh)

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== ONYX demo runner ==="
echo "[1/3] Starting Next.js dev server (app/)..."
(cd app && bun run dev > /tmp/onyx-demo-dev.log 2>&1) &

cleanup() {
  echo ""
  echo "Stopping dev server..."
  pkill -f "next-server" >/dev/null 2>&1 || true
  pkill -f "next dev" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[2/3] Waiting for it to come up on http://localhost:3000 ..."
ready=0
for _ in $(seq 1 45); do
  if curl -sf http://localhost:3000/ >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Dev server did not come up in time -- see /tmp/onyx-demo-dev.log" >&2
  exit 1
fi
echo "Dev server ready."

echo "[3/3] Running the full lifecycle proof (app/scripts/verify-flow.ts)..."
echo ""
(cd app && bun run scripts/verify-flow.ts)
