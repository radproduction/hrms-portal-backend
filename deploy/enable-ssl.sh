#!/usr/bin/env bash
# Phase 2: attach the domain and switch the site to HTTPS.
# Run once DNS for the domain points at this droplet.
#
#   sudo bash /srv/hrms/backend/deploy/enable-ssl.sh nowhrms.com
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: bash enable-ssl.sh nowhrms.com" >&2
  exit 1
fi

ROOT=/srv/hrms
ENV_FILE="$ROOT/backend/.env"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

log "checking DNS"
resolved=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
mine=$(curl -fsS --max-time 5 https://ifconfig.me || true)
echo "$DOMAIN resolves to: ${resolved:-<nothing>}"
echo "this droplet is:     ${mine:-<unknown>}"
if [[ -z "$resolved" ]]; then
  echo "DNS does not resolve yet. Add an A record for $DOMAIN and wait, then re-run." >&2
  exit 1
fi
if [[ -n "$mine" && "$resolved" != "$mine" ]]; then
  echo "WARNING: $DOMAIN points somewhere else. certbot will fail unless this is a proxy." >&2
  read -r -p "continue anyway? [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || exit 1
fi

log "obtaining certificate"
# Uses the HTTP site that is already serving, so there is no downtime.
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
        --register-unsafely-without-email --redirect

log "installing the HTTPS site config"
install -m 644 "$ROOT/backend/deploy/nginx.conf" /etc/nginx/sites-available/hrms
sed -i "s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/hrms
ln -sf /etc/nginx/sites-available/hrms /etc/nginx/sites-enabled/hrms
rm -f /etc/nginx/sites-enabled/hrms-http

log "updating CORS_ORIGIN"
if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^CORS_ORIGIN=' "$ENV_FILE"; then
    sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://$DOMAIN|" "$ENV_FILE"
  else
    echo "CORS_ORIGIN=https://$DOMAIN" >> "$ENV_FILE"
  fi
  grep '^CORS_ORIGIN=' "$ENV_FILE"
else
  echo "no $ENV_FILE found — set CORS_ORIGIN=https://$DOMAIN yourself" >&2
fi

log "reloading"
nginx -t && systemctl reload nginx
systemctl restart hrms-backend
sleep 2
systemctl is-active --quiet hrms-backend && echo "hrms-backend: active" || {
  journalctl -u hrms-backend -n 30 --no-pager; exit 1; }

log "verifying"
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/trpc/auth.me" || true)
echo "https://$DOMAIN/api/trpc/auth.me -> HTTP $code  (401 is the healthy answer)"
certbot certificates 2>/dev/null | grep -A1 "$DOMAIN" || true

cat <<EOF

Done. https://$DOMAIN is live.

Remaining:
  - Repoint the Wingman agent at https://$DOMAIN/api/wingman/clock
  - Renewal is automatic; confirm with: systemctl list-timers | grep certbot
EOF
