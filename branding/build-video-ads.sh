#!/usr/bin/env bash
# Все видеокреативы: кадры рендерит Chrome на Mac, MP4 кодирует ffmpeg на teslav100 (на Mac ffmpeg нет).
#   bash branding/build-video-ads.sh [lang ...]
set -euo pipefail
cd "$(dirname "$0")/.."
LANGS=("${@:-ru en es de pt}")
TMP=$(mktemp -d)
for lang in ${LANGS[@]}; do
  for fmt in story square; do
    node branding/render-video.mjs "$lang" "$fmt" "$TMP/$lang-$fmt" >/dev/null
    tar -C "$TMP/$lang-$fmt" -cf - . | ssh skeep@192.168.4.119 "rm -rf /tmp/aura-vf && mkdir -p /tmp/aura-vf && tar -C /tmp/aura-vf -xf - && \
      ffmpeg -loglevel error -y -framerate 30 -i /tmp/aura-vf/%04d.jpg -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -preset slow -movflags +faststart /tmp/aura-vf/out.mp4 && \
      cat /tmp/aura-vf/out.mp4 && rm -rf /tmp/aura-vf" > "branding/ads/aura-$lang-$fmt.mp4"
    rm -rf "$TMP/$lang-$fmt"
    echo "aura-$lang-$fmt.mp4 $(du -h "branding/ads/aura-$lang-$fmt.mp4" | cut -f1)"
  done
done
rm -rf "$TMP"
