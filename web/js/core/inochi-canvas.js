// ──────────────────────────────────────────────────────────────
// inochi-canvas.js — Inochi2D 用 WebGL2 キャンバスの管理
//   - Three.js の WebGLRenderer とは「完全に別」の WebGL2 コンテキスト
//   - VRM とは排他的に表示（modeState.current で切替）
//   - animation-loop.js から毎フレーム draw() が呼ばれる
// ──────────────────────────────────────────────────────────────
import { ui, inochiState, modeState } from 'app/state.js';
import { InochiRenderer, normalizeMeshes } from 'app/core/inochi-renderer.js';
import { loadInpFromFile, getRuntime } from 'app/core/inochi-loader.js';
import { buildParamMap, applyLandmarksToInochi } from 'app/tracking/apply-inochi.js';

let inpLoadSerial = 0;

// 初期化: InochiRenderer を構築し、キャンバスを非表示のまま保持
export function initInochiCanvas() {
  if (!ui.inochiCanvas) {
    console.error('[Inochi2D] inochi-canvas not found in DOM');
    return;
  }
  try {
    inochiState.renderer = new InochiRenderer(ui.inochiCanvas);
    inochiState.canvas = ui.inochiCanvas;
    console.info('[Inochi2D] renderer initialized (separate WebGL2 context)');
  } catch (e) {
    console.error('[Inochi2D] renderer init failed:', e);
  }
}

// リサイズ: Three.js のリサイズと同タイミングで呼ばれる
export function resizeInochi() {
  if (!inochiState.renderer) return;
  // レンダラ内部で canvas.clientWidth/Height を見てサイズ調整するので
  // ここでは明示的な処理は不要だが、clear を走らせておく
  inochiState.renderer._resize();
}

// .inp ファイルをロード → モード切替 → phase 1 開始
export async function loadInpFile(file) {
  const loadSerial = ++inpLoadSerial;
  if (!inochiState.renderer) {
    console.error('[Inochi2D] renderer not initialized');
    return;
  }
  if (!inochiState.runtime) {
    // ランタイム未ロードならここで待つ
    inochiState.runtime = await getRuntime();
    inochiState.runtimeAvailable = inochiState.runtime.isAvailable;
  }

  ui.statusTag.textContent = `「${file.name}」を読み込み中…`;
  try {
    // 既存パペットがあれば破棄
    if (inochiState.puppetHandle) {
      inochiState.puppetHandle.dispose();
      inochiState.puppetHandle = null;
    }
    inochiState.renderer.detachPuppet();

    const handle = await loadInpFromFile(file);
    if (loadSerial !== inpLoadSerial) {
      handle?.dispose?.();
      return;
    }
    if (!handle) {
      ui.statusTag.textContent = `「${file.name}」の読込に失敗`;
      return;
    }

    // bbox が無い場合のみ旧 ZIP 形式とみなして normalizeMeshes を呼ぶ
    //   新 TRNSRTS 形式 (v0.8+) では renderer が u_proj で bbox → clip 変換するので不要
    if (!inochiState.runtimeAvailable && handle._raw?.nodes && !handle._raw.bbox) {
      normalizeMeshes(handle._raw);
    }

    // モードを Inochi2D へ切替 (キャンバスを display:block に)
    //   ※ attachPuppet 内で _resize が clientWidth/Height を見るので、
    //      attachPuppet の前に switch しておく必要がある。
    switchMode('inochi');

    inochiState.puppetHandle = handle;
    inochiState.renderer.attachPuppet(handle);

    // パラメータ仕様キャッシュ
    //   ※新形式 (v0.8+) では min/max/defaults が配列。後続処理で
    //   [0] をスカラー値として扱うため、配列のまま保持する。
    const params = handle.getParams();
    const spec = {};
    for (const p of params) {
      spec[p.name] = {
        min: p.min,
        max: p.max,
        default: p.default ?? (Array.isArray(p.defaults) ? p.defaults[0] : p.defaults) ?? (Array.isArray(p.min) ? p.min[0] : p.min) ?? 0,
        axis: p.axis,
        isVec2: p.isVec2,
        bindings: p.bindings || [],
      };
    }
    inochiState.paramSpec = spec;

    // パラメータ名マッチ表を構築
    inochiState.paramMap = buildParamMap(handle);

    // デフォルト値へ初期化
    //   v5: vec2 パラメータは [x, y] 配列で設定する (各軸の default を尊重)
    for (const p of params) {
      const dArr = Array.isArray(p.defaults) ? p.defaults : null;
      if (p.isVec2) {
        const dx = dArr ? (dArr[0] ?? 0) : ((Array.isArray(p.min) ? p.min[0] : p.min) ?? 0);
        const dy = dArr && dArr.length > 1 ? (dArr[1] ?? dx) : dx;
        handle.setParam(p.name, [dx, dy]);
      } else {
        const dv = (dArr ? dArr[0] : p.default) ??
          (Array.isArray(p.min) ? p.min[0] : p.min) ?? 0;
        handle.setParam(p.name, dv);
      }
    }

    const note = inochiState.runtimeAvailable
      ? `「${file.name}」表示中 — WASM backend`
      : `「${file.name}」表示中 — JS fallback (WASM 無し)`;
    ui.statusTag.textContent = note;
    console.info('[Inochi2D] puppet loaded. params=', params.length, 'nodes=', handle.getRenderData().nodes?.length);
  } catch (e) {
    console.error('[Inochi2D] load error:', e);
    ui.statusTag.textContent = `「${file.name}」の読込に失敗: ${e.message}`;
  }
}

