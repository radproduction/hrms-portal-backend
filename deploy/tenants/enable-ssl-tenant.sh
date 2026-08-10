#!/usr/bin/env bash
# Phase 2: put one organisation's portal on HTTPS.
# Run once DNS for the subdomain points at this droplet.
#
#   sudo bash /srv/hrms/backend/deploy/tenants/enable-ssl-tenant.sh skntheory
set -euo pipefail

TENANT="${1:-}"
DOMAIN="${DOMAIN:-nowhrms.com}"

if [[ -z "$TENANT" ]]; then
  echo "usage: enable-ssl-tenant.sh <tenant>    e.g. enable-ssl-tenant.sh skntheory" >&2
  exit 2
fi

HOSTNAME_FQDN="$TENANT.$DOMAIN"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/srv/tenants/$TENANT/backend/.env"
PORT=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')
[[ -n "$PORT" ]] || { echo "PORT is not set in $ENV_FILE" >&2; exit 2; }

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

log "checking DNS"
resolved=$(getent hosts "$HOSTNAME_FQDN" | awk '{print $1}' | head -1 || true)
mine=$(curl -fsS --max-time 5 https://ifconfig.me || true)
echo "$HOSTNAME_FQDN resolves to: ${resolved:-<nothing>}"
echo "this droplet is:            ${mine:-<unknown>}"
if [[ -z "$resolved" ]]; then
  echo "DNS does not resolve yet. Add an A record for $HOSTNAME_FQDN and wait, then re-run." >&2
  exit 1
fi
if [[ -n "$mine" && "$resolved" != "$mine" ]]; then
  echo "$HOSTNAME_FQDN points somewhere else — certbot will fail. Fix DNS first." >&2
  exit 1
fi

log "obtaining certificate for $HOSTNAME_FQDN"
# Uses the plain-HTTP site that is already serving, so there is no downtime.
# --keep-until-expiring makes a re-run a no-op rather than an error, which
# matters because a dropped console session is a normal way to end up here.
certbot --nginx -d "$HOSTNAME_FQDN" --non-interactive --agree-tos \
        --register-unsafely-without-email --keep-until-expiring

log "installing the HTTPS site config"
SITE="/etc/nginx/sites-available/hrms-$TENANT"
sed "s/__TENANT__/$TENANT/g; s/__DOMAIN__/$DOMAIN/g; s/__PORT__/$PORT/g" \
    "$HERE/nginx-tenant.conf" > "$SITE"
ln -sf "$SITE" "/etc/nginx/sites-enabled/hrms-$TENANT"
# The HTTP-only site has done its job; its server block is now inside the
# HTTPS config as the redirect.
rm -f "/etc/nginx/sites-enabled/hrms-$TENANT-http"

log "reloading nginx"
nginx -t && systemctl reload nginx

log "verifying"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
       "https://$HOSTNAME_FQDN/api/trpc/auth.me" || true)
echo "https://$HOSTNAME_FQDN/api/trpc/auth.me -> HTTP ${code:-000}  (401 is the healthy answer)"
echo -n "http://$HOSTNAME_FQDN redirects to: "
curl -s -o /dev/null -w '%{redirect_url}\n' --max-time 10 "http://$HOSTNAME_FQDN/" || true

cat <<EOF

Done. https://$HOSTNAME_FQDN is live.

Renewal is automatic; confirm with: systemctl list-timers | grep certbot
EOF
