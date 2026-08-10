#!/usr/bin/env bash
# One-time provisioning for a new organisation. Run as root:
#   sudo bash setup-tenant.sh skntheory 3001 \
#        https://github.com/radproduction/skntheory-hrms-backend.git \
#        https://github.com/AsadKhan2951/skntheory-hrms-portal.git
#
# Creates the code directories, the uploads directory, the systemd unit and the
# nginx site, then stops and tells you what is left. It deliberately does NOT
# start anything: the .env has to be filled in first and the certificate has to
# be issued, both of which need you.
set -euo pipefail

TENANT="${1:-}"
PORT="${2:-}"
BACKEND_REPO="${3:-}"
FRONTEND_REPO="${4:-}"
DOMAIN="${DOMAIN:-nowhrms.com}"

if [[ -z "$TENANT" || -z "$PORT" || -z "$BACKEND_REPO" || -z "$FRONTEND_REPO" ]]; then
  cat >&2 <<'USAGE'
usage: setup-tenant.sh <tenant> <port> <backend-repo> <frontend-repo>

   eg: setup-tenant.sh skntheory 3001 \
         https://github.com/radproduction/skntheory-hrms-backend.git \
         https://github.com/AsadKhan2951/skntheory-hrms-portal.git

Backend and frontend live in separate repositories, under different GitHub
accounts, exactly like the original portal.
USAGE
  exit 2
fi

# The tenant name lands in a hostname, a path and an nginx upstream, so keep it
# to something that is safe in all three.
[[ "$TENANT" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || {
  echo "tenant must be lowercase letters, digits and hyphens: got '$TENANT'" >&2; exit 2; }

[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "port must be a number: got '$PORT'" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="/srv/tenants/$TENANT"
UPLOADS="/var/lib/hrms/$TENANT/uploads"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "port $PORT is already in use. Pick another." >&2
  exit 2
fi

log "clone into $ROOT"
mkdir -p "$ROOT"
# The two repositories sit under different GitHub accounts, so each clone may
# ask for its own credentials. Clone them by hand first if that is awkward.
for pair in "backend:$BACKEND_REPO" "frontend:$FRONTEND_REPO"; do
  sub="${pair%%:*}"
  url="${pair#*:}"
  if [[ -d "$ROOT/$sub/.git" ]]; then
    echo "  $sub already cloned, leaving it alone"
  else
    git clone --quiet "$url" "$ROOT/$sub"
    echo "  cloned $sub"
  fi
done
chown -R hrms:hrms "$ROOT"

log "uploads at $UPLOADS"
# Outside the code directory so a deploy can never wipe employee documents.
mkdir -p "$UPLOADS"
chown -R hrms:hrms "/var/lib/hrms/$TENANT"
chmod 750 "$UPLOADS"

log "environment file"
ENVFILE="$ROOT/backend/.env"
if [[ -f "$ENVFILE" ]]; then
  echo "$ENVFILE exists, leaving it alone"
else
  sed "s/__TENANT__/$TENANT/g; s/^PORT=.*/PORT=$PORT/" "$HERE/env.example" > "$ENVFILE"
  chown root:hrms "$ENVFILE"
  chmod 640 "$ENVFILE"
  echo "wrote $ENVFILE from the template"
fi

log "systemd unit"
cp "$HERE/hrms-tenant@.service" /etc/systemd/system/
systemctl daemon-reload
echo "installed hrms-tenant@.service"

log "nginx site (plain HTTP for now)"
# Deliberately the HTTP-only config. The HTTPS one names a certificate that
# does not exist yet, and nginx refuses to load a config with a missing
# certificate file — which would break `nginx -t` server-wide, block every
# reload, and stop nginx starting after a reboot, taking $DOMAIN down too.
# enable-ssl-tenant.sh swaps in the HTTPS config once certbot has the cert.
SITE="/etc/nginx/sites-available/hrms-$TENANT-http"
sed "s/__TENANT__/$TENANT/g; s/__DOMAIN__/$DOMAIN/g; s/__PORT__/$PORT/g" \
    "$HERE/nginx-tenant-http.conf" > "$SITE"
ln -sf "$SITE" "/etc/nginx/sites-enabled/hrms-$TENANT-http"
echo "wrote $SITE"

# Safe to reload: this config references no certificate.
if nginx -t; then
  systemctl reload nginx
  echo "nginx reloaded"
else
  echo "nginx config test failed — leaving nginx as it was" >&2
  rm -f "/etc/nginx/sites-enabled/hrms-$TENANT-http"
  exit 1
fi

cat <<EOF

$(printf '\033[1m==> next, by hand\033[0m')

1. Fill in $ENVFILE
     MONGODB_URI, JWT_SECRET, OFFICE_LAT, OFFICE_LNG, OFFICE_RADIUS_KM
   Take them from this project's Vercel environment variables, so the
   existing data and sessions carry over.

     sudo nano $ENVFILE

2. Point DNS at this droplet, and wait for it to resolve:
     A   $TENANT.$DOMAIN   ->   $(curl -s --max-time 5 ifconfig.me || echo '<this droplet IP>')

     dig +short $TENANT.$DOMAIN

3. Build and start it on plain HTTP:
     sudo systemctl enable hrms-tenant@$TENANT
     sudo bash $HERE/deploy-tenant.sh $TENANT

   Deploy one tenant at a time. The droplet has 2 GB of RAM and a vite build
   of this size will not survive two running at once.

4. Once http://$TENANT.$DOMAIN loads, switch it to HTTPS:
     sudo bash $HERE/enable-ssl-tenant.sh $TENANT

   Do this only after step 3. certbot proves the domain over the HTTP site,
   so there has to be something serving on it first.

5. Check it:
     curl -o /dev/null -w '%{http_code}\\n' https://$TENANT.$DOMAIN/api/trpc/auth.me

EOF
