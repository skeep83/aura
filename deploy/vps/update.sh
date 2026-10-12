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

if [[ "${1:-}" == "--continue" ]]; then
  # Второй проход: уже на новой версии, сам скрипт тоже новый
  OLD=$AURA_FROM; NEW=$(git rev-parse HEAD)
else
  git fetch -q origin main
  OLD=$(git rev-parse HEAD)
  NEW=$(git rev-parse origin/main)
  if [[ "$OLD" == "$NEW" && "${1:-}" != "--force" ]]; then exit 0; fi
  # Версия, которая уже провалила проверку и была откачена, повторно не ставится (ждём следующего коммита)
  if [[ "${1:-}" != "--force" && -f .failed-commit && "$(cat .failed-commit)" == "$NEW" ]]; then exit 0; fi
  git -c advice.detachedHead=false checkout -q "$NEW"
  # Перезапуск уже обновлённым update.sh — иначе изменения самого скрипта применились бы только в следующий раз
  exec 9>&-
  AURA_FROM=$OLD exec bash deploy/vps/update.sh --continue
fi

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
  # nginx.conf смонтирован файлом: после checkout у файла новый inode, контейнер его не видит — пересоздать web
  if [[ "$OLD" != "$NEW" ]] && ! git diff --quiet "$OLD" "$NEW" -- deploy/nginx.conf; then
    "${COMPOSE[@]}" up -d --force-recreate --no-deps web
  fi
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
deploy
if healthy; then
  rm -f .failed-commit
  log "ok ${NEW:0:7}: $(git log -1 --format=%s)"
else
  log "ПРОВАЛ ${NEW:0:7} — откат на ${OLD:0:7}"
  echo "$NEW" > .failed-commit
  git -c advice.detachedHead=false checkout -q "$OLD"
  deploy
  healthy && log "откат выполнен" || log "откат тоже не поднялся — смотрите docker compose logs"
  exit 1
fi
