// ──────────────────────────────────────────────────────────────
// photo-qr.js - animated-data-qr-js を用いた QR 送信
//
//   写真 PNG Blob を animated QR で送信する。
//   依存ライブラリは web/js/vendor/animated-data-qr/ にビルド時に組み込み済みで、
//   外部 CDN への依存なし（オフライン動作）。
// ──────────────────────────────────────────────────────────────
import { createQrSender, resolveTransferPreset } from 'animated-data-qr';

// QR 送信インスタンスを保持（モーダルの開閉で再利用）
let senderController = null;
let senderMount = null;

// ── QR 送信を開始 ──
//   mount: HTMLDivElement（QR を描画するコンテナ）
//   blob: 送信する Blob (PNG 等)
//   fileName: 受信側での保存名
//   onProgress: フレーム送信時に呼ばれるコールバック（省略可）
export async function startQrTransfer(mount, blob, fileName, options = {}) {
  // 既存のコントローラがあれば破棄
  await stopQrTransfer();

  senderMount = mount;

  // プリセット: 互換性重視（受信側の環境に依存しにくい）
  const preset = resolveTransferPreset(options.preset || 'compatibility');

  // マウント内をクリア
  mount.innerHTML = '';

  senderController = createQrSender(mount, {
    frameIntervalMs: preset.frameIntervalMs,
    chunkByteSize: preset.chunkByteSize,
    payloadEncoding: preset.payloadEncoding,
    symbolsPerFrame: preset.symbolsPerFrame,
    parityBlockDataChunks: preset.parityBlockDataChunks,
    qrOptions: { errorCorrectionLevel: 'M' },
  });

  // Blob をロード → 最初のフレームを描画 → 自動送信開始
  const summary = await senderController.loadBlob(blob, {
    fileName: fileName || 'photo.png',
    mimeType: blob.type || 'image/png',
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
