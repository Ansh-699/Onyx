#!/usr/bin/env bash
# Production deploy for onyx.ansht.tech. Runs on the prod box as azureuser, via
# the forced-command wrapper ~/onyx-deploy-entry.sh (see the header of
# .github/workflows/deploy.yml) or by hand. Build-before-reload: a failed build
# leaves the running app untouched, and the script only reports success once the
# reloaded app answers.
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/onyx}"
APP=onyx-web
PORT=3001
export PATH="$HOME/.bun/bin:$PATH"

# All work lives in a function and the script exits right after calling it, so
# bash never reads past this point of a file that `git reset --hard` rewrites.
main() {
  cd "$REPO_DIR"
  echo "==> fetching origin/master"
  git fetch origin master
  git reset --hard origin/master

  echo "==> installing deps (frozen lockfile)"
  bun install --frozen-lockfile

  echo "==> building app"
  (cd app && bun run build)   # aborts the script on failure; pm2 keeps serving the old build

  echo "==> reloading pm2 process $APP"
  # reload if it exists, create if not (first deploy, or after pm2 lost it).
  # `pm2 save` only on create: the pm2 list is shared with other services on
  # this box, so don't rewrite it on every deploy.
  if pm2 describe "$APP" >/dev/null 2>&1; then
    pm2 reload "$APP" --update-env
  else
    pm2 start bun --name "$APP" --cwd "$REPO_DIR/app" -- run start -- -p "$PORT"
    pm2 save >/dev/null
  fi

  echo "==> waiting for http://localhost:$PORT"
  code=000
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$PORT/" || true)
    [ "$code" = 200 ] && break
    sleep 2
  done
  if [ "$code" != 200 ]; then
    echo "!! $APP did not answer 200 after reload (last status $code)" >&2
    exit 1
  fi

  echo "==> deployed $(git rev-parse --short HEAD)"
}

main "$@"
exit
