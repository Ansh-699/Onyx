#!/usr/bin/env bash
# Production deploy for onyx.ansht.tech — run on the droplet as root.
# Invoked by .github/workflows/deploy.yml after ci passes on master,
# or manually. Build-before-reload: a failed build leaves the running
# app untouched.
set -euo pipefail

REPO_DIR=/opt/onyx
export PATH="$HOME/.bun/bin:$PATH"

cd "$REPO_DIR"
echo "==> fetching origin/master"
git fetch origin master
git reset --hard origin/master

echo "==> installing deps (frozen lockfile)"
bun install --frozen-lockfile

echo "==> building app"
cd app
bun run build   # aborts the script on failure — pm2 keeps serving the old build

echo "==> reloading pm2 process"
pm2 reload onyx --update-env

echo "==> deployed $(git -C "$REPO_DIR" rev-parse --short HEAD)"
