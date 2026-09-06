#!/bin/bash
set -e

PORT=5173
URL="http://localhost:$PORT"

if curl -s --max-time 1 "$URL" > /dev/null 2>&1; then
  PEAR_DEV_SERVER_URL="$URL" exec npx electron . "$@"
fi

exec npx concurrently -k \
  "npm:ui:dev" \
  "npx wait-on tcp:$PORT && PEAR_DEV_SERVER_URL=$URL npx electron . $*"
