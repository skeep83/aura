# Архитектура

## Компоненты

```mermaid
flowchart TB
  subgraph Client["Telegram Mini App (public/)"]
    APP[app.js<br/>WebRTC, UI, состояния]
    I18N[i18n.js<br/>8 языков]
    GAMES[games.js]
    MASK[mask.js + face.js<br/>MediaPipe на устройстве]
  end
  subgraph Server["Сервер"]
    WEB[web — nginx<br/>статика, gzip, кэш]
    API[api — Node.js 22<br/>server.js]
    DB[(SQLite<br/>roulette.db)]
    BOT[bot.js<br/>long polling]
  end
  MOD[moderation — FastAPI<br/>NSFW + возраст]
  TURN[TURN<br/>coturn или Cloudflare]
  TG[Telegram Bot API]

  APP -- HTTPS --> WEB
  APP -- WSS /ws --> WEB --> API
  API --- DB
  API --> MOD
  BOT <--> TG
  API --- BOT
  APP <-. WebRTC .-> TURN
```

- **web** — nginx: отдаёт `public/`, проксирует `/ws` (WebSocket), `/api/`, `/s/` (карточки Stories), `/healthz` в api. Наружу смотрит только он.
- **api** — один процесс Node.js без фреймворков: HTTP + WebSocket (`ws`), матчинг, сигналинг WebRTC, бот, SQLite (`node:sqlite`). При `SERVE_STATIC=0` статику не отдаёт.
- **moderation** — FastAPI: Falconsai NSFW по кадру + `nateraw/vit-age-classifier` по самому крупному лицу (OpenCV Haar). Кадры не сохраняются.
- **TURN** — ретранслятор для пар, у которых не получилось прямое P2P (мобильные сети, CGNAT): свой coturn на VPS или Cloudflare Realtime TURN.

## Жизненный цикл разговора

```mermaid
sequenceDiagram
  participant A as Клиент A
  participant S as api
  participant B as Клиент B
  A->>S: auth {initData}
  S-->>A: ready {ice, me, plans, event, room}
  A->>S: find
  S-->>A: waiting
  B->>S: auth + find
  S-->>A: matched {initiator: true, peer, reveal}
  S-->>B: matched {initiator: false, peer, reveal}
  A->>S: signal {sdp offer}
  S->>B: signal
  B->>S: signal {sdp answer, candidates}
  S->>A: signal
  Note over A,B: WebRTC: P2P или через TURN
  A->>S: conn {ok, chosen: "srflx>srflx"}
  loop каждые 4 с
    A->>S: frame {jpg} → moderation
  end
  A->>S: next
  S-->>B: peer_left
  S-->>A: rate_prompt
  S-->>B: rate_prompt
```

## Протокол WebSocket

Все сообщения — JSON `{ t: '<тип>', ... }`.

**Клиент → сервер:** `auth`, `profile` (пол, фильтр, языки, режим «Сначала голос», напоминания), `find`, `next`, `stop`, `signal`, `chat`, `game` (игры, маска, раскрытие — пересылается собеседнику), `vibe`, `rate`, `report`, `frame` (кадр для модерации), `conn` (итог WebRTC без IP), `room` (выйти в общую), `invoice`, `allow_pm`.

**Сервер → клиент:** `ready`, `me`, `online`, `waiting`, `matched`, `signal`, `chat`, `game`, `peer_left`, `stopped`, `round_end`, `rate_prompt`, `rated`, `vibe_sent`, `vibe_match`, `streak`, `referral`, `stamp`, `event`, `room`, `reported`, `warning`, `banned`, `invoice`, `error`.

Коды закрытия: `4001` нет auth, `4003` неверная подпись, `4004` бан, `4005` вход с другого окна.

## Матчинг

`src/matchmaker.js` — очередь FIFO с приоритетом Premium.

| Ограничение | Тип |
|---|---|
| Та же комната канала | жёсткое |
| Общий язык | жёсткое |
| Фильтр пола (в обе стороны) | жёсткое |
| Уровень ауры (low/ok) | мягкое: снимается, если оба ждут > 15 с |
| Режим «Сначала голос» | мягкое: снимается, если оба ждут > 15 с |
| Не тот же собеседник подряд | мягкое: снимается, если оба ждут > 10 с |

Раз в 3 с `tick()` перепроверяет очередь. Во время Aura Hour пары разводятся по истечении раунда.

## Данные (SQLite)

| Таблица | Что хранит |
|---|---|
| `users` | пол, фильтр, языки, Premium, аура (karma_up/down), серия дней, страна, режим, бан, рефералы |
| `reports` | жалобы (уникальны по паре) |
| `payments` | платежи Stars (идемпотентны по charge_id) |
| `rooms` | комнаты каналов, заходы и разговоры |
| `ratings` | оценки +aura/−aura (одна в сутки на пару) |
| `passport` | страны, с которыми поговорил пользователь |
| `events` | события для метрик: session, match, call_end, vibe, report, conn_ok/fail, nsfw, age_block, premium |

Миграции — добавлением колонок при старте (`Db` → `USER_COLUMNS`), данные существующих установок не теряются.

## Модерация и безопасность

- Клиент раз в `FRAME_INTERVAL_MS` шлёт уменьшенный кадр **настоящей** камеры (даже в режиме маски).
- NSFW ≥ `NSFW_THRESHOLD` → собеседник отключается, нарушителю страйк; `STRIKES_TO_BAN` страйков → бан на `STRIKE_BAN_HOURS`.
- Возраст: 2 из 3 последних кадров с лицом «младше 20» ≥ `MINOR_THRESHOLD` → бан на `AGE_BLOCK_HOURS` с объяснением.
- Жалобы: `REPORTS_TO_BAN` уникальных за 7 дней → бан на 7 дней.
- Сервис модерации недоступен → кадр пропускается (fail-open) с записью в лог; сторож присылает алерт.
