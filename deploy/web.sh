#!/usr/bin/env bash
# nginx + Let's Encrypt TLS.
#
#   bash deploy/web.sh grailmarket.duckdns.org you@example.com
#
# TLS is not optional here. The web client is served over HTTPS, and a browser
# refuses to call an http:// API from an https:// page — without a certificate
# the frontend silently cannot reach this box at all.
set -euo pipefail

DOMAIN="${1:?usage: web.sh <domain> <email>}"
EMAIL="${2:?usage: web.sh <domain> <email>}"

echo "==> checking $DOMAIN points here"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
PUBLIC="$(curl -fsS --max-time 10 https://checkip.amazonaws.com || true)"
PUBLIC="${PUBLIC//[$'\t\r\n ']}"
echo "    $DOMAIN -> ${RESOLVED:-unresolved}"
echo "    this box -> ${PUBLIC:-unknown}"
if [ -n "$RESOLVED" ] && [ -n "$PUBLIC" ] && [ "$RESOLVED" != "$PUBLIC" ]; then
  echo "    DNS does not point at this instance. Certbot will fail — fix DuckDNS first." >&2
  exit 1
fi

sudo tee /etc/nginx/sites-available/grail >/dev/null <<CONF
server {
    listen 80;
    server_name $DOMAIN;

    # Card photographs. The default of 1m rejects a phone photo outright.
    client_max_body_size 25m;

    # A scan reads the card, resolves it against several catalogues and prices
    # it. Eleven seconds is normal and thirty is not unheard of, so the default
    # 60s proxy timeout is cutting it fine rather than generous.
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;

    location / {
        proxy_pass http://127.0.0.1:8180;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
CONF

sudo ln -sf /etc/nginx/sites-available/grail /etc/nginx/sites-enabled/grail
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
echo "==> nginx serving $DOMAIN on :80"

echo "==> certbot"
sudo apt-get install -y -qq certbot python3-certbot-nginx
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo
echo "==> verifying over the public URL"
curl -fsS --max-time 30 "https://$DOMAIN/market/fx" >/dev/null \
  && echo "    https://$DOMAIN ok" \
  || { echo "    FAILED"; exit 1; }

cat <<NOTE

Two things still to do by hand, because they live outside this box:

  1. .env — point the eBay compliance endpoint at the new domain:
         EBAY_DELETION_ENDPOINT=https://$DOMAIN/ebay/deletion
     then:  sudo systemctl restart grail-api
     then re-verify that URL in the eBay developer portal, or the key set
     goes non-compliant.

  2. grail-market-web — set NEXT_PUBLIC_API_URL=https://$DOMAIN and REBUILD.
     It is baked in at build time; restarting is not enough.
NOTE
