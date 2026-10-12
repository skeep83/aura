#!/usr/bin/env bash
# Автообновление Aura на VPS: забрать main из GitHub, пересобрать, проверить /healthz, при провале — откат.
#   bash deploy/vps/update.sh          — обновить, если в main есть новые коммиты (так зовёт таймер)
#   bash deploy/vps/update.sh --force  — пересобрать текущую версию
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 022 # статика должна читаться nginx (не root) — не наследовать строгий umask вызывающего
exec 9>/run/aura-update.lock
flock -n 9 || exit 0

COMPOSE=(docker compose -f docker-compose.vps.yml)
log() { echo "$(date '+%F %T') $*"; }

git fetch -q origin main
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)
if [[ "$OLD" == "$NEW" && "${1:-}" != "--force" ]]; then exit 0; fi

# Статика с версией ресурсов (?v=…), чтобы телефоны не смешивали новый index.html со старым app.js
# Контейнер web смонтирован на .build целиком, поэтому замена .build/html переименованием видна ему сразу.
build_web() {
  mkdir -p .build && rm -rf .build/html.new .build/html.old && cp -R public .build/html.new
  sed -i -E "s/\?v=[0-9a-f]+/?v=$(git rev-parse --short HEAD)/g" .build/html.new/index.html
  chmod -R a+rX .build/html.new
  [[ -d .build/html ]] && mv .build/html .build/html.old
  mv .build/html.new .build/html
  rm -rf .build/html.old .build/public
}

deploy() {
  build_web
  "${COMPOSE[@]}" build -q api moderation
  "${COMPOSE[@]}" up -d --remove-orphans
  docker exec "$("${COMPOSE[@]}" ps -q web)" nginx -s reload >/dev/null 2>&1 || true
}

healthy() {
  for _ in $(seq 1 30); do
    sleep 3
    docker exec "$("${COMPOSE[@]}" ps -q api)" wget -qO- http://127.0.0.1:8080/healthz 2>/dev/null | grep -q '"ok":true' \
      && docker exec "$("${COMPOSE[@]}" ps -q web)" wget -qO- http://127.0.0.1/ 2>/dev/null | grep -q 'app.js' && return 0
  done
  return 1
}

log "обновление ${OLD:0:7} → ${NEW:0:7}"
git -c advice.detachedHead=false checkout -q "$NEW"
deploy
if healthy; then
  log "ok ${NEW:0:7}: $(git log -1 --format=%s)"
else
  log "ПРОВАЛ ${NEW:0:7} — откат на ${OLD:0:7}"
  git -c advice.detachedHead=false checkout -q "$OLD"
  deploy
  healthy && log "откат выполнен" || log "откат тоже не поднялся — смотрите docker compose logs"
  exit 1
fi