// ── モード切替（VRM ↔ Inochi2D）──
export function switchMode(mode) {
  if (mode === modeState.current) return;
  modeState.current = mode;
  if (mode === 'inochi') {
    // Three.js キャンバスを隠し、Inochi2D を表示
    const threeCanvas = document.getElementById('three-canvas');
    if (threeCanvas) threeCanvas.style.display = 'none';
    if (ui.inochiCanvas) ui.inochiCanvas.style.display = 'block';
  } else {
    // Inochi2D を隠し、Three.js を表示
    if (ui.inochiCanvas) ui.inochiCanvas.style.display = 'none';
    const threeCanvas = document.getElementById('three-canvas');
    if (threeCanvas) threeCanvas.style.display = 'block';
  }
}

// 毎フレーム呼ばれる描画フック（animation-loop.js から呼出）
//   ※ カメラ未起動時でも呼吸 / アイドルは動かす。カメラ起動時は
//      detection-loop.js が applyLandmarksToInochi を呼んで頭部/表情/腕を追加適用。
export function drawInochi(deltaSeconds = null) {
  if (modeState.current !== 'inochi') return;
  if (!inochiState.renderer || !inochiState.puppetHandle) return;
  inochiState.renderer.brightness = inochiState.brightness;

  // カメラ未起動 or トラッカー未初期化の場合でも、最低限の
  // 呼吸/アイドルを動かすため applyLandmarksToInochi を呼ぶ。
  //   ※ detection-loop が既に動いている場合は二重呼出になるが、
  //      applyLandmarksToInochi は setParam + update だけなので副作用は無い。
  if (!inochiState._detectionActive) {
    applyLandmarksToInochi(inochiState.puppetHandle, deltaSeconds);
  }

  // WASM バックエンドがある場合は毎フレーム getRenderData を呼んで
  // 変形後メッシュを取り直す（JS フォールバックは内部 _raw を更新するので不要）
  if (inochiState.runtimeAvailable) {
    inochiState.renderer.refreshRenderData();
  }
  inochiState.renderer.render();
}

// detection-loop 側が動作中かを外部から通知するためのフラグ setter
export function setDetectionActive(active) {
  inochiState._detectionActive = !!active;
}

// 開発段階ステータス表示 (UI ボタンではなく内部状態)
export const INOCHI_DEV_PHASE = 'phase 4: bindings + トラッキング連動';

// Inochi2D モードを抜けて VRM へ戻す
export function backToVrmMode() {
  if (inochiState.puppetHandle) {
    inochiState.puppetHandle.dispose();
    inochiState.puppetHandle = null;
  }
  if (inochiState.renderer) inochiState.renderer.detachPuppet();
  switchMode('vrm');
}
