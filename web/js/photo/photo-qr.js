// ──────────────────────────────────────────────────────────────
// photo-qr.js - animated-data-qr-js を用いた QR 送信
//
//   写真 Blob を animated QR で送信する。
//   依存ライブラリは web/js/vendor/animated-data-qr/ にビルド時に組み込み済みで、
//   外部 CDN への依存なし（オフライン動作）。
//
//   チューニング:
//     - プリセット (PHOTO_QR_PRESET): compatibility / balanced / throughput / resilient
//     - フレーム間隔 (PHOTO_QR_FRAME_INTERVAL_MS): ms（小さいほど速い）
//   これらは env.js で調整できる。
// ──────────────────────────────────────────────────────────────
import { createQrSender, resolveTransferPreset } from 'animated-data-qr';
import { PHOTO_QR_PRESET, PHOTO_QR_FRAME_INTERVAL_MS } from 'app/env.js';

// QR 送信インスタンスを保持（モーダルの開閉で再利用）
let senderController = null;
let senderMount = null;

// ── QR 送信を開始 ──
export async function startQrTransfer(mount, blob, fileName, options = {}) {
  // 既存のコントローラがあれば破棄
  await stopQrTransfer();

  senderMount = mount;

  // プリセットを取得して env 設定で上書き
  const preset = resolveTransferPreset(options.preset || PHOTO_QR_PRESET || 'balanced');
  const frameIntervalMs = options.frameIntervalMs ?? PHOTO_QR_FRAME_INTERVAL_MS ?? 80;

  // マウント内をクリア
  mount.innerHTML = '';

  senderController = createQrSender(mount, {
    frameIntervalMs,
    chunkByteSize: preset.chunkByteSize,
    payloadEncoding: preset.payloadEncoding,
    symbolsPerFrame: preset.symbolsPerFrame,
    parityBlockDataChunks: preset.parityBlockDataChunks,
    qrOptions: preset.qrOptions,
  });

  // Blob をロード → 最初のフレームを描画 → 自動送信開始
  const summary = await senderController.loadBlob(blob, {
    fileName: fileName || 'photo.jpg',
    mimeType: blob.type || 'image/jpeg',
  });

  if (options.onPrepared) options.onPrepared(summary);

  // 自動送信を開始
  await senderController.start();
  if (options.onStart) options.onStart(summary);

  return summary;
}

// ── QR 送信を停止（リソース解放）──
export async function stopQrTransfer() {
  if (senderController) {
    try {
      senderController.stop();
      senderController.clear();
      senderController.destroy();
    } catch (e) {
      console.warn('[photo-qr] destroy failed:', e);
    }
    senderController = null;
  }
  if (senderMount) {
    senderMount.innerHTML = '';
    senderMount = null;
  }
}

// ── 一時停止（破棄せず送信だけ止める）──
export function pauseQrTransfer() {
  if (senderController) {
    senderController.stop();
  }
}

// ── 再開 ──
export async function resumeQrTransfer() {
  if (senderController) {
    await senderController.start();
  }
}

// ── 現在の送信状態を取得 ──
export function getQrState() {
  if (!senderController) return null;
  return senderController.getState();
}
