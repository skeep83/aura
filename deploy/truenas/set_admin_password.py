"""Задать пароль панели Aura Admin. Пароль вводится скрыто и не сохраняется — только scrypt-хэш в admin.env,
после чего панель перезапускается. Запуск: ssh -t skeep@192.168.4.119 '~/.hermes/hermes-agent/venv/bin/python ~/aura-deploy/set_admin_password.py'"""
import asyncio, getpass, hashlib, os, secrets, sys

ENV = os.path.expanduser("~/aura-deploy/admin.env")

pw = getpass.getpass("Новый пароль для Aura Admin (от 10 символов): ")
if len(pw) < 10:
    sys.exit("Слишком короткий — нужно хотя бы 10 символов.")
if getpass.getpass("Повторите: ") != pw:
    sys.exit("Пароли не совпали.")
salt = secrets.token_bytes(16)
digest = hashlib.scrypt(pw.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
line = f"ADMIN_PASSWORD_HASH={salt.hex()}:{digest.hex()}"

lines = []
if os.path.exists(ENV):
    lines = [l for l in open(ENV).read().splitlines() if not l.startswith("ADMIN_PASSWORD_HASH=")]
lines.append(line)
fd = os.open(ENV, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(lines) + "\n")
print("Пароль сохранён (в виде хэша). Перезапускаю панель…")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import admin_deploy
asyncio.run(admin_deploy.main())
print("Готово: http://192.168.4.166:30190")
