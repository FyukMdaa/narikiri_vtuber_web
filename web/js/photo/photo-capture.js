// ──────────────────────────────────────────────────────────────
// photo-capture.js - フォトキャプチャのコア
//
//   アバター(Three.js or Inochi2D) / カメラ映像 / 骨組み(overlay) の
//   各ソースを 1 枚の Canvas へ合成する。レイアウトは photo-layouts.js
//   で定義した LAYOUTS に従う。
//
//   ※ <video> と overlay は CSS (transform: scaleX(-1)) でミラー表示
//      されているが、ピクセルデータ自体は非ミラー。キャプチャ時に
//      横反転して描画することで表示と同じ見た目にする。
// ──────────────────────────────────────────────────────────────
import { ui, sceneState, inochiState, modeState, cameraDisplayState } from 'app/state.js';
import { renderOverlay, getCoverRect } from 'app/camera/overlay.js';

// 各ソースのキャプチャ解像度（出力サイズの決定に使用）
const SOURCE_TARGET_W = 720;
const SOURCE_TARGET_H = 720;

// ── アバターCanvas の取得 ──
//   Inochi2D モード時は inochi-canvas、それ以外は three-canvas。
function getActiveModelCanvas() {
  if (modeState.current === 'inochi' && inochiState.renderer) {
    return ui.inochiCanvas;
  }
  return document.getElementById('three-canvas');
}

// ── アバターCanvas のピクセルを取り出す ──
//   WebGL の描画バッファは rAF 外で toDataURL すると空になることがあるため、
//   その場合は明示的に再描画してから取り出す。
function captureModelCanvas(targetW, targetH) {
  const src = getActiveModelCanvas();
  if (!src) return null;

  // Three.js モードなら明示的に再描画してバッファを fresh にする
  if (modeState.current !== 'inochi' && sceneState.renderer && sceneState.scene && sceneState.camera3d) {
    try {
      sceneState.renderer.render(sceneState.scene, sceneState.camera3d);
    } catch (e) {
      console.warn('[photo] three.js re-render failed:', e);
    }
  } else if (modeState.current === 'inochi' && inochiState.renderer) {
    try {
      inochiState.renderer.render();
    } catch (e) {
      console.warn('[photo] inochi re-render failed:', e);
    }
  }

  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const ctx = out.getContext('2d');
  // 背景を透明にせず、モデル枠の背景色で塗りつぶす（後のフレーム描画で統一感を出す）
  ctx.fillStyle = '#1a1b1e';
  ctx.fillRect(0, 0, targetW, targetH);

  // ソースのアスペクトを維持しつつ cover 相当で中央配置
  const sw = src.width || src.clientWidth || targetW;
  const sh = src.height || src.clientHeight || targetH;
  const rect = getCoverRect(targetW, targetH, sw, sh);
  ctx.drawImage(src, rect.offsetX, rect.offsetY, rect.width, rect.height);
  return out;
}

// ── カメラ映像をキャプチャ ──
//   <video> は生の（非ミラー）ピクセルを持つため、キャプチャ時に
//   横反転して描画する。
function captureCameraFrame(targetW, targetH) {
  if (!ui.video || !ui.video.videoWidth) return null;
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const ctx = out.getContext('2d');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, targetW, targetH);

  // video を cover 相当で描画
  const rect = getCoverRect(targetW, targetH, ui.video.videoWidth, ui.video.videoHeight);
  ctx.save();
  // CSS の scaleX(-1) と同じミラー効果
  ctx.translate(targetW, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(ui.video, targetW - rect.offsetX - rect.width, rect.offsetY, rect.width, rect.height);
  ctx.restore();
  return out;
}

// ── 骨組み（オーバーレイ）をキャプチャ ──
//   通常の overlay は video の上に重ねて表示され、CSS で scaleX(-1) されている。
//   骨組みだけを 1 枚の画像として取り出す場合は、明示的に最新の描画を
//   行った上で左右反転して取り出す。
function captureSkeletonFrame(targetW, targetH, withCameraBg = false) {
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const ctx = out.getContext('2d');

  if (withCameraBg && ui.video && ui.video.videoWidth) {
    // カメラ映像を背景にする（ミラー反転）
    const rect = getCoverRect(targetW, targetH, ui.video.videoWidth, ui.video.videoHeight);
    ctx.save();
    ctx.translate(targetW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(ui.video, targetW - rect.offsetX - rect.width, rect.offsetY, rect.width, rect.height);
    ctx.restore();
  } else {
    ctx.fillStyle = '#111214';
    ctx.fillRect(0, 0, targetW, targetH);
  }

  // overlay の現在の内容を取り出すため、一旦ピクセルをコピー
  //   ※ renderOverlay() は CSS 反転前の座標系で描画しているので、
  //      キャプチャ時にも反転して描画する必要がある。
  const overlay = ui.overlay;
  if (overlay && overlay.width > 0) {
    // 最新状態に更新（映像非表示モードでも renderOverlay が走るようになっている）
    try {
      renderOverlay();
    } catch (e) {
      console.warn('[photo] renderOverlay failed:', e);
    }

    // overlay は pane-camera と同じサイズ。targetW×targetH へスケール＆ミラー
    ctx.save();
    ctx.translate(targetW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, 0, 0, targetW, targetH);
    ctx.restore();
  }

  return out;
}

// ── 各ソースのキャプチャをまとめて取得 ──
export function captureSources() {
  const modelCanvas = captureModelCanvas(SOURCE_TARGET_W, SOURCE_TARGET_H);
  const cameraCanvas = captureCameraFrame(SOURCE_TARGET_W, SOURCE_TARGET_H);
  const skeletonOnlyCanvas = captureSkeletonFrame(SOURCE_TARGET_W, SOURCE_TARGET_H, false);
  const cameraWithSkeletonCanvas = captureSkeletonFrame(SOURCE_TARGET_W, SOURCE_TARGET_H, true);

  return {
    avatar: modelCanvas,
    camera: cameraCanvas,
    skeleton: skeletonOnlyCanvas,
    cameraWithSkeleton: cameraWithSkeletonCanvas,
  };
}

// ── カメラが有効かどうか ──
//   映像非表示モード中はカメラ映像自体は流れているが、ユーザー体験上は
//   「カメラOFF」と同様に扱うべき。
export function isCameraActive() {
  return !!cameraDisplayState.hideVideo === false && !!ui.video && ui.video.videoWidth > 0;
}
