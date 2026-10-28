#!/bin/sh
# Roda NO SERVIDOR, como root, depois de enviar /tmp/arena-app.tgz. Idempotente (pode rodar de novo a cada versão).
# Não mexe em nada dos outros sites: Node próprio em /opt/arena/node, usuário "arena", porta interna 3150.
set -e
NODE_VER=v24.11.1
mkdir -p /opt/arena/app /opt/arena/dados /opt/arena/acme
id arena >/dev/null 2>&1 || useradd --system --home /opt/arena --shell /usr/sbin/nologin arena
# Node próprio (o do sistema é usado pelos outros sites e é antigo demais: o SQLite embutido pede 22.5+)
if [ ! -x /opt/arena/node/bin/node ] || [ "$(/opt/arena/node/bin/node -v)" != "$NODE_VER" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o /tmp/node.tar.xz
  rm -rf /opt/arena/node && mkdir -p /opt/arena/node
  tar -xJf /tmp/node.tar.xz -C /opt/arena/node --strip-components=1 && rm /tmp/node.tar.xz
fi
# código novo (os dados ficam em /opt/arena/dados, fora da pasta do app)
rm -rf /opt/arena/app.novo && mkdir /opt/arena/app.novo
tar -xzf /tmp/arena-app.tgz -C /opt/arena/app.novo
(cd /opt/arena/app.novo && PATH=/opt/arena/node/bin:$PATH npm ci --omit=dev --no-audit --no-fund)
# fase comprimida uma vez (23 MB → ~5 MB): o servidor manda o .gz para quem aceita
gzip -9 -k -f /opt/arena/app.novo/site/data/level.bin
rm -rf /opt/arena/app.velho; [ -d /opt/arena/app ] && mv /opt/arena/app /opt/arena/app.velho; mv /opt/arena/app.novo /opt/arena/app
if [ ! -f /opt/arena/arena.env ]; then
  cat > /opt/arena/arena.env <<ENV
PORT=3150
ARENA_HOST=127.0.0.1
ARENA_PROXY=1
ARENA_DB=/opt/arena/dados/arena.db
ARENA_SITE_URL=https://arenacrash.com
ENV
fi
chmod 600 /opt/arena/arena.env
chown -R arena:arena /opt/arena/dados
cp /opt/arena/app/deploy/arena.service /etc/systemd/system/arena.service
systemctl daemon-reload
systemctl enable arena >/dev/null 2>&1
systemctl restart arena
# nginx: HTTPS se o certificado já existe, senão só HTTP
VHOST=/www/server/panel/vhost/nginx/arenacrash.com.conf
if [ -f /etc/letsencrypt/live/arenacrash.com/fullchain.pem ]; then cp /opt/arena/app/deploy/nginx-arenacrash-https.conf $VHOST
else cp /opt/arena/app/deploy/nginx-arenacrash.conf $VHOST; fi
NGINX=/www/server/nginx/sbin/nginx; [ -x $NGINX ] || NGINX=nginx
$NGINX -t && $NGINX -s reload
sleep 2
systemctl --no-pager --lines=5 status arena | tail -6
