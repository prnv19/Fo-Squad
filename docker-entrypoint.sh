#!/bin/sh
# Fly volumes and Render disks mount owned by root, so when started as root this
# hands the data folder to the unprivileged "node" user, then drops root for
# good before starting the server. Started as non-root already, it just runs.
set -eu
if [ "$(id -u)" = "0" ]; then
  data="${DATA_DIR:-/data}"
  mkdir -p "$data"
  chown -R node:node "$data"
  chmod 700 "$data"
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs "$@"
fi
exec "$@"
