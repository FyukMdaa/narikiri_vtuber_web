// ──────────────────────────────────────────────────────────────
// detection-loop.js - MediaPipe 検出ループ
//   face / pose / hand を約30Hzで検出し、オーバーレイ描画と
//   VRM / Inochi2D 適用を行う。MediaPipe の検出自体はメインスレッドで
//   実行する（Tasks Vision bundle が Module Worker 内の importScripts() と
//   非互換なため）。描画の rAF とは検出間隔を分離する。
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
import { detectFrame } from 'app/camera/trackers.js';

const DETECTION_INTERVAL_MS = 1000 / 30;
let lastDetectionMs = 0;

// Worker への detect リクエストが往復している間は次のフレームを
// 投げない（キュー溜まり・遅延蓄積を防ぐためのバックプレッシャー制御）。
let inFlight = false;
let stopped = false;

export function stopDetectionLoop() {
  stopped = true;
  if (cameraState.detectionLoopId) {
    cancelAnimationFrame(cameraState.detectionLoopId);
    cameraState.detectionLoopId = null;
  }
}

export function runDetectionLoop() {
  stopped = false;
  scheduleNext();
}

function scheduleNext() {
  if (stopped) return;
  cameraState.detectionLoopId = requestAnimationFrame(tick);
}

async function tick() {
  if (stopped || !cameraState.mediaStream || !cameraState.trackersReady) return;

  const nowMs = performance.now();
  if (inFlight || (lastDetectionMs && nowMs - lastDetectionMs < DETECTION_INTERVAL_MS)) {
    scheduleNext();
    return;
  }
  if (ui.video.readyState < 2 /* HAVE_CURRENT_DATA */ || ui.video.videoWidth === 0) {
    scheduleNext();
    return;
  }
  lastDetectionMs = nowMs;
  inFlight = true;

  // Inochi2D モード時は detection-loop 側で apply を呼ぶことを通知
  if (modeState.current === 'inochi') setDetectionActive(true);

  try {
    // MediaPipe Tasks Vision は HTMLVideoElement を直接受け取れる。
    // ImageBitmap 化や Worker 転送は行わない。
    const result = await detectFrame(ui.video, nowMs);
    applyResult(result);
  } catch (err) {
    console.warn('[Tracking] detection failed; loop will recover:', err);
  } finally {
    inFlight = false;
    scheduleNext();
  }
}

function applyResult(result) {
  // ── 検出結果を最新ランドマークへ反映 ──
  latestLandmarks.hands = result.hands ?? [];
  latestLandmarks.face = result.face ?? null;
  latestLandmarks.pose = result.pose ?? null;
  latestLandmarks.faceBlendshapes = result.faceBlendshapes ?? null;
  latestLandmarks.headMatrix = result.headMatrix ?? null;

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
}
