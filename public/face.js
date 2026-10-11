// Распознавание лица на устройстве (MediaPipe Face Landmarker): рамка лица и «улыбка».
// Ничего не уходит на сервер. Модель грузится лениво — только для маски и игры «Не смейся».
window.AuraFace = (() => {
  const VER = '0.10.14';
  const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  let loading = null;
  let lastTs = 0;

  function load() {
    if (loading) return loading;
    loading = (async () => {
      const vision = await import(`${CDN}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const opts = delegate => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      });
      try { return await vision.FaceLandmarker.createFromOptions(files, opts('GPU')); }
      catch { return await vision.FaceLandmarker.createFromOptions(files, opts('CPU')); }
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  // → { box: {x, y, w, h} в долях кадра, smile: 0..1 } или null, если лица нет
  function detect(landmarker, video) {
    if (!video.videoWidth) return null;
    const ts = Math.max(performance.now(), lastTs + 1);
    lastTs = ts;
    const res = landmarker.detectForVideo(video, ts);
    const pts = res.faceLandmarks?.[0];
    if (!pts) return null;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const cats = res.faceBlendshapes?.[0]?.categories || [];
    const score = name => cats.find(c => c.categoryName === name)?.score || 0;
    return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, smile: Math.max(score('mouthSmileLeft'), score('mouthSmileRight')) };
  }

  return { load, detect };
})();
