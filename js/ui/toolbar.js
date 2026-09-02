// ──────────────────────────────────────────────────────────────
// toolbar.js - カメラ/オーバーレイボタンのイベント結線
// ──────────────────────────────────────────────────────────────
import { ui } from 'app/state.js';
import { startCamera, stopCamera } from 'app/camera/media-camera.js';
import { cameraState } from 'app/state.js';

export function initToolbar() {
  ui.btnCamera.addEventListener('click', () => {
    if (cameraState.mediaStream) stopCamera();
    else startCamera();
  });

  ui.btnOverlay.addEventListener('click', () => {
    const on = ui.btnOverlay.classList.toggle('active');
    ui.paneCamera.classList.toggle('tracking', on);
  });
}
