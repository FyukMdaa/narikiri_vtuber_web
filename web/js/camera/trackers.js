// ──────────────────────────────────────────────────────────────
// trackers.js - MediaPipe (Face / Pose / Hand) の初期化
//
// MediaPipe Tasks Vision の配布済み bundle は、WASM 初期化時に
// importScripts() を内部利用するため Module Worker から実行できない。
// そのためここではメインスレッドで初期化・検出する。
// 検出頻度は detection-loop.js 側で制限し、描画/UI の rAF とは分離する。
// ──────────────────────────────────────────────────────────────
import { cameraState, ui } from 'app/state.js';
import { MEDIAPIPE_ASSETS } from 'app/config.js';
import {
  FilesetResolver,
  FaceLandmarker,
  PoseLandmarker,
  HandLandmarker,
} from 'app/vendor/mediapipe/vision_bundle.mjs';

let vision = null;
let faceLandmarker = null;
let poseLandmarker = null;
let handLandmarker = null;

function closeOne(tracker) {
  try { tracker?.close?.(); } catch { /* noop */ }
}

function closeAll() {
  closeOne(faceLandmarker);
  closeOne(poseLandmarker);
  closeOne(handLandmarker);
  faceLandmarker = null;
  poseLandmarker = null;
  handLandmarker = null;
  vision = null;
  cameraState.trackersReady = false;
}

async function createWithFallback(Klass, modelAssetPath, extraOptions, delegate) {
  try {
    return await Klass.createFromOptions(vision, {
      baseOptions: { modelAssetPath, delegate },
      ...extraOptions,
    });
  } catch (err) {
    if (delegate === 'GPU') {
      console.warn('[Tracking] GPU delegate の初期化に失敗。CPU にフォールバックします。', err);
      return await Klass.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate: 'CPU' },
        ...extraOptions,
      });
    }
    throw err;
  }
}

export async function initTrackers() {
  if (cameraState.trackersReady) return;
  ui.statusTag.textContent = 'トラッキングモデルを読み込み中…';

  // 前回の中途半端な初期化を確実に破棄。
  closeAll();

  try {
    const wasmBase = new URL(MEDIAPIPE_ASSETS.wasmBase, document.baseURI).href;
    const models = {
      face: new URL(MEDIAPIPE_ASSETS.models.face, document.baseURI).href,
      pose: new URL(MEDIAPIPE_ASSETS.models.pose, document.baseURI).href,
      hand: new URL(MEDIAPIPE_ASSETS.models.hand, document.baseURI).href,
    };

    // MediaPipe Tasks Vision の WASM ランタイムをメインスレッドで初期化。
    // Module Worker では bundle 内の importScripts() と衝突するため、
    // Worker には移さない。
    vision = await FilesetResolver.forVisionTasks(wasmBase);

    faceLandmarker = await createWithFallback(FaceLandmarker, models.face, {
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    }, MEDIAPIPE_ASSETS.delegate);

    poseLandmarker = await createWithFallback(PoseLandmarker, models.pose, {
      runningMode: 'VIDEO',
      numPoses: 1,
    }, MEDIAPIPE_ASSETS.delegate);

    handLandmarker = await createWithFallback(HandLandmarker, models.hand, {
      runningMode: 'VIDEO',
      numHands: 2,
      outputHandedness: true,
    }, MEDIAPIPE_ASSETS.delegate);

    cameraState.trackersReady = true;
  } catch (err) {
    closeAll();
    throw err;
  }
}

// video は HTMLVideoElement のまま渡す。
// detectForVideo() はメインスレッドで同期実行されるため、呼び出し頻度は
// detection-loop.js の 30Hz 制限で抑える。
export function detectFrame(video, timestamp) {
  if (!cameraState.trackersReady || !faceLandmarker || !poseLandmarker || !handLandmarker) {
    return Promise.reject(new Error('trackers not ready'));
  }

  try {
    const faceResult = faceLandmarker.detectForVideo(video, timestamp);
    const poseResult = poseLandmarker.detectForVideo(video, timestamp);
    const handResult = handLandmarker.detectForVideo(video, timestamp);

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

    return Promise.resolve({
      timestamp,
      face: faceResult.faceLandmarks?.[0] ?? null,
      pose: poseResult.landmarks?.[0] ?? null,
      faceBlendshapes: faceResult.faceBlendshapes?.[0]?.categories ?? null,
      headMatrix: faceResult.facialTransformationMatrixes?.[0]?.data ?? null,
      hands,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

export async function closeTrackers() {
  closeAll();
}
