// ──────────────────────────────────────────────────────────────
// trackers.js - MediaPipe (Face / Pose / Hand) の初期化
// ──────────────────────────────────────────────────────────────
import {
  FilesetResolver,
  FaceLandmarker,
  PoseLandmarker,
  HandLandmarker,
} from '@mediapipe/tasks-vision';

import { cameraState, ui } from 'app/state.js';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

// 3つのトラッカーを順に初期化。失敗時は例外を上層へ伝播。
export async function initTrackers() {
  if (cameraState.trackersReady) return;
  ui.statusTag.textContent = 'トラッキングモデルを読み込み中…';

  const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

  cameraState.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODELS.face, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });

  cameraState.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODELS.pose, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  });

  cameraState.handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODELS.hand, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    outputHandedness: true,
  });

  cameraState.trackersReady = true;
}
