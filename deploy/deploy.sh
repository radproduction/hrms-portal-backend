#!/usr/bin/env bash
# Pull, build and restart both halves of the app. Run as root:
#   sudo bash /srv/hrms/backend/deploy/deploy.sh
set -euo pipefail

ROOT=/srv/hrms
BRANCH="${BRANCH:-main}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

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
# VITE_API_URL is deliberately unset: on one domain the client uses relative
# paths (/api/trpc, /uploads, same-origin websocket) and needs no base URL.
sudo -u hrms npm run build --silent

log "restart backend"
systemctl restart hrms-backend
sleep 2
systemctl is-active --quiet hrms-backend || {
  echo "hrms-backend FAILED to start:"; journalctl -u hrms-backend -n 40 --no-pager; exit 1;
}
echo "hrms-backend: active"

log "health check"
# Connecting to Atlas takes a moment, so poll rather than assuming it is ready.
#
# No `|| echo 000` here: curl already prints 000 when it cannot connect *and*
# exits non-zero, so the fallback concatenated a second 000. The result was
# "000000", which is not equal to "000", so the loop broke on the first attempt
# and every failed deploy reported success.
code=000
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
         http://127.0.0.1:3000/api/trpc/auth.me)
  code=${code:-000}
  [[ "$code" != "000" ]] && break
  sleep 2
done

# 401 is the healthy unauthenticated answer; 000 means it never listened.
if [[ "$code" == "000" ]]; then
  echo "backend did not respond after 30s. Recent log:"
  journalctl -u hrms-backend -n 60 --no-pager
  exit 1
fi
echo "backend responded with HTTP $code"
journalctl -u hrms-backend -n 30 --no-pager | grep -Ei 'uploads|mongodb|server running' || true

log "reload nginx"
# Last, so a broken site config cannot mask a healthy backend.
nginx -t && systemctl reload nginx

log "done"
