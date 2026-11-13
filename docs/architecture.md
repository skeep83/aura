# Архитектура

## Компоненты

```mermaid
flowchart TB
  subgraph Client["Telegram Mini App (public/)"]
    APP[app.js<br/>WebRTC, UI, состояния]
    I18N[i18n.js<br/>8 языков]
    GAMES[games.js]
    MASK[mask.js + face.js<br/>MediaPipe на устройстве]
    DUO[duo.js<br/>mesh 2×2]
    THR[threads.js + worldmap.js<br/>нити, карта]
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

**Клиент → сервер:** `auth`, `profile` (пол, фильтр, языки, режим «Сначала голос», «вдвоём с одного телефона», напоминания), `find`, `next`, `stop`, `signal`, `chat`, `game` (игры, маска, раскрытие, Aura Moment — пересылается собеседнику), `vibe`, `rate`, `compliment`, `react`, `guess`, `wrapped`, `report`, `frame` (кадр для модерации), `conn` (итог WebRTC без IP), `room` (выйти в общую), `invoice`, `allow_pm`, `duo_create`, `duo_join`, `duo_search`, `duo_next`, `duo_stop`, `duo_leave`, `duo_signal`, `duo_conn` (итог соединения со слотом), `invite_open`, `invite_close`, `thread_start` (kind, text), `thread_show` (показать нить из кармана собеседнику), `thread_take` (text — ход и передача), `thread_skip`, `thread_accept` (code — взять из пула), `thread_drop`, `thread_page` (code), `thread_seen`.

**Сервер → клиент:** `ready`, `me`, `online`, `waiting`, `matched`, `signal`, `chat`, `game`, `peer_left`, `stopped`, `round_end`, `rate_prompt`, `rated`, `vibe_sent`, `vibe_match`, `streak`, `referral`, `stamp`, `guess_result`, `react`, `need_salutes`, `compliment`, `complimented`, `wrapped`, `event`, `room`, `reported`, `warning`, `banned`, `invoice`, `error`, `duo`, `duo_waiting`, `duo_matched`, `duo_signal`, `duo_ended`, `duo_error`, `invite` (open, until, link), `thread_pocket`, `thread_card` (role holder/peer, canTake), `thread_received`, `thread_passed`, `thread_declined`, `thread_final` (closer), `thread_offer`, `thread_page`, `thread_news`, `thread_error`.

`ready` несёт блок `account` (способ входа, привязанные входы, имя и аватар из соцсети, список включённых провайдеров) — из него собирается экран аккаунта; при пустом `AUTH_PROVIDERS` список провайдеров пуст и кнопок входа в интерфейсе нет.

## Вирусные механики

| Фича | Как устроено |
|---|---|
| «Угадай, откуда он» | Если страны собеседников известны и различаются, `matched.peer.country = null`, вместо неё `guess.options` (4 флага). Ответ `guess` → `guess_result` (+10 aura за верный). Через 20 с — ответ с `ok: null`. Штамп паспорта приходит вместе с ответом, чтобы не раскрыть страну |
| Комплименты | 3 минуты после разговора ≥ `RATE_MIN_SECONDS`: `compliment {kind}` (smile, funny, smart, kind, voice, world). Анонимно, одна на пару в сутки, засчитывается как +aura. Офлайн-получателю — сообщение бота |
| Реакции | `react {kind}`: ❤️ 😂 🔥 👏 бесплатно, 🎆 салют — из купленных пачек (Stars). Получатель салюта: +5 aura, каждые 10 — сутки Premium. Звёзды получателю не передаются |
| Aura Moment | Согласие обоих через `game {g:'moment'}` → отсчёт 3-2-1 → карточка 1080×1920 собирается на устройстве из двух кадров → Stories / сохранить |
| Aura Wrapped | `wrapped` → итоги 7 дней из `events`/`passport`/`compliments` и «тип ауры». В воскресенье 19:00 (часовой пояс аудитории) бот присылает итог с кнопкой `startapp=wrapped` |
| Друзья | взаимный вайб → таблица `friends`; список с «онлайн / в разговоре», звонок `call` → `call_incoming` (онлайн) или сообщение бота со ссылкой `startapp=call_<код>` (2 минуты); принятый звонок — прямая пара (`forcePair`), после неё человек не уходит в общую рулетку (`call_ended`) |
| Комната стримера | `src/live.js`: стример `live_start`, зрители по ссылке `startapp=live_<код>` встают в очередь и по одному (1–5 мин) говорят со стримером; «Далее» у стримера — следующий; имя зрителя стримеру не передаётся; подписка «сообщить, когда начнёт» (`live_subs`) |
| Языковой обмен | профиль `exchange: {native, learn}`; сначала только «зеркальная» пара (мой язык ↔ его изучаемый), через 25 с — любой носитель изучаемого языка; пара получает одинаковый план `{first, second, halfSec}` — таймер на экране, смена языка, 💡 тема от ИИ на текущем языке |
| Первые разговоры | новичок (< 3 разговоров) сводится с «хорошими» (аура ≥ 110), с людьми с плохой репутацией — только после 40 с ожидания |
| Позвать друга | `invite_open` → ссылка `startapp=inv_<код>` на 10 минут (`invite {open, until, link}`), уходит другу через выбор чата в Telegram (`t.me/share/url`), на Android — и через контакты телефона (Contact Picker → `t.me/+номер`, ссылка в буфере). Друг открыл ссылку, пока она открыта — обоих делаем друзьями и соединяем как звонок другу (`calling` / `call_incoming` → `call_accept` → `forcePair`); пригласивший не онлайн — `ready.inviteMissed`, человек в общей рулетке; новичку по `inv_` засчитывается реферал. «Вместе в Duo» — обычная ссылка `duo_<код>` |
| Нити | `src/threads.js`: история, вопрос миру или пожелание, которые идут от разговора к разговору. В кармане одна нить; держатель показывает её собеседнику (`thread_show` → `thread_card` обоим), тот делает ход и забирает (`thread_take` → `thread_received`/`thread_passed`). Один человек в нити один раз. На `max_hops` — финал вживую у пары (`thread_final`), остальным участникам — бот (`thread_done`) с кнопкой `startapp=thread_<код>`; автору +1 aura за ход, закрывшему +5, вехи на 5/10/20 ходах. Без передачи 48 ч — в пул, вручается в ожидании тому, у кого пустой карман (`thread_offer` → `thread_accept`); три раза подряд — архив; старше 7 дней — финал при ≥ 5 ходах. Ходы в оригинале, перевод на язык читателя пакетом (`ai.translateBatch`, история — целиком для согласования) с кэшем `thread_tr`; без ИИ — оригинал с флагом. Текст хода — через `chatfilter` и второй слой (Jev/ИИ): скрытый ход не рвёт цепочку. Клиент `public/threads.js`: карта мира точками (`worldmap.js`, битовая карта 180×72 + центры стран), прилёт нити в ожидании, карточка поверх видео, финал с маршрутом и карточка 1080×1920 для Stories |
| Duo 2×2 | `src/duo.js`: Duo по коду или ссылке `startapp=duo_<код>`, поиск другой полной Duo с общим языком, группа из 4 слотов. Клиент — mesh из трёх `RTCPeerConnection`, offer делает меньший слот, видео ограничено 350 кбит/с. Чат и реакции рассылаются всем; игры, вайб и Moment — только 1 на 1. Группа живёт, только пока соединены все: клиент сообщает итог каждого соединения (`duo_conn {to, ok, why}`, таймаут 15 с на клиенте), сервер ждёт 12 отчётов не дольше `DUO_CONN_TIMEOUT_MS` (20 с); отвал или молчание — `duo_ended {reason: 'conn'}`, обе Duo снова ищут и 15 с не сводятся друг с другом. Тот же человек с нового соединения занимает своё место в Duo |

Коды закрытия: `4001` нет auth, `4003` неверная подпись, `4004` бан, `4005` вход с другого окна.

## Матчинг

`src/matchmaker.js` — очередь FIFO с приоритетом Premium.

| Ограничение | Тип |
|---|---|
| Та же комната канала | жёсткое |

Язык общения новичка: сохранённые языки → язык устройства (Telegram `language_code`) → основной язык страны по `cf-ipcountry` (`COUNTRY_LANG` в `src/langs.js`) → английский. Русский по умолчанию больше не выдаётся. Интерфейс: Telegram → все языки устройства → английский; если ни один не из восьми, после входа сервер подсказывает язык страны (`ready.langHint`), и интерфейс переключается.

| Ограничение | Тип |
|---|---|
| Общий язык | жёсткое |
| Фильтр пола (в обе стороны) | жёсткое |
| Уровень ауры (low/ok) | мягкое: снимается, если оба ждут > 15 с |
| Режим «Сначала голос» | мягкое: снимается, если оба ждут > 15 с |
| «Вдвоём с одного телефона» (`pair`) | мягкое: двое сводятся только с такими же двоими, с одиночкой — если оба ждут > `PAIR_RELAX_MS` (25 с); собеседник получает `peer.pair = true` и видит «👫 Двое» |
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
| `compliments` | анонимные комплименты (кому, от кого, вид, время) |
| `threads`, `thread_moves`, `thread_tr` | нити (код, тип, автор, ходы, держатель, статус live/pool/done/archived), ходы (кто, страна, язык, текст в оригинале, скрыт модерацией), переводы ходов по языкам (n = 0 — заголовок истории) |
| `identities` | внешние входы: `(provider, provider_uid)` → `users.id`, e-mail, имя, аватар, время привязки и последнего входа |
| `events` | события для метрик: session, match, call_end, talk, vibe, vibe_match, guess_ok, compliment, salute, salute_buy, duo_create/join/call, report, conn_ok/fail, nsfw, age_block, premium, thread_start/show/move/done/accept/drop/hide, web_login_start/ok/fail, account_link, account_merge, account_delete |

Миграции — добавлением колонок при старте (`Db` → `USER_COLUMNS`), данные существующих установок не теряются.

## Вход (Telegram и сайт)

`users.id` — Telegram ID у телеграмных, `web-*` у браузерных; префиксы не меняются, на них опираются аналитика и `is_test`.

- **Mini App** — подпись `initData` (`src/auth.js`), на сервере ничего не хранится.
- **Браузер** — анонимный профиль `web-*` при `WEB_ANON=1` и вход через провайдера при непустом `AUTH_PROVIDERS` (`src/webauth.js`). Вход необязателен, анонимный профиль остаётся входом по умолчанию.
- Порядок в `auth()`: `initData` → одноразовый `login`-код из Mini App → cookie `aura_session` → токен в сообщении `auth` → анонимный вход.
- Сессия — тот же stateless HMAC-токен `id.ts.sig`; cookie `aura_session` (HttpOnly, Secure, SameSite=Lax, 30 дней) добавилась к старому пути, а не заменила его.
- Маршруты: `GET /auth/providers`, `GET /auth/:provider/start|callback`, `POST /auth/telegram/callback`, `POST /auth/link/:provider`, `POST /auth/logout`, `POST /auth/delete`. State+PKCE — в подписанной одноразовой cookie `aura_oauth` (TTL 10 минут), возврат только на свои адреса, rate limit по IP.
- Привязка и слияние: известная привязка ведёт в свой аккаунт; новая привязка апгрейдит открытый анонимный профиль, а не создаёт второй; Telegram Login даёт тот же `users.id`, что мини-апп. Слияние мягкое (`users.merged_into`): нажитое переносится, события остаются на прежнем id, повторный вызов ничего не делает. Автосвязка разных провайдеров по одинаковому e-mail запрещена.
- Бан живёт на аккаунте и поэтому распространяется на все его привязки; слияние берёт максимальный срок бана, а `web-*` id с привязанным входом (или уже слитый) анонимным путём не открывается — чистка `localStorage` не помогает.

## Модерация и безопасность

- Клиент раз в `FRAME_INTERVAL_MS` шлёт уменьшенный кадр **настоящей** камеры (даже в режиме маски).
- NSFW ≥ `NSFW_THRESHOLD` → собеседник отключается, нарушителю страйк; `STRIKES_TO_BAN` страйков → бан на `STRIKE_BAN_HOURS`.
- Возраст: 2 из 3 последних кадров с лицом «младше 20» ≥ `MINOR_THRESHOLD` → бан на `AGE_BLOCK_HOURS` с объяснением.
- Жалобы: `REPORTS_TO_BAN` уникальных за 7 дней → бан на 7 дней.
- Сервис модерации недоступен → кадр пропускается (fail-open) с записью в лог; сторож присылает алерт.
