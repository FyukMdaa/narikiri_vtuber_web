// ──────────────────────────────────────────────────────────────
// media-camera.js - Webカメラの取得・停止
// ──────────────────────────────────────────────────────────────
import { cameraState, ui } from 'app/state.js';
import { initTrackers } from 'app/camera/trackers.js';
import { runDetectionLoop } from 'app/tracking/detection-loop.js';
import { setDetectionActive } from 'app/core/inochi-canvas.js';

// カメラ起動 → トラッカー初期化 → 検出ループ開始
export async function startCamera() {
  ui.btnCamera.disabled = true;
  ui.statusTag.textContent = 'カメラ起動中…';
  try {
    cameraState.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    ui.video.srcObject = cameraState.mediaStream;
    await ui.video.play();

    ui.emptyHint.style.display = 'none';
    ui.btnCameraLabel.textContent = 'カメラ停止';
    ui.btnCamera.classList.add('active');
    ui.statusTag.innerHTML = '<span class="live">●</span> カメラ取得中';

    await initTrackers();
    ui.btnOverlay.disabled = false;
    ui.statusTag.innerHTML = '<span class="live">●</span> トラッキング中';
    runDetectionLoop();
  } catch (err) {
    console.error(err);
    // カメラ取得後にトラッカー初期化が失敗しても、ストリームと
    // 部分初期化されたトラッカーを確実に破棄して状態を巻き戻す。
    if (cameraState.detectionLoopId) {
      cancelAnimationFrame(cameraState.detectionLoopId);
      cameraState.detectionLoopId = null;
    }
    setDetectionActive(false);
    if (cameraState.mediaStream) {
      cameraState.mediaStream.getTracks().forEach(t => t.stop());
      cameraState.mediaStream = null;
    }
    for (const key of ['faceLandmarker', 'poseLandmarker', 'handLandmarker']) {
      const tracker = cameraState[key];
      if (tracker && typeof tracker.close === 'function') {
        try { tracker.close(); } catch {}
      }
      cameraState[key] = null;
    }
    cameraState.trackersReady = false;
    ui.video.srcObject = null;
    ui.emptyHint.style.display = 'flex';
    ui.btnCameraLabel.textContent = 'カメラ開始';
    ui.btnCamera.classList.remove('active');
    ui.btnOverlay.disabled = true;
    ui.btnOverlay.classList.remove('active');
    ui.paneCamera.classList.remove('tracking');
    ui.statusTag.textContent = 'カメラへのアクセスに失敗しました';
    if (err && err.name === 'NotAllowedError') {
      ui.statusTag.textContent = 'カメラの許可が必要です（ブラウザ設定を確認）';
    }
  } finally {
    ui.btnCamera.disabled = false;
  }
}

// カメラ停止 → 検出ループ中断
export function stopCamera() {
  if (cameraState.detectionLoopId) {
    cancelAnimationFrame(cameraState.detectionLoopId);
    cameraState.detectionLoopId = null;
  }
  // detection-loop が止まったので、Inochi2D 側は自前で呼吸/アイドルを動かすよう通知
  setDetectionActive(false);
  if (cameraState.mediaStream) {
    cameraState.mediaStream.getTracks().forEach(t => t.stop());
    cameraState.mediaStream = null;
  }
  ui.video.srcObject = null;
  ui.emptyHint.style.display = 'flex';
  ui.btnCameraLabel.textContent = 'カメラ開始';
  ui.btnCamera.classList.remove('active');
  ui.btnOverlay.disabled = true;
  ui.btnOverlay.classList.remove('active');
  ui.paneCamera.classList.remove('tracking');
  ui.overlayCtx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
  ui.statusTag.textContent = 'READY';
}
