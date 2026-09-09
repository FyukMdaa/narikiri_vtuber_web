// ──────────────────────────────────────────────────────────────
// mediapipe-worker.js - MediaPipe (Face/Pose/Hand) をメインスレッドから
// 分離して実行する Web Worker。
//
//   ・モデル/WASM は自己ホスト（ローカル配信）のパスのみを使用する
//     （CDN 依存なし: jsdelivr / storage.googleapis.com を参照しない）
//   ・Worker コンテキストには `document` が存在しないため、
//     tasks-vision は GPU デリゲート使用時に内部で OffscreenCanvas を
//     利用して描画コンテキストを確保する（ブラウザネイティブ機能）。
//     これにより「WebWorker + OffscreenCanvas」構成が実現される。
//   ・メインスレッドは動画フレームを ImageBitmap 化して transferable
//     として本 Worker へ渡す（video/DOM は Worker から直接触れないため）。
// ──────────────────────────────────────────────────────────────
import {
  FilesetResolver,
  FaceLandmarker,
  PoseLandmarker,
  HandLandmarker,
} from '../vendor/mediapipe/vision_bundle.mjs';

let faceLandmarker = null;
let poseLandmarker = null;
let handLandmarker = null;
let ready = false;
let closing = false;

function closeAll() {
  for (const t of [faceLandmarker, poseLandmarker, handLandmarker]) {
    try { t?.close?.(); } catch { /* noop */ }
  }
  faceLandmarker = null;
  poseLandmarker = null;
  handLandmarker = null;
  ready = false;
}

// GPU デリゲートで作成を試み、失敗（未対応環境等）した場合は CPU にフォールバック。
async function createWithFallback(Klass, vision, modelAssetPath, extraOptions, delegate) {
  const baseOptions = { modelAssetPath, delegate };
  try {
    return await Klass.createFromOptions(vision, { baseOptions, ...extraOptions });
  } catch (err) {
    if (delegate === 'GPU') {
      console.warn('[mediapipe-worker] GPU delegate 初期化に失敗。CPU にフォールバックします。', err);
      return await Klass.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate: 'CPU' },
        ...extraOptions,
      });
    }
    throw err;
  }
}

async function init({ wasmBase, models, delegate }) {
  closeAll();
  const vision = await FilesetResolver.forVisionTasks(wasmBase);

  faceLandmarker = await createWithFallback(FaceLandmarker, vision, models.face, {
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  }, delegate);

  poseLandmarker = await createWithFallback(PoseLandmarker, vision, models.pose, {
    runningMode: 'VIDEO',
    numPoses: 1,
  }, delegate);

  handLandmarker = await createWithFallback(HandLandmarker, vision, models.hand, {
    runningMode: 'VIDEO',
    numHands: 2,
    outputHandedness: true,
  }, delegate);

  ready = true;
}

function detect(bitmap, timestamp) {
  // detectForVideo は毎フレーム単調増加する timestamp (ms) を要求する。
  const faceResult = faceLandmarker.detectForVideo(bitmap, timestamp);
  const poseResult = poseLandmarker.detectForVideo(bitmap, timestamp);
  const handResult = handLandmarker.detectForVideo(bitmap, timestamp);

  const hands = [];
  if (handResult.landmarks) {
    for (let i = 0; i < handResult.landmarks.length; i++) {
      hands.push({
        landmarks: handResult.landmarks[i],
        handedness: handResult.handedness?.[i]?.[0]?.categoryName ?? null,
        score: handResult.handedness?.[i]?.[0]?.score ?? 0,
      });
    }
  }

  return {
    timestamp,
    face: faceResult.faceLandmarks?.[0] ?? null,
    pose: poseResult.landmarks?.[0] ?? null,
    faceBlendshapes: faceResult.faceBlendshapes?.[0]?.categories ?? null,
    headMatrix: faceResult.facialTransformationMatrixes?.[0]?.data ?? null,
    hands,
  };
}

self.onmessage = async (event) => {
  const { type, id } = event.data ?? {};
  try {
    switch (type) {
      case 'init': {
        await init(event.data);
        self.postMessage({ type: 'ready', id });
        break;
      }
      case 'detect': {
        const { bitmap, timestamp } = event.data;
        if (!ready || closing) {
          bitmap?.close?.();
          self.postMessage({ type: 'error', id, error: 'not-ready' });
          break;
        }
        let payload;
        try {
          payload = detect(bitmap, timestamp);
        } finally {
          bitmap.close();
        }
        self.postMessage({ type: 'result', id, ...payload });
        break;
      }
      case 'close': {
        closing = true;
        closeAll();
        self.postMessage({ type: 'closed', id });
        closing = false;
        break;
      }
      default:
        self.postMessage({ type: 'error', id, error: `unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String(err?.message ?? err) });
  }
};
