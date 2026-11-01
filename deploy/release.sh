#!/usr/bin/env bash
#
# Builds the current commit here and ships it to the server.
#
#   deploy/release.sh ubuntu@<server-ip>
#
# Only a committed tree goes out, so what is running is always a commit you can
# name - the hash is written to REVISION on the server. Nothing outside dist/,
# src/docs/ and the three top-level files is touched, so the server's .env and
# .storage/ are never overwritten or deleted.
#
# The server needs node, yarn and pm2 on the PATH of a login shell, and a .env
# in APP_DIR. See deploy/README.md for the one-time setup.

set -euo pipefail

HOST="${1:?usage: deploy/release.sh user@server}"
APP_DIR="${APP_DIR:-/srv/clinic-api}"

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain -- src package.json yarn.lock tsconfig.json tsconfig.build.json ecosystem.config.json)" ]; then
  echo "Uncommitted changes under src/ or in the build files. Commit them first, so the server runs a commit." >&2
  exit 1
fi

REVISION="$(git rev-parse --short HEAD)"
echo "Building ${REVISION}"

# A clean dist, so a deleted source file does not live on as compiled JS.
rm -rf dist
yarn build

echo "Shipping to ${HOST}:${APP_DIR}"
ssh "$HOST" "mkdir -p '$APP_DIR/dist' '$APP_DIR/src/docs'"
rsync -az --delete dist/ "$HOST:$APP_DIR/dist/"
rsync -az --delete src/docs/ "$HOST:$APP_DIR/src/docs/"
rsync -az package.json yarn.lock ecosystem.config.json "$HOST:$APP_DIR/"

# --ignore-scripts: the only lifecycle script is husky's `prepare`, and husky is
# a dev dependency that is not installed here. No production dependency builds
# anything native.
ssh "$HOST" bash -lc "'
  set -euo pipefail
  cd \"$APP_DIR\"
  echo \"$REVISION\" > REVISION
  yarn install --production --frozen-lockfile --ignore-scripts --non-interactive
  pm2 startOrReload ecosystem.config.json --update-env
  pm2 save
'"

echo "Released ${REVISION}. Logs: ssh ${HOST} pm2 logs clinic-api"
