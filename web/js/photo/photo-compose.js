// ──────────────────────────────────────────────────────────────
// photo-compose.js - レイアウトに従ってソースを合成する
//
//   captureSources() で取得した各キャンバスを、指定レイアウトに従って
//   1 枚の Canvas へ並べる。横並びレイアウトでは各ペインの間に
//   セパレータを描画する。
// ──────────────────────────────────────────────────────────────

const PANE_GAP = 16;             // ペイン間の余白
const PANE_BG = '#111214';       // 各ペインの背景色
const PANE_RADIUS = 12;          // ペインの角丸

// ── 複数ペインを横並びにした Canvas を返す ──
//   panes: HTMLCanvasElement[] （null のものはスキップ）
export function composeHorizontal(panes, paneW, paneH) {
  const validPanes = panes.filter((p) => p !== null && p !== undefined);
  if (validPanes.length === 0) return null;

  const totalW = validPanes.length * paneW + (validPanes.length - 1) * PANE_GAP + PANE_GAP * 2;
  const totalH = paneH + PANE_GAP * 2;

  const out = document.createElement('canvas');
  out.width = totalW;
  out.height = totalH;
  const ctx = out.getContext('2d');

  // 全体背景
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, totalW, totalH);

  // 各ペインを描画
  validPanes.forEach((pane, i) => {
    const x = PANE_GAP + i * (paneW + PANE_GAP);
    const y = PANE_GAP;

    // ペイン背景（角丸）
    drawRoundedRect(ctx, x, y, paneW, paneH, PANE_RADIUS);
    ctx.fillStyle = PANE_BG;
    ctx.fill();

    // ソースを cover 相当で描画
    drawCover(ctx, pane, x, y, paneW, paneH);
  });

  return out;
}

// ── 単一ペインの Canvas を返す ──
export function composeSingle(pane, paneW, paneH) {
  if (!pane) return null;
  const totalW = paneW + PANE_GAP * 2;
  const totalH = paneH + PANE_GAP * 2;

  const out = document.createElement('canvas');
  out.width = totalW;
  out.height = totalH;
  const ctx = out.getContext('2d');

  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, totalW, totalH);

  const x = PANE_GAP;
  const y = PANE_GAP;

  drawRoundedRect(ctx, x, y, paneW, paneH, PANE_RADIUS);
  ctx.fillStyle = PANE_BG;
  ctx.fill();

  drawCover(ctx, pane, x, y, paneW, paneH);
  return out;
}

// ── ヘルパ: 角丸矩形パス ──
function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// ── ヘルパ: cover 描画（クリップ領域内にアスペクト維持で中央配置）──
function drawCover(ctx, srcCanvas, x, y, w, h) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  if (!sw || !sh) return;

  const srcRatio = sw / sh;
  const dstRatio = w / h;
  let dw, dh;
  if (srcRatio > dstRatio) {
    dh = h;
    dw = h * srcRatio;
  } else {
    dw = w;
    dh = w / srcRatio;
  }
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  ctx.save();
  // クリップして角丸内にのみ描画
  drawRoundedRect(ctx, x, y, w, h, PANE_RADIUS);
  ctx.clip();
  ctx.drawImage(srcCanvas, dx, dy, dw, dh);
  ctx.restore();
}
