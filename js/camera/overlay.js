// ──────────────────────────────────────────────────────────────
// overlay.js - オーバーレイキャンバスへの骨組み描画
// ──────────────────────────────────────────────────────────────
import {
  FaceLandmarker,
  PoseLandmarker,
  HandLandmarker,
} from '@mediapipe/tasks-vision';

import { ui } from 'app/state.js';
import { latestLandmarks } from 'app/state.js';

// cover 相当にクロップしたときの表示領域を返す
export function getCoverRect(containerW, containerH, mediaW, mediaH) {
  if (!mediaW || !mediaH) {
    return { offsetX: 0, offsetY: 0, width: containerW, height: containerH };
  }
  const containerRatio = containerW / containerH;
  const mediaRatio = mediaW / mediaH;
  let width, height;
  if (mediaRatio > containerRatio) {
    height = containerH;
    width = containerH * mediaRatio;
  } else {
    width = containerW;
    height = containerW / mediaRatio;
  }
  return {
    offsetX: (containerW - width) / 2,
    offsetY: (containerH - height) / 2,
    width,
    height,
  };
}

// ランドマーク座標 → オーバーレイキャンバス座標へ変換して点を打つ
export function drawDot(x, y, rect, radius, color) {
  const ctx = ui.overlayCtx;
  ctx.beginPath();
  ctx.arc(rect.offsetX + x * rect.width, rect.offsetY + y * rect.height, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// 接続リストに従って線を引く
export function drawConnections(landmarks, connections, rect, color) {
  const ctx = ui.overlayCtx;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const conn of connections) {
    const a = landmarks[conn.start];
    const b = landmarks[conn.end];
    if (!a || !b) continue;
    ctx.moveTo(rect.offsetX + a.x * rect.width, rect.offsetY + a.y * rect.height);
    ctx.lineTo(rect.offsetX + b.x * rect.width, rect.offsetY + b.y * rect.height);
  }
  ctx.stroke();
}

// 1フレーム分のオーバーレイ描画
export function renderOverlay() {
  const ctx = ui.overlayCtx;
  const overlay = ui.overlay;
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const rect = getCoverRect(overlay.width, overlay.height, ui.video.videoWidth, ui.video.videoHeight);

  // ── 顔 ──
  const faceLm = latestLandmarks.face;
  if (faceLm) {
    if (FaceLandmarker.FACE_LANDMARKS_CONTOURS) {
      drawConnections(faceLm, FaceLandmarker.FACE_LANDMARKS_CONTOURS, rect, 'rgba(96, 165, 250, 0.6)');
    }
    for (let i = 0; i < faceLm.length; i += 3) {
      drawDot(faceLm[i].x, faceLm[i].y, rect, 1.5, '#60a5fa');
    }
  }

  // ── ポーズ ──
  const poseLm = latestLandmarks.pose;
  if (poseLm) {
    if (PoseLandmarker.POSE_CONNECTIONS) {
      drawConnections(poseLm, PoseLandmarker.POSE_CONNECTIONS, rect, 'rgba(248, 113, 113, 0.8)');
    }
    for (const p of poseLm) {
      drawDot(p.x, p.y, rect, 3, '#f87171');
    }
  }

  // ── 手 ──
  const hands = latestLandmarks.hands;
  if (hands) {
    for (const hand of hands) {
      const lm = hand.landmarks;
      if (!lm) continue;
      if (HandLandmarker.HAND_CONNECTIONS) {
        drawConnections(lm, HandLandmarker.HAND_CONNECTIONS, rect, 'rgba(250, 204, 21, 0.7)');
      }
      for (const p of lm) {
        drawDot(p.x, p.y, rect, 2.5, '#facc15');
      }
    }
  }
}

// オーバーレイキャンバスのサイズをペインへ合わせる
export function resizeOverlay() {
  const overlay = ui.overlay;
  overlay.width = ui.paneCamera.clientWidth;
  overlay.height = ui.paneCamera.clientHeight;
}
