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

log "checking www"
WWW="www.$DOMAIN"
WWW_ARG=""
www_resolved=$(getent hosts "$WWW" | awk '{print $1}' | head -1 || true)
if [[ -n "$www_resolved" && ( -z "$mine" || "$www_resolved" == "$mine" ) ]]; then
  echo "$WWW also points here — including it in the certificate"
  WWW_ARG="-d $WWW"
else
  echo "$WWW does not point here — apex only"
fi

log "obtaining certificate"
# Uses the HTTP site that is already serving, so there is no downtime.
# shellcheck disable=SC2086
certbot --nginx -d "$DOMAIN" $WWW_ARG --non-interactive --agree-tos \
        --register-unsafely-without-email --redirect

log "installing the HTTPS site config"
install -m 644 "$ROOT/backend/deploy/nginx.conf" /etc/nginx/sites-available/hrms
sed -i "s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/hrms
ln -sf /etc/nginx/sites-available/hrms /etc/nginx/sites-enabled/hrms
rm -f /etc/nginx/sites-enabled/hrms-http

if [[ -n "$WWW_ARG" ]]; then
  echo "installing the www -> apex redirect"
  install -m 644 "$ROOT/backend/deploy/nginx-www-redirect.conf" /etc/nginx/sites-available/hrms-www
  sed -i "s/__WWW__/$WWW/g; s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/hrms-www
  ln -sf /etc/nginx/sites-available/hrms-www /etc/nginx/sites-enabled/hrms-www
else
  rm -f /etc/nginx/sites-enabled/hrms-www
fi

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

# This can run during first provisioning, before anything has been built or the
# environment file exists, so a not-yet-deployable backend is not an error here.
if [[ -f "$ROOT/backend/dist/index.js" && -f "$ENV_FILE" ]]; then
  systemctl restart hrms-backend
  sleep 2
  if systemctl is-active --quiet hrms-backend; then
    echo "hrms-backend: active"
  else
    journalctl -u hrms-backend -n 30 --no-pager
    exit 1
  fi
else
  echo "backend not deployed yet — skipping restart (run deploy.sh next)"
  DEPLOYED=no
fi

log "verifying"
if [[ "${DEPLOYED:-yes}" == "yes" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/trpc/auth.me" || true)
  echo "https://$DOMAIN/api/trpc/auth.me -> HTTP $code  (401 is the healthy answer)"
fi
echo -n "http://$DOMAIN redirects to: "
curl -s -o /dev/null -w '%{redirect_url}\n' "http://$DOMAIN/" || true
if [[ -n "$WWW_ARG" ]]; then
  echo -n "https://$WWW redirects to: "
  curl -s -o /dev/null -w '%{redirect_url}\n' "https://$WWW/" || true
fi
certbot certificates 2>/dev/null | grep -E "Certificate Name|Domains|Expiry" || true

cat <<EOF

Done. https://$DOMAIN is live.

Remaining:
  - Repoint the Wingman agent at https://$DOMAIN/api/wingman/clock
  - Renewal is automatic; confirm with: systemctl list-timers | grep certbot
EOF
