#!/usr/bin/env bash
# Обновить Aura Admin на TrueNAS: собрать admin.tgz, отправить на teslav100 и перезапустить приложение aura-admin
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TMP/admin.tgz" -C admin .
scp -q "$TMP/admin.tgz" deploy/truenas/admin_deploy.py deploy/truenas/set_admin_password.py skeep@192.168.4.119:~/aura-deploy/
rm -rf "$TMP"
ssh skeep@192.168.4.119 'cd ~/aura-deploy && ~/.hermes/hermes-agent/venv/bin/python admin_deploy.py'
