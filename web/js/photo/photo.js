// ──────────────────────────────────────────────────────────────
// photo.js - フォト機能のファサード
//
//   1. キャプチャ: 各ソース（avatar / camera / skeleton）を取り出し
//   2. 合成: 指定レイアウトで1枚の Canvas へ並べる
//   3. フレーム: 周囲にフレームを描画し env の文字列を記述
//   4. Blob 化: PNG 形式で Blob を返し、QR 送信やダウンロードに使用
// ──────────────────────────────────────────────────────────────
import { captureSources, isCameraActive } from 'app/photo/photo-capture.js';
import { composeHorizontal, composeSingle } from 'app/photo/photo-compose.js';
import { composeWithFrame } from 'app/photo/photo-frame.js';
import { getLayoutById, getDefaultLayoutId, getAvailableLayouts } from 'app/photo/photo-layouts.js';
import { PHOTO_FILE_PREFIX } from 'app/env.js';

// 各ペインのサイズ（合成時）
const PANE_W = 540;
const PANE_H = 540;

// ── キャプチャ + 合成 + フレーム描画まで行い、最終 Canvas を返す ──
export function takePhoto(layoutId) {
  const layout = getLayoutById(layoutId);
  if (!layout) {
    throw new Error(`Unknown layout: ${layoutId}`);
  }

  const sources = captureSources();
  if (!sources.avatar) {
    throw new Error('アバターが読み込まれていません。先に VRM または .inp を読み込んでください。');
  }

  // レイアウトに必要なペインを取得
  const panes = layout.panes.map((key) => sources[key]);
  const hasMultiplePanes = panes.length > 1;

  let composed;
  if (hasMultiplePanes) {
    composed = composeHorizontal(panes, PANE_W, PANE_H);
  } else {
    composed = composeSingle(panes[0], PANE_W, PANE_H);
  }
  if (!composed) {
    throw new Error('レイアウト合成に失敗しました。');
  }

  // フレームを描画
  const framed = composeWithFrame(composed);

  // 写真情報メタデータ
  const stamp = formatTimestamp(new Date());
  const fileName = `${PHOTO_FILE_PREFIX || 'vtuber-photo'}-${stamp}.png`;

  return {
    canvas: framed,
    layoutId: layout.id,
    layoutLabel: layout.label,
    capturedAt: new Date().toISOString(),
    fileName,
  };
}

// ── Canvas を PNG Blob に変換 ──
export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas to Blob 変換に失敗しました。'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

// ── タイムスタンプ文字列 ──
//   ファイル名に使える形式: YYYYMMDD-HHMMSS
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

// ── ユーティリティ: 現在選択可能なレイアウト一覧を取得 ──
export function listAvailableLayouts() {
  return getAvailableLayouts(isCameraActive());
}

// ── ユーティリティ: 現在のデフォルトレイアウトID ──
export function pickDefaultLayoutId() {
  return getDefaultLayoutId(isCameraActive());
}
