"""Aura Admin на TrueNAS: приложение aura-admin (node:22-alpine), порт 30190 в домашней сети.
Код — admin.tgz в датасете Home_Storage/aura-admin/bundle, секреты — ~/aura-deploy/admin.env (600):
ADMIN_API_TOKEN (тот же, что в .env продакшена) и ADMIN_PASSWORD_HASH (set_admin_password.py).
Повторный запуск = обновление кода и перезапуск."""
import asyncio, os, sys
sys.path.insert(0, "/home/skeep/tn-mqtt")
sys.path.insert(0, os.path.expanduser("~/aura-deploy"))
from tn_ws import connect
from deploy import upload, wait_job

ROOT = "/mnt/Home_Storage/aura-admin"
APP = "aura-admin"
COMPOSE = """
services:
  admin:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    command: ["sh", "-c", "rm -rf /app/* && tar xzf /bundle/admin.tgz -C /app && exec node server.js"]
    environment:
      PORT: "8090"
      AURA_API: https://aura-life.online
      NODE_NO_WARNINGS: "1"
    env_file:
      - /mnt/Home_Storage/aura-admin/secrets/admin.env
    ports:
      - "30190:8090"
    volumes:
      - /mnt/Home_Storage/aura-admin/bundle:/bundle:ro
"""

async def main():
    tn = await connect()
    if not await tn.call("pool.dataset.query", [["name", "=", "Home_Storage/aura-admin"]]):
        await tn.call("pool.dataset.create", {"name": "Home_Storage/aura-admin", "share_type": "GENERIC"})
        print("датасет создан")
    for sub in ("bundle", "secrets"):
        try:
            await tn.call("filesystem.mkdir", {"path": f"{ROOT}/{sub}"})
        except RuntimeError as e:
            if "exist" not in str(e).lower(): raise
    base = os.path.expanduser("~/aura-deploy")
    print("upload admin.tgz", upload(f"{base}/admin.tgz", f"{ROOT}/bundle/admin.tgz"))
    env = f"{base}/admin.env"
    if os.path.exists(env):
        upload(env, f"{ROOT}/secrets/admin.env")
        await tn.call("filesystem.setperm", {"path": f"{ROOT}/secrets/admin.env", "mode": "600"})
        await tn.call("filesystem.setperm", {"path": f"{ROOT}/secrets", "mode": "700"})
        print("секреты загружены")
    existing = await tn.call("app.query", [["name", "=", APP]])
    if existing:
        job = await tn.call("app.update", APP, {"custom_compose_config_string": COMPOSE})
        await wait_job(tn, job, "update")
        job = await tn.call("app.redeploy", APP)
        await wait_job(tn, job, "redeploy")
    else:
        job = await tn.call("app.create", {"app_name": APP, "custom_app": True, "custom_compose_config_string": COMPOSE})
        await wait_job(tn, job, "create")
    app = await tn.call("app.query", [["name", "=", APP]], {"select": ["state"]})
    print("state", app[0]["state"] if app else None)
    await tn.ws.close()

if __name__ == "__main__":
    asyncio.run(main())
