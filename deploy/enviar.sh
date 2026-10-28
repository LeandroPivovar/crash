#!/bin/sh
# Roda NO SEU COMPUTADOR (Git Bash), na pasta crash/: empacota o site e instala no servidor.
#   sh deploy/enviar.sh gotrade-vps
set -e
DEST=${1:-gotrade-vps}
tar --exclude=node_modules --exclude=servidor/dados --exclude=_origem --exclude=.git --exclude='*.gz' -czf /tmp/arena-app.tgz .
scp /tmp/arena-app.tgz "$DEST":/tmp/arena-app.tgz
ssh "$DEST" 'tar -xzf /tmp/arena-app.tgz -O ./deploy/instalar.sh > /tmp/arena-instalar.sh && sh /tmp/arena-instalar.sh'
