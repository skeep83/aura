# Настройки

Все параметры — переменные окружения (`.env`, см. `.env.example`). Секреты отмечены 🔒 — только в файлах с правами 600, не в репозитории.

## Основное

| Переменная | По умолчанию | Описание |
|---|---|---|
| `BOT_TOKEN` 🔒 | — | Токен бота. Без него сервер в режиме настройки (вход закрыт) |
| `BOT_USERNAME` | авто (getMe) | Для ссылок на комнаты и приглашения |
| `APP_NAME` | `Aura` | Название в интерфейсе, боте и карточках |
| `PUBLIC_URL` | — | `https://<домен>` — кнопка меню, ссылки, карточки Stories |
| `MINIAPP_SHORT_NAME` | — | Short name из `/newapp` → ссылки `t.me/<бот>/<short>?startapp=` |
| `ADMIN_IDS` | — | Telegram ID админов через запятую: `/stats /ban /unban /refund` |
| `SUPPORT_CONTACT` | `@support` | Контакт для `/paysupport` |
| `PORT` | `8080` | Порт api |
| `DATA_DIR` | `./data` | Где лежит `roulette.db` и карточки Stories |
| `SERVE_STATIC` | `1` | `0` — только API (статику раздаёт nginx) |

## Деньги

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PRICE_WEEK_STARS` | `75` | Premium на 7 дней, ⭐ |
| `PRICE_MONTH_STARS` | `199` | Premium на 30 дней, ⭐ |
| `PRICE_SALUTE5_STARS` | `25` | Пачка из 5 салютов 🎆, ⭐ |
| `PRICE_SALUTE20_STARS` | `79` | Пачка из 20 салютов 🎆, ⭐ |
| `FREE_FILTER_PER_DAY` | `10` | Бесплатных подборов по полу в день |

## Рост и удержание

| Переменная | По умолчанию | Описание |
|---|---|---|
| `TZ_OFFSET_HOURS` | `3` | Пояс по умолчанию — для тех, чей часовой пояс неизвестен (серии дней, итоги недели) |
| `EVENT_TIME` | `21:00` | Начало Aura Hour **по местному времени каждого человека** (пояс присылает устройство) |
| `EXCHANGE_HALF_SEC` | `300` | Языковой обмен: секунд на каждый язык |
| `CROWD_MIN` | `8` | «Позовите, когда соберутся»: сколько людей онлайн на языке подписчика, чтобы позвать (не чаще раза в 20 ч) |
| `THREAD_HOPS_STORY` / `THREAD_HOPS_QUESTION` / `THREAD_HOPS_WISH` | `12` / `20` / `10` | Нити: сколько ходов до финала у истории, вопроса миру и пожелания (минимум 3) |
| `THREAD_TTL_DAYS` | `7` | Нити: срок жизни; по истечении — финал, если ходов ≥ 5, иначе архив |
| `PAIR_RELAX_MS` | `25000` | «Вдвоём с одного телефона»: через сколько двоих можно свести с одиночкой (большое значение — только с такими же двоими) |
| `DUO_CONN_TIMEOUT_MS` | `20000` | Duo 2×2: сколько ждать, пока соединятся все четверо; иначе группа распадается и обе двойки ищут дальше |
| `THREAD_STUCK_HOURS` | `48` | Нити: через сколько часов без передачи нить уходит в пул и вручается другому в ожидании; три раза подряд — архив |
| `EVENT_MINUTES` | `60` | Длительность события |
| `ROUND_SECONDS` | `180` | Длина раунда во время события |
| `REFERRAL_PREMIUM_DAYS` | `1` | Premium обоим за приглашённого друга |
| `STREAK_REWARD_EVERY` | `7` | Сутки Premium за каждые N дней серии |
| `RATE_MIN_SECONDS` | `15` | Предлагать +aura/−aura после разговора не короче |
| `EMOJI_STATUS_ID` | — | `custom_emoji_id` статуса «в Aura» для Telegram Premium |

## Модерация

| Переменная | По умолчанию | Описание |
|---|---|---|
| `MODERATION_URL` | — | Адрес сервиса модерации; пусто — выключена |
| `MODERATION_TOKEN` 🔒 | — | Общий токен api ↔ moderation |
| `NSFW_THRESHOLD` | `0.85` | Порог NSFW |
| `MINOR_THRESHOLD` | `0.8` | Порог «младше 20» по лицу (2 из 3 кадров → блок) |
| `AGE_BLOCK_HOURS` | `24` | Блок при подозрении на несовершеннолетнего |
| `FRAME_INTERVAL_MS` | `4000` | Как часто клиент шлёт кадр |
| `STRIKES_TO_BAN` / `STRIKE_BAN_HOURS` | `3` / `24` | Страйки NSFW до бана и его длительность |
| `REPORTS_TO_BAN` | `3` | Уникальных жалоб за 7 дней до бана на 7 дней |

## Вход в браузере

| Переменная | По умолчанию | Описание |
|---|---|---|
| `WEB_ANON` | — | `1` — браузер без Telegram получает анонимный профиль `web-*` и сессию на 30 дней (HOM-31) |
| `AUTH_PROVIDERS` | — | Включённые способы входа через запятую, например `telegram,google`. **Пусто — вход на сайте выключен целиком: `/auth/*` отдаёт 404, cookie не выдаются, кнопок входа в интерфейсе нет.** Провайдер, у которого ещё нет ветки в коде, молча игнорируется |
| `GOOGLE_CLIENT_ID` | — | OAuth 2.0 Client ID (Web application) для входа через Google. Без него и секрета `google` в `AUTH_PROVIDERS` молча не включается |
| `GOOGLE_CLIENT_SECRET` 🔒 | — | Client secret того же Client ID. Уходит только в server-to-server запрос на `/token`, в редирект к Google не попадает |
| `AUTH_COOKIE_INSECURE` | — | `1` — не ставить флаг `Secure` на cookie (только локальный `http://`; в проде не включать) |
| `SESSION_SALT` 🔒 | — | Дополнительная соль подписи cookie `aura_oauth`; смена инвалидирует незавершённые входы |

Для Telegram Login Widget нужен `/setdomain` у @BotFather (домен сайта) и `BOT_USERNAME`.
Для Google — redirect URI `https://<домен>/auth/google/callback` и скоупы `openid email profile`
в Cloud Console; адреса эндпоинтов и JWKS зашиты в коде. Внутри Telegram Mini App кнопок соцсетей
нет вовсе: Google отвечает `disallowed_useragent` во встроенных WebView, а вход там есть через `initData`.
Порядок настройки — в [operations.md](operations.md#google-oidc).
Cookie `aura_session` — `HttpOnly; Secure; SameSite=Lax; Max-Age=30d` с тем же HMAC-токеном, что и прежние
сессии: при включении флага живые пользователи не разлогиниваются. На Cloudflare для `/auth/*` нужна
cache rule bypass, иначе `Set-Cookie` и редиректы могут закэшироваться.

## Сеть (TURN)

| Переменная | Описание |
|---|---|
| `TURN_HOST`, `TURN_SECRET` 🔒 | Свой coturn (`use-auth-secret`); URL собираются автоматически |
| `TURN_URLS` | Явный список URL вместо `TURN_HOST` |
| `CF_TURN_KEY_ID`, `CF_TURN_TOKEN` 🔒 | TURN Cloudflare Realtime (учётки на сутки, кэш на час) |
| `PUBLIC_URL_DISCOVER` | Узнавать адрес быстрого туннеля у cloudflared (`http://tunnel:2000/quicktunnel`) |

## Только для разработки

| Переменная | Описание |
|---|---|
| `DEV_ALLOW_ANON=1` | Вход без Telegram, покупки без оплаты, `?startapp=` и `?country=XX` из адресной строки. **Не включать в продакшене** |
| `BOT_POLLING=0` | Поднять api с токеном бота, но без long polling (используют тесты входа через Telegram) |
