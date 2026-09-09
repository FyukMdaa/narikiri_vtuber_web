// ──────────────────────────────────────────────────────────────
// brightness.js - 明るさスライダ
//   設定値は localStorage へ永続化。
// ──────────────────────────────────────────────────────────────
import { ui } from 'app/state.js';
import { STORAGE_KEYS } from 'app/config.js';
import { applyBrightness } from 'app/core/animation-loop.js';

export function initBrightness() {
  const min = Number(ui.brightnessSlider.min);
  const max = Number(ui.brightnessSlider.max);
  const fallback = Number(ui.brightnessSlider.value);
  const clamp = (value) => {
    if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 1;
    return Math.min(Number.isFinite(max) ? max : value, Math.max(Number.isFinite(min) ? min : value, value));
  };

  // localStorage は外部から改変可能なので必ず有限値へ検証する。
  const saved = localStorage.getItem(STORAGE_KEYS.brightness);
  const initial = clamp(saved === null ? fallback : Number(saved));
  ui.brightnessSlider.value = String(initial);
  ui.brightnessVal.textContent = initial.toFixed(1);
  applyBrightness(initial);

  ui.brightnessSlider.addEventListener('input', (e) => {
    const val = clamp(Number(e.target.value));
    ui.brightnessSlider.value = String(val);
    ui.brightnessVal.textContent = val.toFixed(1);
    applyBrightness(val);
    localStorage.setItem(STORAGE_KEYS.brightness, val.toString());
  });
}
