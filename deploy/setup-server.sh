#!/usr/bin/env bash
# One-time provisioning for a fresh Ubuntu 24.04 DigitalOcean droplet.
#
# Run as root. The domain is optional:
#
#   bash setup-server.sh                 # HTTP on the droplet IP, no TLS yet
#   bash setup-server.sh nowhrms.com     # full HTTPS setup
#
# Starting without a domain is fine — run deploy/enable-ssl.sh later to attach
# one and switch to HTTPS without redoing anything.
set -euo pipefail

DOMAIN="${1:-}"

BACKEND_REPO="https://github.com/radproduction/hrms-portal-backend.git"
FRONTEND_REPO="https://github.com/AsadKhan2951/hrms-portal-frontend.git"
ROOT=/srv/hrms
UPLOADS=/var/lib/hrms/uploads

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx ufw certbot python3-certbot-nginx

echo "==> node 22 LTS"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "==> swap"
# The Vite build peaks well above what is comfortable on a 2 GB droplet while
# nginx and the API are also running. Without swap the build gets OOM-killed.
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10
  grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi
free -h | head -3

echo "==> service user"
id -u hrms >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin hrms

echo "==> directories"
mkdir -p "$ROOT" "$UPLOADS"
chown -R hrms:hrms "$UPLOADS"

echo "==> clone"
# Guarded so a re-run after a dropped console session picks up where it left off
# rather than failing on an existing directory.
[[ -d "$ROOT/backend/.git"  ]] || git clone "$BACKEND_REPO"  "$ROOT/backend"
[[ -d "$ROOT/frontend/.git" ]] || git clone "$FRONTEND_REPO" "$ROOT/frontend"
chown -R hrms:hrms "$ROOT"

echo "==> firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> nginx site"
rm -f /etc/nginx/sites-enabled/default

# Always start on the HTTP site. It serves the app on the droplet IP and also
# answers the ACME challenge, so enabling TLS later needs no downtime.
install -m 644 "$ROOT/backend/deploy/nginx-http.conf" /etc/nginx/sites-available/hrms-http
ln -sf /etc/nginx/sites-available/hrms-http /etc/nginx/sites-enabled/hrms-http
nginx -t && systemctl reload nginx

if [[ -n "$DOMAIN" ]]; then
  echo "==> enabling TLS for $DOMAIN"
  bash "$ROOT/backend/deploy/enable-ssl.sh" "$DOMAIN"
fi

echo "==> systemd unit"
install -m 644 "$ROOT/backend/deploy/hrms-backend.service" /etc/systemd/system/
systemctl daemon-reload

MYIP=$(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo '<run: curl ifconfig.me>')

cat <<EOF

Provisioning done.

Next, before the first deploy:

  1. Create the environment file (see env.example):
       sudo -u hrms cp $ROOT/backend/deploy/env.example $ROOT/backend/.env
       sudo nano $ROOT/backend/.env
       sudo chmod 600 $ROOT/backend/.env
       sudo chown hrms:hrms $ROOT/backend/.env

     Carry MONGODB_URI and JWT_SECRET across from Railway unchanged.
$(if [[ -z "$DOMAIN" ]]; then cat <<INNER
     No domain yet, so set:
       CORS_ORIGIN=http://$MYIP
       COOKIE_SAMESITE=lax
INNER
fi)

  2. Allow this droplet's IP in MongoDB Atlas (Network Access):
       $MYIP

     Skipping this makes every screen load empty instead of erroring.

  3. Deploy:
       sudo bash $ROOT/backend/deploy/deploy.sh

$(if [[ -z "$DOMAIN" ]]; then cat <<INNER
  4. Test at http://$MYIP

  Later, once DNS points here:
       sudo bash $ROOT/backend/deploy/enable-ssl.sh nowhrms.com
INNER
else
  echo "  4. Test at https://$DOMAIN"
fi)

EOF
