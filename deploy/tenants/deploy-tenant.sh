#!/usr/bin/env bash
# Pull, build and restart one organisation's portal. Run as root:
#   sudo bash /srv/hrms/backend/deploy/tenants/deploy-tenant.sh skntheory
#
# Every tenant uses the same split layout as the original portal — backend and
# frontend are separate repositories side by side — so this mirrors deploy.sh,
# parameterised by tenant.
set -euo pipefail

TENANT="${1:-}"
BRANCH="${BRANCH:-main}"

if [[ -z "$TENANT" ]]; then
  echo "usage: deploy-tenant.sh <tenant>    e.g. deploy-tenant.sh skntheory" >&2
  exit 2
fi

ROOT="/srv/tenants/$TENANT"
[[ -d "$ROOT/backend"  ]] || { echo "no such tenant backend: $ROOT/backend" >&2; exit 2; }
[[ -d "$ROOT/frontend" ]] || { echo "no such tenant frontend: $ROOT/frontend" >&2; exit 2; }
[[ -f "$ROOT/backend/.env" ]] || { echo "missing $ROOT/backend/.env" >&2; exit 2; }

# The health check needs to know where this tenant listens.
# Quotes are stripped: systemd accepts PORT="3001" in an EnvironmentFile, so
# writing it that way is reasonable, but the quotes would end up inside the
# health-check URL and every deploy would report a failure it did not have.
PORT=$(grep -E '^PORT=' "$ROOT/backend/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]"'"'")
[[ -n "$PORT" ]] || { echo "PORT is not set in $ROOT/backend/.env" >&2; exit 2; }

log() { printf '\n\033[1m==> [%s] %s\033[0m\n' "$TENANT" "$1"; }

log "backend: pull $BRANCH"
sudo -u hrms git -C "$ROOT/backend" fetch --quiet origin
sudo -u hrms git -C "$ROOT/backend" checkout --quiet "$BRANCH"
sudo -u hrms git -C "$ROOT/backend" reset --hard --quiet "origin/$BRANCH"
sudo -u hrms git -C "$ROOT/backend" --no-pager log --oneline -1

log "backend: install + build"
cd "$ROOT/backend"
sudo -u hrms npm ci --omit=dev --silent
# esbuild is a devDependency but the build needs it.
sudo -u hrms npm install --no-save --silent esbuild
sudo -u hrms npm run build --silent

log "frontend: pull $BRANCH"
sudo -u hrms git -C "$ROOT/frontend" fetch --quiet origin
sudo -u hrms git -C "$ROOT/frontend" checkout --quiet "$BRANCH"
sudo -u hrms git -C "$ROOT/frontend" reset --hard --quiet "origin/$BRANCH"
sudo -u hrms git -C "$ROOT/frontend" --no-pager log --oneline -1

log "frontend: install + build"
cd "$ROOT/frontend"
sudo -u hrms npm ci --silent
# VITE_API_URL is deliberately unset: the SPA and the API share one origin on
# this tenant's subdomain, so relative paths (/api/trpc, /uploads, same-origin
# websocket) are correct and no base URL is needed.
#
# 2 GB of RAM plus swap is enough for one build at a time, but not for a
# default heap on a bundle this size. Deploy tenants one after another.
sudo -u hrms env NODE_OPTIONS=--max-old-space-size=1536 npm run build --silent

log "restart"
systemctl restart "hrms-tenant@$TENANT"
sleep 2
systemctl is-active --quiet "hrms-tenant@$TENANT" || {
  echo "hrms-tenant@$TENANT FAILED to start:"
  journalctl -u "hrms-tenant@$TENANT" -n 40 --no-pager
  exit 1
}
echo "hrms-tenant@$TENANT: active"

log "health check"
# Connecting to Atlas takes a moment, so poll rather than assuming it is ready.
#
# `|| true` is not optional: under `set -e` an assignment whose command
# substitution fails takes the shell down with it, and curl exits non-zero
# while nothing is listening yet — which is the normal state on the first
# poll. Without it the script dies here and the run looks like a clean finish.
#
# No `|| echo 000` either: curl already prints 000 on a failed connect, so a
# fallback would concatenate a second one and "000000" != "000" would report
# every failed deploy as a success.
code=000
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
         "http://127.0.0.1:$PORT/api/trpc/auth.me") || true
  code=${code:-000}
  [[ "$code" != "000" ]] && break
  sleep 2
done

if [[ "$code" == "000" ]]; then
  echo "backend did not respond on port $PORT after 30s. Recent log:"
  journalctl -u "hrms-tenant@$TENANT" -n 60 --no-pager
  exit 1
fi
echo "backend responded with HTTP $code"

log "reload nginx"
# Last, so a broken site config cannot mask a healthy backend.
nginx -t && systemctl reload nginx

log "done"
