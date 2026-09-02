// ──────────────────────────────────────────────────────────────
// brightness.js - 明るさスライダ
//   設定値は localStorage へ永続化。
// ──────────────────────────────────────────────────────────────
import { ui } from 'app/state.js';
import { STORAGE_KEYS } from 'app/config.js';
import { applyBrightness } from 'app/core/animation-loop.js';

export function initBrightness() {
  // 保存値があれば復元
  const saved = localStorage.getItem(STORAGE_KEYS.brightness);
  if (saved !== null) {
    ui.brightnessSlider.value = saved;
    ui.brightnessVal.textContent = parseFloat(saved).toFixed(1);
    applyBrightness(parseFloat(saved));
  }

  ui.brightnessSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    ui.brightnessVal.textContent = val.toFixed(1);
    applyBrightness(val);
    localStorage.setItem(STORAGE_KEYS.brightness, val.toString());
  });
}
