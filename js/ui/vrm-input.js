// ──────────────────────────────────────────────────────────────
// vrm-input.js - VRMファイル選択ダイアログ
// ──────────────────────────────────────────────────────────────
import { ui } from 'app/state.js';
import { loadVrm } from 'app/core/vrm-loader.js';

export function initVrmInput() {
  ui.btnLoadVrm.addEventListener('click', () => ui.vrmInput.click());
  ui.vrmInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    loadVrm(url, file.name);
    ui.vrmInput.value = '';
  });
}
