"""Сторож Aura (systemd user timer на teslav100, раз в минуту).

Проверяет продакшен на VPS: страницу Mini App, бэкенд, живую модерацию и TURN (STUN-запрос на UDP 3478).
Сообщает в Telegram только о смене состояния (упало / восстановилось) — без спама.
Бот и чат — те же, что у сторожа vLLM: TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USERS в ~/.hermes/.env.
"""
import json
import os
import socket
import struct
import time
import urllib.parse
import urllib.request

STATE = os.path.expanduser("~/aura-deploy/watchdog.state.json")
ENV = os.path.expanduser("~/.hermes/.env")
SITE = "https://aura-life.online"
TURN = ("81.17.102.217", 3478)
FAILS_TO_ALERT = 3  # подряд, чтобы не будить из-за секундного сбоя Starlink


def env(key):
    for line in open(ENV, encoding="utf-8", errors="replace"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def notify(text):
    token = env("TELEGRAM_BOT_TOKEN")
    chat = (env("TELEGRAM_ALLOWED_USERS").split(",") or [""])[0].strip()
    if not token or not chat:
        return
    data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data=data, timeout=15)
    except Exception:  # noqa: BLE001
        pass


def fetch(path):
    # Cloudflare отвечает 403 на стандартный User-Agent Python-urllib
    req = urllib.request.Request(SITE + path, headers={"User-Agent": "aura-watchdog/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, r.read()


def stun(host, port):
    """STUN Binding Request: TURN-сервер должен ответить Binding Success (0x0101)."""
    tid = os.urandom(12)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        s.sendto(struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tid, (host, port))
        data, _ = s.recvfrom(1024)
        return data[:2] == b"\x01\x01" and data[8:20] == tid
    finally:
        s.close()


def checks():
    out = {}
    try:
        code, body = fetch("/")
        out["страница Mini App"] = (code == 200 and b"app.js" in body, "")
    except Exception as e:  # noqa: BLE001
        out["страница Mini App"] = (False, str(e)[:120])
    try:
        code, body = fetch("/healthz")
        h = json.loads(body or b"{}")
        out["бэкенд"] = (code == 200 and h.get("ok", False), "")
        out["модерация"] = (h.get("moderationUp") is not False and h.get("moderation", False), "сервис модерации не отвечает")
    except Exception as e:  # noqa: BLE001
        out["бэкенд"] = (False, str(e)[:120])
    for attempt in range(2):
        try:
            ok = stun(*TURN)
        except Exception as e:  # noqa: BLE001
            ok, err = False, str(e)[:120]
        if ok:
            break
    out["TURN"] = (ok, "" if ok else "нет ответа на STUN :3478/udp")
    return out


def main():
    try:
        state = json.load(open(STATE))
    except Exception:  # noqa: BLE001
        state = {}
    for name, (ok, err) in checks().items():
        s = state.get(name, {"fails": 0, "down": False})
        if ok:
            if s["down"]:
                minutes = round((time.time() - s.get("since", time.time())) / 60)
                notify(f"✅ Aura: {name} снова работает (простой ~{minutes} мин)")
            s = {"fails": 0, "down": False}
        else:
            s["fails"] += 1
            if s["fails"] >= FAILS_TO_ALERT and not s["down"]:
                s["down"], s["since"] = True, time.time()
                notify(f"🔴 Aura: {name} — не работает уже {FAILS_TO_ALERT} мин\n{err}")
        state[name] = s
    json.dump(state, open(STATE, "w"))


if __name__ == "__main__":
    main()
