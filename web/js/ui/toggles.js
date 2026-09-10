// ──────────────────────────────────────────────────────────────
// toggles.js - 顔追従ズーム / カメラ映像の非表示 トグル
//   設定値は localStorage へ永続化。
//   ※「ひねり反映」は常時ONとなったため、ここのトグルは廃止済み
//     （twistState.enabled は state.js 側で true 固定）。
// ──────────────────────────────────────────────────────────────
import { ui, zoomState, cameraDisplayState } from 'app/state.js';
import { STORAGE_KEYS } from 'app/config.js';

// ── 顔追従ズーム ──
export function initZoomToggle() {
  const savedPref = localStorage.getItem(STORAGE_KEYS.zoomEnabled);
  if (savedPref === '0') {
    zoomState.enabled = false;
    ui.optZoom.checked = false;
  } else {
    zoomState.enabled = true;
    ui.optZoom.checked = true;
  }
  updateZoomUI();

  ui.optZoom.addEventListener('change', (e) => {
    zoomState.enabled = e.target.checked;
    localStorage.setItem(STORAGE_KEYS.zoomEnabled, zoomState.enabled ? '1' : '0');
    updateZoomUI();
    if (!zoomState.enabled) {
      zoomState.target = 1.0;
    }
  });
}

function updateZoomUI() {
  if (zoomState.enabled) ui.zoomLabel.classList.add('active');
  else ui.zoomLabel.classList.remove('active');
}

// ── カメラ映像の非表示（骨組みのみ表示）──
//   自分の顔・姿をあまり見たくない人向けのプライバシーモード。
//   ONの間は <video> を非表示にし、代わりに骨組み（オーバーレイ）の
//   描画を強制的に有効化する（detection-loop.js 側で判定）。
export function initHideCameraToggle() {
  const savedPref = localStorage.getItem(STORAGE_KEYS.hideCameraVideo);
  cameraDisplayState.hideVideo = savedPref === '1';
  ui.optHideCamera.checked = cameraDisplayState.hideVideo;
  updateHideCameraUI();

  ui.optHideCamera.addEventListener('change', (e) => {
    cameraDisplayState.hideVideo = e.target.checked;
    localStorage.setItem(STORAGE_KEYS.hideCameraVideo, cameraDisplayState.hideVideo ? '1' : '0');
    updateHideCameraUI();
  });
}

function updateHideCameraUI() {
  if (cameraDisplayState.hideVideo) {
    ui.hideCameraLabel.classList.add('active');
    ui.paneCamera.classList.add('hide-video');
  } else {
    ui.hideCameraLabel.classList.remove('active');
    ui.paneCamera.classList.remove('hide-video');
  }
}
