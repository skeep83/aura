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
    R="/tmp/aura-vf-$lang-$fmt"
    tar -C "$TMP/$lang-$fmt" -cf - . | ssh -o ServerAliveInterval=15 skeep@192.168.4.119 "rm -rf $R && mkdir -p $R && tar -C $R -xf -"
    ssh -o ServerAliveInterval=15 -n skeep@192.168.4.119 "ffmpeg -nostdin -loglevel error -y -framerate 30 -i $R/%04d.jpg -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -preset medium -movflags +faststart $R/out.mp4"
    scp -q "skeep@192.168.4.119:$R/out.mp4" "branding/ads/aura-$lang-$fmt.mp4"
    ssh -n skeep@192.168.4.119 "rm -rf $R"
    rm -rf "$TMP/$lang-$fmt"
    echo "aura-$lang-$fmt.mp4 $(du -h "branding/ads/aura-$lang-$fmt.mp4" | cut -f1)"
  done
done
rm -rf "$TMP"
