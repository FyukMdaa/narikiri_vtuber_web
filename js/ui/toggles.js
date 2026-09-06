// ──────────────────────────────────────────────────────────────
// toggles.js - 顔追従ズーム / ひねり反映 トグル
//   設定値は localStorage へ永続化。
// ──────────────────────────────────────────────────────────────
import { ui, zoomState, twistState } from 'app/state.js';
import { STORAGE_KEYS } from 'app/config.js';
import {
  _smoothedUpperTwist,
  _smoothedWristSinCos,
} from 'app/utils/temp-objects.js';

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

// ── ひねり反映 ──
export function initTwistToggle() {
  const savedPref = localStorage.getItem(STORAGE_KEYS.twistEnabled);
  if (savedPref === '0') {
    twistState.enabled = false;
    ui.optTwist.checked = false;
  } else {
    twistState.enabled = true;
    ui.optTwist.checked = true;
  }
  updateTwistUI();

  ui.optTwist.addEventListener('change', (e) => {
    twistState.enabled = e.target.checked;
    localStorage.setItem(STORAGE_KEYS.twistEnabled, twistState.enabled ? '1' : '0');
    updateTwistUI();
    if (!twistState.enabled) {
      // ひねりOFF時は即座に smoothing 状態をリセット
      _smoothedUpperTwist.left = 0;
      _smoothedUpperTwist.right = 0;
      _smoothedWristSinCos.left.sin = 0;
      _smoothedWristSinCos.left.cos = 1;
      _smoothedWristSinCos.right.sin = 0;
      _smoothedWristSinCos.right.cos = 1;
    }
  });
}

function updateTwistUI() {
  if (twistState.enabled) ui.twistLabel.classList.add('active');
  else ui.twistLabel.classList.remove('active');
}
