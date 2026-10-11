"""Ввод токена бота для Aura на TrueNAS. Токен не попадает в историю shell и в чат:
вводится скрыто, проверяется через getMe и сохраняется в /mnt/Home_Storage/aura/data/.env (только root).
Запуск на teslav100:  ~/.hermes/hermes-agent/venv/bin/python ~/aura-deploy/set_token.py"""
import asyncio
import getpass
import json
import os
import sys
import tempfile
import urllib.request

sys.path.insert(0, "/home/skeep/tn-mqtt")
sys.path.insert(0, os.path.expanduser("~/aura-deploy"))
from tn_ws import connect  # noqa: E402
from deploy import upload, wait_job  # noqa: E402

ENV_PATH = "/mnt/Home_Storage/aura/data/.env"

token = getpass.getpass("Токен бота от @BotFather (ввод скрыт): ").strip()
try:
    me = json.load(urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getMe", timeout=15))
except Exception as e:  # noqa: BLE001
    sys.exit(f"Токен не подошёл: {e}")
username = me["result"]["username"]
print(f"OK: бот @{username}")
admins = input("Ваш Telegram ID для админ-команд (можно пусто, узнать у @userinfobot): ").strip()
support = input("Контакт поддержки по оплате, например @my_support (можно пусто): ").strip()

lines = [f"BOT_TOKEN={token}", f"BOT_USERNAME={username}"]
if admins:
    lines.append(f"ADMIN_IDS={admins}")
if support:
    lines.append(f"SUPPORT_CONTACT={support}")
with tempfile.NamedTemporaryFile("w", delete=False) as f:
    f.write("\n".join(lines) + "\n")
    tmp = f.name
os.chmod(tmp, 0o600)


async def main():
    try:
        print("загрузка:", upload(tmp, ENV_PATH))
    finally:
        os.unlink(tmp)
    tn = await connect()
    await tn.call("filesystem.setperm", {"path": ENV_PATH, "mode": "600"})
    job = await tn.call("app.redeploy", "aura")
    await wait_job(tn, job, "перезапуск")


asyncio.run(main())
print(f"Готово. Через ~20 секунд откройте @{username} в Telegram и нажмите /start")
