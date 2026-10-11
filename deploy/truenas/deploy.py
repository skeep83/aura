"""Развёртывание Aura на TrueNAS: датасет, загрузка кода, приложение (app + постоянный туннель Cloudflare на aura-life.online).
Повторный запуск = обновление кода и перезапуск."""
import asyncio, json, os, ssl, sys, uuid, urllib.request
sys.path.insert(0, "/home/skeep/tn-mqtt")
from tn_ws import connect
from tnapi import KEY, TN

ROOT = "/mnt/Home_Storage/aura"
APP = "aura"
COMPOSE = """
services:
  # Фронтенд: nginx отдаёт статику Mini App и проксирует /ws, /api, /s, /healthz в бэкенд
  web:
    image: nginx:1.27-alpine
    restart: unless-stopped
    command: ["sh", "-c", "rm -rf /usr/share/nginx/html/* && tar xzf /bundle/web.tgz -C /usr/share/nginx/html && exec nginx -g 'daemon off;'"]
    volumes:
      - /mnt/Home_Storage/aura/bundle:/bundle:ro
      - /mnt/Home_Storage/aura/web/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    ports:
      - "30180:80"
    depends_on:
      - api
  # Бэкенд: WebSocket, подбор пар, бот, база SQLite
  api:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    command: ["sh", "-c", "mkdir -p /app && tar xzf /bundle/api.tgz -C /app && exec node --env-file-if-exists=/data/.env src/server.js"]
    environment:
      APP_NAME: Aura
      PORT: "8080"
      DATA_DIR: /data
      PUBLIC_URL: https://aura-life.online
      TZ_OFFSET_HOURS: "3"
      MINIAPP_SHORT_NAME: app
      SERVE_STATIC: "0"
      MODERATION_URL: http://192.168.4.119:8095
      NODE_NO_WARNINGS: "1"
    # Токен модерации — отдельным файлом (права 600), чтобы не светить его в конфиге приложения
    env_file:
      - /mnt/Home_Storage/aura/data/moderation.env
      - path: /mnt/Home_Storage/aura/data/turn.env
        required: false
    volumes:
      - /mnt/Home_Storage/aura/bundle:/bundle:ro
      - /mnt/Home_Storage/aura/data:/data
  # Постоянный туннель «aura»: aura-life.online / www → web
  tunnel:
    image: cloudflare/cloudflared:2025.1.0
    restart: unless-stopped
    command: ["tunnel", "--no-autoupdate", "run", "--credentials-file", "/etc/cloudflared/creds.json", "--url", "http://web:80", "e1122556-a6a1-47de-8370-05c35d71433c"]
    volumes:
      - /mnt/Home_Storage/aura/tunnel:/etc/cloudflared:ro
    depends_on:
      - web
"""

CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE

def upload(local, remote):
    b = uuid.uuid4().hex
    data = json.dumps({"path": remote, "options": {"mode": 0o644}}).encode()
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"data\"\r\n\r\n").encode() + data + \
           (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"f\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + \
           open(local, "rb").read() + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(TN + "/filesystem/put", data=body, method="POST",
        headers={"Authorization": "Bearer " + KEY, "Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req, timeout=120, context=CTX) as r:
        return r.status

async def wait_job(tn, job, label):
    for _ in range(180):
        j = (await tn.call("core.get_jobs", [["id", "=", job]]))[0]
        if j["state"] in ("SUCCESS", "FAILED", "ABORTED"):
            print(label, j["state"], (j.get("error") or "")[:800])
            return j["state"] == "SUCCESS"
        await asyncio.sleep(5)
    print(label, "timeout"); return False

async def main():
    tn = await connect()
    if not await tn.call("pool.dataset.query", [["name", "=", "Home_Storage/aura"]]):
        await tn.call("pool.dataset.create", {"name": "Home_Storage/aura", "share_type": "GENERIC"})
        print("датасет создан")
    for sub in ("bundle", "data", "tunnel", "web"):
        try:
            await tn.call("filesystem.mkdir", {"path": f"{ROOT}/{sub}"})
        except RuntimeError as e:
            if "exist" not in str(e).lower(): raise
    base = os.path.expanduser("~/aura-deploy")
    for name in ("api.tgz", "web.tgz"):
        print("upload", name, upload(f"{base}/{name}", f"{ROOT}/bundle/{name}"))
    print("upload nginx.conf", upload(f"{base}/nginx.conf", f"{ROOT}/web/nginx.conf"))
    mod_env = f"{base}/moderation.env"
    if os.path.exists(mod_env):
        upload(mod_env, f"{ROOT}/data/moderation.env")
        await tn.call("filesystem.setperm", {"path": f"{ROOT}/data/moderation.env", "mode": "600"})
        print("токен модерации загружен")
    # Ключ туннеля: читать может только пользователь контейнера cloudflared (nonroot, uid 65532)
    creds = os.path.expanduser("~/aura-deploy/cf/creds.json")
    if os.path.exists(creds):
        upload(creds, f"{ROOT}/tunnel/creds.json")
        await tn.call("filesystem.setperm", {"path": f"{ROOT}/tunnel/creds.json", "mode": "600", "uid": 65532, "gid": 65532})
        print("ключ туннеля загружен")

    existing = await tn.call("app.query", [["name", "=", APP]])
    if existing:
        job = await tn.call("app.update", APP, {"custom_compose_config_string": COMPOSE})
        await wait_job(tn, job, "update")
        job = await tn.call("app.redeploy", APP)
        await wait_job(tn, job, "redeploy")
    else:
        job = await tn.call("app.create", {"app_name": APP, "custom_app": True, "custom_compose_config_string": COMPOSE})
        await wait_job(tn, job, "create")
    app = await tn.call("app.query", [["name", "=", APP]], {"select": ["state", "active_workloads"]})
    print("state", app[0]["state"] if app else None)

if __name__ == "__main__":
    asyncio.run(main())
