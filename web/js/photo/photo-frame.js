// ──────────────────────────────────────────────────────────────
// photo-frame.js - フォトフレーム描画
//
//   合成済み画像の周囲にフレームを描画し、env.js に隔離された文字列を
//   フレーム下部の帯へ記述する。
// ──────────────────────────────────────────────────────────────
import { PHOTO_FRAME_TEXT, PHOTO_FRAME_SUBTEXT, PHOTO_FRAME_COLOR } from 'app/env.js';

// フレームの余白・フォントサイズ等の定数
const FRAME_PADDING = 28;            // 画像外周の余白
const FRAME_BAR_HEIGHT = 64;        // 下部テキスト帯の高さ
const FRAME_BORDER_WIDTH = 4;       // 枠線の太さ
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif`;
const FONT_SIZE_TITLE = 24;
const FONT_SIZE_SUB = 14;

// ── 合成済み画像（Canvas）を受け取ってフレーム付き Canvas を返す ──
export function composeWithFrame(contentCanvas, options = {}) {
  const contentW = contentCanvas.width;
  const contentH = contentCanvas.height;

  const outW = contentW + FRAME_PADDING * 2;
  const outH = contentH + FRAME_PADDING * 2 + FRAME_BAR_HEIGHT;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');

  // フレーム背景（濃色）
  const bgColor = options.backgroundColor || '#1a1b1e';
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, outW, outH);

  // コンテンツ描画
  ctx.drawImage(contentCanvas, FRAME_PADDING, FRAME_PADDING);

  // 枠線
  ctx.strokeStyle = options.accentColor || PHOTO_FRAME_COLOR || '#3b82f6';
  ctx.lineWidth = FRAME_BORDER_WIDTH;
  ctx.strokeRect(
    FRAME_BORDER_WIDTH / 2,
    FRAME_BORDER_WIDTH / 2,
    outW - FRAME_BORDER_WIDTH,
    outH - FRAME_BORDER_WIDTH
  );

  // 下部テキスト帯
  const barTop = FRAME_PADDING + contentH + 8;
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(FRAME_PADDING, barTop, contentW, FRAME_BAR_HEIGHT - 16);

  // メインテキスト（PHOTO_FRAME_TEXT）
  ctx.fillStyle = '#f3f4f6';
  ctx.font = `600 ${FONT_SIZE_TITLE}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(PHOTO_FRAME_TEXT || '', FRAME_PADDING + 16, barTop + (FRAME_BAR_HEIGHT - 16) / 2);

  // サブテキスト（PHOTO_FRAME_SUBTEXT、右寄せ）
  ctx.fillStyle = '#9ca3af';
  ctx.font = `400 ${FONT_SIZE_SUB}px ${FONT_FAMILY}`;
  ctx.textAlign = 'right';
  ctx.fillText(PHOTO_FRAME_SUBTEXT || '', FRAME_PADDING + contentW - 16, barTop + (FRAME_BAR_HEIGHT - 16) / 2);

  return out;
}
