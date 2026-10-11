#!/usr/bin/env bash
# Обновить Aura на TrueNAS: собрать архивы бэкенда и фронтенда, отправить на teslav100 и запустить deploy.py
# (загрузка в датасет Home_Storage/aura через API TrueNAS и перезапуск приложения).
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
# Бэкенд (Node.js) и фронтенд (статика для nginx) — отдельные архивы и контейнеры
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TMP/api.tgz" package.json package-lock.json src node_modules
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TMP/web.tgz" -C public .
scp -q "$TMP/api.tgz" "$TMP/web.tgz" deploy/nginx.conf deploy/truenas/deploy.py deploy/truenas/logs.py deploy/truenas/set_token.py deploy/truenas/set_turn.py deploy/truenas/aura_watchdog.py skeep@192.168.4.119:~/aura-deploy/
rm -rf "$TMP"
ssh skeep@192.168.4.119 'cd ~/aura-deploy && ~/.hermes/hermes-agent/venv/bin/python deploy.py && sleep 20 && ~/.hermes/hermes-agent/venv/bin/python logs.py 15'
