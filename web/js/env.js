// ──────────────────────────────────────────────────────────────
// env.js - AUTO-GENERATED 相当（手動編集可）。
//   プロジェクトルートに .env + scripts/inject-env.mjs がある場合は
//   そちらが優先されて上書きされる点に注意。
// ──────────────────────────────────────────────────────────────
export const env = Object.freeze({
  // ── フォトフレーム表示 ──
  PHOTO_FRAME_TEXT: "なりきりVTuber",
  PHOTO_FRAME_SUBTEXT: "Photo Mode",
  PHOTO_FRAME_COLOR: "#3b82f6",
  PHOTO_FILE_PREFIX: "vtuber-photo",

  // ── 画像圧縮（QR 転送向け）──
  // JPEG 品質 (0.0 - 1.0)。0.7 で PNG の 1/5〜1/10 程度に縮む
  PHOTO_JPEG_QUALITY: 0.72,
  // キャプチャ時の最大辺サイズ（px）。これを超えるとアスペクト比を保って縮小
  // 大きすぎると QR のチャンク数が爆発するため、画像送信時は 600〜800px が目安
  PHOTO_MAX_DIMENSION: 720,
  // 送信時の MIME（変更非推奨）
  PHOTO_TRANSFER_MIME: "image/jpeg",
  PHOTO_TRANSFER_EXT: "jpg",
  // ダウンロード用は高品質を維持したい場合は "image/png" に変更可
  PHOTO_DOWNLOAD_MIME: "image/jpeg",
  PHOTO_DOWNLOAD_EXT: "jpg",

  // ── QR 送信チューニング ──
  // プリセット: "compatibility" | "balanced" | "throughput" | "resilient"
  //   compatibility: 220B/chunk, 1 symbol/frame, parity=4, ECC=M（一番遅い）
  //   balanced:       384B/chunk, 2 symbols/frame, parity=6, ECC=M（おすすめ）
  //   throughput:    512B/chunk, 4 symbols/frame, parity=0, ECC=L（速いがエラーに弱い）
  //   resilient:     220B/chunk, 2 symbols/frame, parity=4, ECC=M（エラー回復強い）
  PHOTO_QR_PRESET: "balanced",
  // フレーム間隔 (ms)。プリセットのデフォルトは 250ms。
  // 80ms くらいまで詰めると体感で速くなる（受信側のカメラfps依存）
  PHOTO_QR_FRAME_INTERVAL_MS: 80,
  // 受信側のスキャン間隔 (ms) の目安（送信側からは制御できないが参考値）
  PHOTO_QR_SCAN_INTERVAL_MS_HINT: 80,
});

// 個別 import 用の named export
export const PHOTO_FRAME_TEXT = env.PHOTO_FRAME_TEXT;
export const PHOTO_FRAME_SUBTEXT = env.PHOTO_FRAME_SUBTEXT;
export const PHOTO_FRAME_COLOR = env.PHOTO_FRAME_COLOR;
export const PHOTO_FILE_PREFIX = env.PHOTO_FILE_PREFIX;

export const PHOTO_JPEG_QUALITY = env.PHOTO_JPEG_QUALITY;
export const PHOTO_MAX_DIMENSION = env.PHOTO_MAX_DIMENSION;
export const PHOTO_TRANSFER_MIME = env.PHOTO_TRANSFER_MIME;
export const PHOTO_TRANSFER_EXT = env.PHOTO_TRANSFER_EXT;
export const PHOTO_DOWNLOAD_MIME = env.PHOTO_DOWNLOAD_MIME;
export const PHOTO_DOWNLOAD_EXT = env.PHOTO_DOWNLOAD_EXT;

export const PHOTO_QR_PRESET = env.PHOTO_QR_PRESET;
export const PHOTO_QR_FRAME_INTERVAL_MS = env.PHOTO_QR_FRAME_INTERVAL_MS;
export const PHOTO_QR_SCAN_INTERVAL_MS_HINT = env.PHOTO_QR_SCAN_INTERVAL_MS_HINT;
