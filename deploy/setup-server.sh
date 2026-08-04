#!/usr/bin/env bash
# One-time provisioning for a fresh Ubuntu 24.04 DigitalOcean droplet.
# Run as root:  bash setup-server.sh your.domain.com
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: bash setup-server.sh your.domain.com" >&2
  exit 1
fi

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

echo "==> service user"
id -u hrms >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin hrms

echo "==> directories"
mkdir -p "$ROOT" "$UPLOADS"
chown -R hrms:hrms "$UPLOADS"

echo "==> clone"
[[ -d "$ROOT/backend/.git"  ]] || git clone "$BACKEND_REPO"  "$ROOT/backend"
[[ -d "$ROOT/frontend/.git" ]] || git clone "$FRONTEND_REPO" "$ROOT/frontend"
chown -R hrms:hrms "$ROOT"

echo "==> firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> nginx site"
install -m 644 "$ROOT/backend/deploy/nginx.conf" /etc/nginx/sites-available/hrms
sed -i "s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/hrms
ln -sf /etc/nginx/sites-available/hrms /etc/nginx/sites-enabled/hrms
rm -f /etc/nginx/sites-enabled/default

# certbot needs a working HTTP vhost before the certificate exists, so the TLS
# server block is commented out for the first run.
if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  echo "==> temporary HTTP-only site for the ACME challenge"
  cat > /etc/nginx/sites-available/hrms <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 200 'provisioning'; add_header Content-Type text/plain; }
}
EOF
  nginx -t && systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect

  echo "==> installing the real site config"
  install -m 644 "$ROOT/backend/deploy/nginx.conf" /etc/nginx/sites-available/hrms
  sed -i "s/__DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/hrms
fi

echo "==> systemd unit"
install -m 644 "$ROOT/backend/deploy/hrms-backend.service" /etc/systemd/system/
systemctl daemon-reload

cat <<EOF

Provisioning done.

Next, before the first deploy:

  1. Create the environment file (see env.example):
       sudo -u hrms cp $ROOT/backend/deploy/env.example $ROOT/backend/.env
       sudo nano $ROOT/backend/.env
       sudo chmod 600 $ROOT/backend/.env
       sudo chown hrms:hrms $ROOT/backend/.env

  2. Allow this droplet's IP in MongoDB Atlas (Network Access):
       $(curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo '<run: curl ifconfig.me>')

  3. Deploy:
       sudo bash $ROOT/backend/deploy/deploy.sh

EOF
