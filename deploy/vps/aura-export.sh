#!/usr/bin/env bash
# Ежедневная выгрузка аналитики Aura (HOM-33): одноразовый контейнер aura-api,
# скрипт из /opt/aura/scripts, БД из /opt/aura/data (пишет /data/exports).
# Зона сети нет — выгрузка только читает локальный снапшот БД.
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
# --rm: контейнер не остаётся; /app/scripts монтируется из checkout (в образе его нет),
# src/db.js и analytics.js берутся из образа — та же версия, что работает в проде.
docker run --rm --name aura-export --network none \
  -v /opt/aura/scripts:/app/scripts:ro \
  -v /opt/aura/data:/data \
  -e DATA_DIR=/data -e APP_VERSION="$VERSION" \
  aura-api:latest node scripts/export-analytics.mjs
# Выгрузки старше 90 дней не копить (сверка OpenAI — 3 суток, недельные отчёты — с запасом).
find /opt/aura/data/exports -maxdepth 1 -name 'aura_analytics_*' -mtime +90 -exec rm -rf {} +
