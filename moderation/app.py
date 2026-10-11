"""Модерация кадров видеорулетки: NSFW и оценка возраста по лицу.

POST /check  {"image": "<base64 jpeg>"}  ->  {"nsfw": 0..1, "minor": 0..1 | null, "face": bool}
  nsfw  — вероятность недопустимого контента по всему кадру;
  minor — вероятность, что человеку в кадре меньше 20 (классы возраста 0-2, 3-9, 10-19) по самому крупному лицу,
          null — лицо не найдено.
Авторизация: заголовок Authorization: Bearer $MODERATION_TOKEN.
Кадры не сохраняются: проверили в памяти и забыли.
"""
import base64
import binascii
import io
import os
import secrets

import cv2
import numpy as np
import torch
from fastapi import Depends, FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel
from transformers import pipeline

NSFW_MODEL = os.getenv("MODEL", "Falconsai/nsfw_image_detection")
AGE_MODEL = os.getenv("AGE_MODEL", "nateraw/vit-age-classifier")
TOKEN = os.getenv("MODERATION_TOKEN", "")
DEVICE = 0 if torch.cuda.is_available() else -1
# Не отнимать все ядра у соседей по серверу
torch.set_num_threads(int(os.getenv("TORCH_THREADS", "4")))

nsfw_clf = pipeline("image-classification", model=NSFW_MODEL, device=DEVICE)
age_clf = pipeline("image-classification", model=AGE_MODEL, device=DEVICE, top_k=None)
faces = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
MINOR_LABELS = {"0-2", "3-9", "10-19"}

app = FastAPI(title="aura-moderation", docs_url=None, redoc_url=None)


def check_token(authorization: str = Header(default="")):
    if not TOKEN or not secrets.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(status_code=401)


class Frame(BaseModel):
    image: str


def largest_face(img: Image.Image):
    gray = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)
    found = faces.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    if len(found) == 0:
        return None
    x, y, w, h = max(found, key=lambda f: f[2] * f[3])
    # Классификатор возраста учили на кропах лица с запасом вокруг
    m = int(0.35 * max(w, h))
    return img.crop((max(0, x - m), max(0, y - m), min(img.width, x + w + m), min(img.height, y + h + m)))


@app.get("/healthz")
def healthz():
    return {"ok": True, "nsfw_model": NSFW_MODEL, "age_model": AGE_MODEL, "cuda": DEVICE == 0}


@app.post("/check", dependencies=[Depends(check_token)])
def check(frame: Frame):
    if len(frame.image) > 400_000:
        raise HTTPException(status_code=413)
    try:
        img = Image.open(io.BytesIO(base64.b64decode(frame.image, validate=True))).convert("RGB")
    except (binascii.Error, OSError):
        raise HTTPException(status_code=400, detail="bad image")

    scores = {r["label"].lower(): r["score"] for r in nsfw_clf(img)}
    nsfw = sum(v for k, v in scores.items() if k in ("nsfw", "porn", "hentai", "sexy"))

    face = largest_face(img)
    minor = None
    if face is not None:
        ages = {r["label"]: r["score"] for r in age_clf(face)}
        minor = sum(v for k, v in ages.items() if k in MINOR_LABELS)
    return {"nsfw": round(float(nsfw), 4), "minor": None if minor is None else round(float(minor), 4), "face": face is not None}
