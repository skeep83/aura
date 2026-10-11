#!/usr/bin/env bash
# Установка на чистый Ubuntu 22.04/24.04 (VPS с публичным IP).
#   git clone … /opt/video-roulette && cd /opt/video-roulette && sudo bash deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $EUID -ne 0 ]]; then echo "Запустите через sudo"; exit 1; fi

if ! command -v docker >/dev/null; then
  echo "==> Ставлю Docker"
  curl -fsSL https://get.docker.com | sh
fi

if [[ ! -f .env ]]; then
  echo "==> Настройка"
  read -rp "Токен бота (@BotFather): " BOT_TOKEN
  read -rp "Домен приложения (A-запись уже на этот сервер): " APP_DOMAIN
  read -rp "Ваш Telegram ID для админ-команд (@userinfobot): " ADMIN_IDS
  read -rp "Контакт поддержки по оплате (например @my_support): " SUPPORT_CONTACT
  PUBLIC_IP=$(curl -fsS https://api.ipify.org)
  sed -e "s|^BOT_TOKEN=.*|BOT_TOKEN=${BOT_TOKEN}|" \
      -e "s|^APP_DOMAIN=.*|APP_DOMAIN=${APP_DOMAIN}|" \
      -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${APP_DOMAIN}|" \
      -e "s|^PUBLIC_IP=.*|PUBLIC_IP=${PUBLIC_IP}|" \
      -e "s|^TURN_HOST=.*|TURN_HOST=${APP_DOMAIN}|" \
      -e "s|^TURN_SECRET=.*|TURN_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^MODERATION_TOKEN=.*|MODERATION_TOKEN=$(openssl rand -hex 32)|" \
      -e "s|^ADMIN_IDS=.*|ADMIN_IDS=${ADMIN_IDS}|" \
      -e "s|^SUPPORT_CONTACT=.*|SUPPORT_CONTACT=${SUPPORT_CONTACT}|" \
      .env.example > .env
  chmod 600 .env
  echo "    .env создан (IP ${PUBLIC_IP})"
fi

if command -v ufw >/dev/null && ufw status | grep -q active; then
  echo "==> Открываю порты в ufw"
  ufw allow 80/tcp; ufw allow 443/tcp
  ufw allow 3478/tcp; ufw allow 3478/udp
  ufw allow 49160:49999/udp
fi

COMPOSE=(-f docker-compose.yml)
if command -v nvidia-smi >/dev/null; then
  echo "==> Найдена NVIDIA GPU — модерация пойдёт на видеокарте"
  COMPOSE+=(-f docker-compose.gpu.yml)
fi

echo "==> Сборка и запуск (первый раз 5–10 минут: скачивается модель модерации)"
docker compose "${COMPOSE[@]}" up -d --build

source .env
echo
echo "Готово. Проверка: curl https://${APP_DOMAIN}/healthz"
echo "Откройте бота в Telegram и отправьте /start."
echo "Логи: docker compose logs -f app"
