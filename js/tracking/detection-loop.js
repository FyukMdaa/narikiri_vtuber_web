// ──────────────────────────────────────────────────────────────
// detection-loop.js - MediaPipe 検出ループ
//   毎フレーム face / pose / hand を検出し、オーバーレイ描画と
//   VRM 適用を行う。runDetectionLoop は再帰的に rAF を呼ぶ。
//
//   ※modeState.current が 'inochi' のときは applyLandmarksToVrm の
//    代わりに applyLandmarksToInochi を呼ぶ（VRM とは排他）
// ──────────────────────────────────────────────────────────────
import { cameraState, ui, latestLandmarks, zoomState, sceneState, modeState, inochiState } from 'app/state.js';

import { renderOverlay } from 'app/camera/overlay.js';
import { applyLandmarksToVrm } from 'app/tracking/apply.js';
import { applyLandmarksToInochi } from 'app/tracking/apply-inochi.js';
import { shoulderWidthToZoom, getShoulderWidth } from 'app/core/animation-loop.js';
import { setDetectionActive } from 'app/core/inochi-canvas.js';

export function runDetectionLoop() {
  if (!cameraState.mediaStream || !cameraState.trackersReady) return;

  // Inochi2D モード時は detection-loop 側で apply を呼ぶことを通知
  if (modeState.current === 'inochi') setDetectionActive(true);

  const nowMs = performance.now();
  const faceResult = cameraState.faceLandmarker.detectForVideo(ui.video, nowMs);
  const poseResult = cameraState.poseLandmarker.detectForVideo(ui.video, nowMs);
  const handResult = cameraState.handLandmarker.detectForVideo(ui.video, nowMs);

  // ── 検出結果を最新ランドマークへ反映 ──
  latestLandmarks.hands = [];
  if (handResult.landmarks) {
    for (let i = 0; i < handResult.landmarks.length; i++) {
      latestLandmarks.hands.push({
        landmarks: handResult.landmarks[i],
        handedness: handResult.handedness?.[i]?.[0]?.categoryName ?? null,
        score: handResult.handedness?.[i]?.[0]?.score ?? 0,
      });
    }
  }

  latestLandmarks.face = faceResult.faceLandmarks?.[0] ?? null;
  latestLandmarks.pose = poseResult.landmarks?.[0] ?? null;
  latestLandmarks.faceBlendshapes = faceResult.faceBlendshapes?.[0]?.categories ?? null;
  latestLandmarks.headMatrix = faceResult.facialTransformationMatrixes?.[0]?.data ?? null;

  // ── ズーム調整（VRM モード時のみ）──
  if (modeState.current === 'vrm') {
    if (zoomState.enabled && latestLandmarks.pose) {
      const sw = getShoulderWidth(latestLandmarks.pose);
      if (sw > 0.05) {
        zoomState.target = shoulderWidthToZoom(sw);
      }
    } else if (!zoomState.enabled) {
      zoomState.target = 1.0;
    }
  }

  // ── オーバーレイ描画（ボタンが active のときのみ）──
  if (ui.btnOverlay.classList.contains('active')) {
    renderOverlay();
  } else {
    ui.overlayCtx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
  }

  // ── 適用先へ反映（モードで排他切替）──
  if (modeState.current === 'inochi' && inochiState.puppetHandle) {
    applyLandmarksToInochi(inochiState.puppetHandle);
  } else if (sceneState.currentVrm) {
    applyLandmarksToVrm(sceneState.currentVrm);
  }

  cameraState.detectionLoopId = requestAnimationFrame(runDetectionLoop);
}
