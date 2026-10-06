#!/bin/sh
# Entrypoint for the API and worker containers.
#   api    → apply migrations, mirror profile/seed master resume, start HTTP API
#   worker → start BullMQ workers
set -e

# Zero-config local secrets: if SESSION_SECRET / ENCRYPTION_KEY are not provided,
# generate them once and persist them in the /data volume (never in Git).
SECRETS_FILE=/data/secrets.env
if [ -z "$SESSION_SECRET" ] || [ -z "$ENCRYPTION_KEY" ]; then
  if [ ! -f "$SECRETS_FILE" ]; then
    if [ "$1" = "api" ]; then
      umask 077
      node -e "const c=require('crypto');console.log('SESSION_SECRET='+c.randomBytes(32).toString('hex'));console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('hex'))" > "$SECRETS_FILE"
      echo "Generated local secrets in $SECRETS_FILE"
    else
      echo "Waiting for the API container to create $SECRETS_FILE ..."
      i=0; while [ ! -f "$SECRETS_FILE" ] && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done
    fi
  fi
  set -a; . "$SECRETS_FILE"; set +a
fi

case "$1" in
  api)
    npx prisma migrate deploy
    node dist/prisma/seed.js || echo "Seed step skipped"
    exec node dist/src/main.js
    ;;
  worker)
    exec node dist/src/worker.js
    ;;
  *)
    exec "$@"
    ;;
esac
