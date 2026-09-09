// ──────────────────────────────────────────────────────────────
// inochi-input.js — Inochi2D のファイル読込 UI 結線
// ──────────────────────────────────────────────────────────────
import { ui } from 'app/state.js';

// .inp 読込ダイアログ
export function initInpInput() {
  if (!ui.btnLoadInp || !ui.inpInput) return;
  ui.btnLoadInp.addEventListener('click', () => ui.inpInput.click());
  ui.inpInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // 動的 import: 循環参照を避けるため、使用時に入手
    const { loadInpFile } = await import('app/core/inochi-canvas.js');
    await loadInpFile(file);
    ui.inpInput.value = '';
  });
}
