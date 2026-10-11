"""Сторож Aura (systemd user timer на teslav100, раз в минуту).

Проверяет публичный адрес https://aura-life.online/healthz и сервис модерации.
Сообщает в Telegram только о смене состояния (упало / восстановилось) — без спама.
Бот и чат — те же, что у сторожа vLLM: TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USERS в ~/.hermes/.env.
"""
import json
import os
import time
import urllib.parse
import urllib.request

STATE = os.path.expanduser("~/aura-deploy/watchdog.state.json")
ENV = os.path.expanduser("~/.hermes/.env")
CHECKS = {
    "сайт и бэкенд": "https://aura-life.online/healthz",
    "модерация": "http://127.0.0.1:8095/healthz",
}
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


def probe(url):
    try:
        # Cloudflare отвечает 403 на стандартный User-Agent Python-urllib
        req = urllib.request.Request(url, headers={"User-Agent": "aura-watchdog/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read() or b"{}")
            return r.status == 200 and body.get("ok", False), body
    except Exception as e:  # noqa: BLE001
        return False, {"error": str(e)[:120]}


def main():
    try:
        state = json.load(open(STATE))
    except Exception:  # noqa: BLE001
        state = {}
    for name, url in CHECKS.items():
        ok, body = probe(url)
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
                notify(f"🔴 Aura: {name} не отвечает уже {FAILS_TO_ALERT} мин\n{url}\n{body.get('error', '')}")
        state[name] = s
    json.dump(state, open(STATE, "w"))


if __name__ == "__main__":
    main()
