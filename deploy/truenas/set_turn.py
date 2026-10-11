"""Ключ TURN от Cloudflare Realtime для Aura. Вводится скрыто, проверяется запросом к Cloudflare
и сохраняется в /mnt/Home_Storage/aura/data/turn.env (только root), после чего приложение перезапускается.
Запуск на teslav100:  ~/.hermes/hermes-agent/venv/bin/python ~/aura-deploy/set_turn.py"""
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

ENV_PATH = "/mnt/Home_Storage/aura/data/turn.env"

key_id = input("Turn Token ID (Key ID) из Cloudflare: ").strip()
token = getpass.getpass("API Token (ввод скрыт): ").strip()
req = urllib.request.Request(
    f"https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers",
    data=json.dumps({"ttl": 300}).encode(), method="POST",
    headers={"authorization": f"Bearer {token}", "content-type": "application/json", "user-agent": "aura-setup/1.0"})
try:
    servers = json.load(urllib.request.urlopen(req, timeout=15)).get("iceServers")
except Exception as e:  # noqa: BLE001
    sys.exit(f"Cloudflare не принял ключ: {e}")
print("OK: Cloudflare выдал TURN-серверы")

with tempfile.NamedTemporaryFile("w", delete=False) as f:
    f.write(f"CF_TURN_KEY_ID={key_id}\nCF_TURN_TOKEN={token}\n")
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
print("Готово: звонки пойдут через TURN Cloudflare, если прямое соединение не получилось.")
