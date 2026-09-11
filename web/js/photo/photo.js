// ──────────────────────────────────────────────────────────────
// photo.js - フォト機能のファサード
//
//   1. キャプチャ: 各ソース（avatar / camera / skeleton）を取り出し
//   2. 合成: 指定レイアウトで1枚の Canvas へ並べる
//   3. フレーム: 周囲にフレームを描画し env の文字列を記述
//   4. Blob 化: JPEG 圧縮で Blob を返し、QR 送信サイズを大幅削減
//
//   QR 転送用とダウンロード用で別々の Blob を作る:
//     - QR 転送用: JPEG quality 中、最大辺 PHOTO_MAX_DIMENSION に縮小
//     - ダウンロード用: JPEG quality 高、元サイズを維持
// ──────────────────────────────────────────────────────────────
import { captureSources, isCameraActive } from 'app/photo/photo-capture.js';
import { composeHorizontal, composeSingle } from 'app/photo/photo-compose.js';
import { composeWithFrame } from 'app/photo/photo-frame.js';
import { getLayoutById, getDefaultLayoutId, getAvailableLayouts } from 'app/photo/photo-layouts.js';
import {
  PHOTO_FILE_PREFIX,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_DIMENSION,
  PHOTO_TRANSFER_MIME,
  PHOTO_TRANSFER_EXT,
  PHOTO_DOWNLOAD_MIME,
  PHOTO_DOWNLOAD_EXT,
} from 'app/env.js';

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
  const baseName = `${PHOTO_FILE_PREFIX || 'vtuber-photo'}-${stamp}`;

  return {
    canvas: framed,
    // QR 転送用（縮小JPEG）とダウンロード用（高品質）で別々のファイル名
    transferFileName: `${baseName}.${PHOTO_TRANSFER_EXT || 'jpg'}`,
    downloadFileName: `${baseName}.${PHOTO_DOWNLOAD_EXT || 'jpg'}`,
    layoutId: layout.id,
    layoutLabel: layout.label,
    capturedAt: new Date().toISOString(),
  };
}

// ── Canvas を JPEG Blob に変換（転送用：縮小＋中品質）──
export async function canvasToTransferBlob(canvas) {
  const downscaled = downscaleIfNeeded(canvas, PHOTO_MAX_DIMENSION || 720);
  return await canvasToBlob(downscaled, PHOTO_TRANSFER_MIME || 'image/jpeg', PHOTO_JPEG_QUALITY ?? 0.72);
}

// ── Canvas を JPEG Blob に変換（ダウンロード用：元サイズ＋高品質）──
export async function canvasToDownloadBlob(canvas) {
  const quality = PHOTO_DOWNLOAD_MIME === 'image/png' ? undefined : 0.92;
  return await canvasToBlob(canvas, PHOTO_DOWNLOAD_MIME || 'image/jpeg', quality);
}

// ── 後方互換: canvasToPngBlob は canvasToDownloadBlob へエイリアス ──
export const canvasToPngBlob = canvasToDownloadBlob;

// ── 内部: Canvas → Blob ──
function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    const opts = { type: mimeType };
    if (quality !== undefined) opts.quality = quality;
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas to Blob 変換に失敗しました。'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

// ── 内部: 最大辺サイズに収めてダウンスケール ──
function downscaleIfNeeded(canvas, maxDimension) {
  const w = canvas.width;
  const h = canvas.height;
  const longest = Math.max(w, h);
  if (longest <= maxDimension) return canvas;

  const scale = maxDimension / longest;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = document.createElement('canvas');
  out.width = nw;
  out.height = nh;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, nw, nh);
  return out;
}

// ── タイムスタンプ文字列 ──
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
