// ──────────────────────────────────────────────────────────────
// vrm-input.js - VRMファイル選択ダイアログ
// ──────────────────────────────────────────────────────────────
import { ui, modeState } from 'app/state.js';
import { loadVrm } from 'app/core/vrm-loader.js';
import { backToVrmMode } from 'app/core/inochi-canvas.js';

export function initVrmInput() {
  ui.btnLoadVrm.addEventListener('click', () => ui.vrmInput.click());
  ui.vrmInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Inochi2D モードだったら VRM 側へ戻す
    if (modeState.current === 'inochi') {
      backToVrmMode();
    }
    const url = URL.createObjectURL(file);
    loadVrm(url, file.name);
    ui.vrmInput.value = '';
  });
}
