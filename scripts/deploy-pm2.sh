#!/usr/bin/env bash
# Production deploy for madura-web-serv (run on the Ubuntu API server).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing dependencies (including TypeScript for build)..."
npm ci

echo "==> Building compiled JavaScript..."
npm run build

if [[ ! -f dist/server.js ]]; then
  echo "ERROR: dist/server.js was not created. Build failed." >&2
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
curl -sf "http://127.0.0.1:${PORT:-4000}/api/v1/health" | head -c 500 || true
echo ""
echo "Done. Verify: pm2 describe madura-web-serv  (script should be dist/server.js)"
