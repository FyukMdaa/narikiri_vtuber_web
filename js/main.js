// ──────────────────────────────────────────────────────────────
// main.js - アプリのエントリポイント
//   1. DOM参照を収集
//   2. Three.js シーン初期化
//   3. Inochi2D レンダラ初期化（別 WebGL2 コンテキスト）
//   4. アニメーションループ開始
//   5. UI イベント結線
//   6. リサイズハンドラ登録
// ──────────────────────────────────────────────────────────────
import { ui, fpsState, inochiState, modeState } from 'app/state.js';

import { initScene, resizeThree } from 'app/core/scene.js';
import { animate } from 'app/core/animation-loop.js';
import { initToolbar } from 'app/ui/toolbar.js';
import { initBrightness } from 'app/ui/brightness.js';
import { initZoomToggle, initTwistToggle } from 'app/ui/toggles.js';
import { initVrmInput } from 'app/ui/vrm-input.js';
import { initInpInput } from 'app/ui/inochi-input.js';
import { initInochiCanvas, resizeInochi } from 'app/core/inochi-canvas.js';
import { resizeOverlay } from 'app/camera/overlay.js';

// ── DOM参照を収集 ──
function collectDomRefs() {
  ui.btnCamera       = document.getElementById('btn-camera');
  ui.btnCameraLabel  = document.getElementById('btn-camera-label');
  ui.btnOverlay      = document.getElementById('btn-overlay');
  ui.btnLoadVrm      = document.getElementById('btn-load-vrm');
  ui.vrmInput        = document.getElementById('vrm-input');
  ui.btnLoadInp      = document.getElementById('btn-load-inp');
  ui.inpInput        = document.getElementById('inp-input');
  ui.statusTag       = document.getElementById('status-tag');
  ui.emptyHint       = document.getElementById('camera-empty-hint');
  ui.paneModel       = document.getElementById('pane-model');
  ui.paneCamera      = document.getElementById('pane-camera');
  ui.brightnessSlider = document.getElementById('brightness-slider');
  ui.brightnessVal    = document.getElementById('brightness-val');
  ui.optZoom         = document.getElementById('opt-zoom');
  ui.zoomLabel       = document.getElementById('zoom-label');
  ui.optTwist        = document.getElementById('opt-twist');
  ui.twistLabel      = document.getElementById('twist-label');
  ui.video           = document.getElementById('camera-video');
  ui.overlay         = document.getElementById('overlay-canvas');
  ui.overlayCtx      = ui.overlay.getContext('2d');
  ui.inochiCanvas    = document.getElementById('inochi-canvas');
  fpsState.readoutEl = document.getElementById('fps-readout');
}

// ── リサイズハンドラ（rAF で遅延実行し高頻度呼出を抑制）──
function initResizeHandlers() {
  let rafId = null;
  window.addEventListener('resize', () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      resizeThree();
      resizeInochi();
      resizeOverlay();
    });
  });
  // 初回実行
  resizeOverlay();
}

// ── 起動 ──
async function boot() {
  collectDomRefs();
  initScene();            // Three.js シーン構築
  initInochiCanvas();    // Inochi2D 別 WebGL2 コンテキスト初期化
  initResizeHandlers();  // リサイズ系
  initToolbar();        // カメラ/オーバーレイボタン
  initBrightness();     // 明るさスライダ
  initZoomToggle();     // 顔追従ズーム
  initTwistToggle();    // ひねり反映
  initVrmInput();       // VRM 読込ダイアログ
  initInpInput();       // .inp 読込ダイアログ

  // FPS 計測用のタイムスタンプ初期化
  fpsState.lastFrameTime = performance.now();

  // アニメーションループ開始
  animate();

  // Inochi2D ランタイムをバックグラウンドで事前ロード（WASM があれば拾う）
  import('app/core/inochi-loader.js').then(async ({ getRuntime }) => {
    try {
      inochiState.runtime = await getRuntime();
      inochiState.runtimeAvailable = inochiState.runtime.isAvailable;
      console.info('[Inochi2D] runtime ready, available =', inochiState.runtimeAvailable);
    } catch (e) {
      console.warn('[Inochi2D] runtime init failed:', e);
    }
  });

  console.log('[vtuber-app] booted. modules: 24 files');
}

// DOM が構築済みなら即起動、未構築なら DOMContentLoaded を待つ
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
