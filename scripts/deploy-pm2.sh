#!/usr/bin/env bash
# Production deploy for madura-web-serv (run on the Ubuntu API server).
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-4000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
HEALTH_SECRET="${HEALTH_CHECK_SECRET:-}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-15}"
HEALTH_SLEEP_SECS="${HEALTH_SLEEP_SECS:-2}"

curl_health() {
  if [[ -n "$HEALTH_SECRET" ]]; then
    curl -sS -m 8 -H "x-health-secret: ${HEALTH_SECRET}" "$HEALTH_URL" || true
  else
    curl -sS -m 8 "$HEALTH_URL" || true
  fi
}

health_ok() {
  local body
  body="$(curl_health)"
  [[ -n "$body" ]] && echo "$body" | grep -q '"ok":true'
}

wait_for_health() {
  local attempt=1
  local body=""
  echo "==> Health check (up to ${HEALTH_ATTEMPTS} tries)..."
  while (( attempt <= HEALTH_ATTEMPTS )); do
    body="$(curl_health)"
    if [[ -n "$body" ]] && echo "$body" | grep -q '"ok":true'; then
      echo "$body" | head -c 400
      echo ""
      return 0
    fi
    echo "  attempt ${attempt}/${HEALTH_ATTEMPTS}: not healthy yet${body:+ — ${body}}"
    sleep "$HEALTH_SLEEP_SECS"
    attempt=$((attempt + 1))
  done
  echo "==> Last health response:"
  echo "${body:-"(empty — process may not be listening on :${PORT})"}"
  echo "==> PM2 status:"
  pm2 describe madura-web-serv || true
  echo "==> Recent PM2 logs:"
  pm2 logs madura-web-serv --lines 40 --nostream || true
  return 1
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

if wait_for_health; then
  rm -rf dist.prev
  echo "Deploy healthy."
  echo "Done. Verify: pm2 describe madura-web-serv  (script should be dist/server.js)"
else
  echo "ERROR: Health check failed after deploy." >&2
  rollback_dist
  exit 1
fi
