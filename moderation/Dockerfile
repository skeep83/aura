# По умолчанию — лёгкая CPU-сборка (~1 ГБ). Для NVIDIA GPU:
#   docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
# (там TORCH_INDEX переключается на CUDA-колёса)
FROM python:3.11-slim

ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
WORKDIR /app
RUN pip install --no-cache-dir torch==2.5.1 --index-url ${TORCH_INDEX}
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Модель скачивается при сборке, чтобы старт не зависел от Hugging Face
ARG MODEL=Falconsai/nsfw_image_detection
ENV MODEL=${MODEL} HF_HUB_DISABLE_TELEMETRY=1
ARG AGE_MODEL=nateraw/vit-age-classifier
ENV AGE_MODEL=${AGE_MODEL}
RUN python -c "from transformers import pipeline; pipeline('image-classification', model='${MODEL}'); pipeline('image-classification', model='${AGE_MODEL}')"

COPY app.py .
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
