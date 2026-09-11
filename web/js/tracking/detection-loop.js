// ──────────────────────────────────────────────────────────────
// detection-loop.js - MediaPipe 検出ループ
//   face / pose / hand をラウンドロビンで検出し（1 tick = 1種類、
//   各検出器は最大約20Hzで更新）、オーバーレイ描画と VRM / Inochi2D
//   適用を行う。MediaPipe の検出自体はメインスレッドで実行する
//   （Tasks Vision bundle が Module Worker 内の importScripts() と
//   非互換なため）。描画の rAF とは検出間隔を分離する。
//
//   ※modeState.current が 'inochi' のときは applyLandmarksToVrm の
//    代わりに applyLandmarksToInochi を呼ぶ（VRM とは排他）
// ──────────────────────────────────────────────────────────────
import { cameraState, ui, latestLandmarks, zoomState, sceneState, modeState, inochiState, cameraDisplayState } from 'app/state.js';

import { renderOverlay } from 'app/camera/overlay.js';
import { applyLandmarksToVrm } from 'app/tracking/apply.js';
import { applyLandmarksToInochi } from 'app/tracking/apply-inochi.js';
import { shoulderWidthToZoom, getShoulderWidth } from 'app/core/animation-loop.js';
import { setDetectionActive } from 'app/core/inochi-canvas.js';
import { detectPart } from 'app/camera/trackers.js';

// tick 自体は rAF ペースでゆるく制限するだけにし（高リフレッシュレート
// 環境での過剰実行を防ぐ程度）、face/pose/hand は下の PARTS を
// ラウンドロビンして1 tick につき1種類だけ検出する。
// 3モデルを同一 tick で同期実行すると1回のブロックが長くなり、
// 同じメインスレッドで動く描画側 rAF（animate()）まで巻き込んで
// コマ落ちする（トラッキング・アバター双方の「カクつき」の主因）。
const DETECTION_INTERVAL_MS = 1000 / 60;
let lastDetectionMs = 0;

const PARTS = ['face', 'pose', 'hand'];
let partIndex = 0;

// 各検出器の最新結果を保持するキャッシュ。ラウンドロビンで更新されない
// フィールドを毎tick nullで潰してしまわないよう、ここで合成する。
const resultCache = {
  face: null,
  pose: null,
  hands: [],
  faceBlendshapes: null,
  headMatrix: null,
};

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

  const part = PARTS[partIndex];
  partIndex = (partIndex + 1) % PARTS.length;

  try {
    // MediaPipe Tasks Vision は HTMLVideoElement を直接受け取れる。
    // ImageBitmap 化や Worker 転送は行わない。
    // face/pose/hand のうち1種類だけを検出し、キャッシュへマージする
    // （他の2種類は前回検出時の値を保持したまま）。
    const partial = detectPart(part, ui.video, nowMs);
    Object.assign(resultCache, partial);
    applyResult(resultCache);
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

  // ── オーバーレイ描画 ──
  //   通常は「骨組み表示」ボタンが active のときのみ描画するが、
  //   カメラ映像の非表示（骨組みのみ表示）モード中は、映像が
  //   見えなくなる代わりとして常に骨組みを描画する。
  if (ui.btnOverlay.classList.contains('active') || cameraDisplayState.hideVideo) {
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
