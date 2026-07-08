#!/usr/bin/env bash
# Production deploy for madura-web-serv (run on the Ubuntu API server).
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-4000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
HEALTH_SECRET="${HEALTH_CHECK_SECRET:-}"

health_ok() {
  local body
  if [[ -n "$HEALTH_SECRET" ]]; then
    body="$(curl -sf -H "x-health-secret: ${HEALTH_SECRET}" "$HEALTH_URL" || true)"
  else
    body="$(curl -sf "$HEALTH_URL" || true)"
  fi
  [[ -n "$body" ]] && echo "$body" | grep -q '"ok":true'
}

rollback_dist() {
  if [[ -d dist.prev ]]; then
    echo "==> Rolling back to previous dist/..."
    rm -rf dist
    mv dist.prev dist
    if pm2 describe madura-web-serv >/dev/null 2>&1; then
      pm2 reload ecosystem.config.cjs --update-env
    fi
  fi
}

if [[ -d dist ]]; then
  echo "==> Backing up current dist/ to dist.prev..."
  rm -rf dist.prev
  cp -a dist dist.prev
fi

echo "==> Installing dependencies (including TypeScript for build)..."
npm ci

echo "==> Building compiled JavaScript..."
npm run build

if [[ ! -f dist/server.js ]]; then
  echo "ERROR: dist/server.js was not created. Build failed." >&2
  rollback_dist
  exit 1
fi

echo "==> Pruning devDependencies (runtime uses dist/, not ts-node)..."
npm prune --omit=dev

mkdir -p logs

if pm2 describe madura-web-serv >/dev/null 2>&1; then
  echo "==> Reloading PM2 process..."
  pm2 reload ecosystem.config.cjs --update-env
else
  echo "==> Starting PM2 process..."
  pm2 start ecosystem.config.cjs
fi

pm2 save

echo "==> Health check..."
sleep 2
if health_ok; then
  rm -rf dist.prev
  echo "Deploy healthy."
  curl -sf "${HEALTH_URL}" | head -c 200 || true
  echo ""
  echo "Done. Verify: pm2 describe madura-web-serv  (script should be dist/server.js)"
else
  echo "ERROR: Health check failed after deploy." >&2
  rollback_dist
  exit 1
fi
