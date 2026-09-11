// ──────────────────────────────────────────────────────────────
// photo-ui.js - フォト機能のUIイベント結線
//
//   - ツールバーの撮影ボタン / レイアウトセレクタ
//   - Space キーによる撮影
//   - モーダルウィンドウの表示・閉じる
//   - ダウンロード / 撮り直す / QR 開始・停止
// ──────────────────────────────────────────────────────────────
import { ui, cameraDisplayState } from 'app/state.js';
import { takePhoto, canvasToTransferBlob, canvasToDownloadBlob, listAvailableLayouts, pickDefaultLayoutId } from 'app/photo/photo.js';
import { getLayoutById } from 'app/photo/photo-layouts.js';
import { startQrTransfer, stopQrTransfer, pauseQrTransfer, resumeQrTransfer } from 'app/photo/photo-qr.js';
import { isCameraActive } from 'app/photo/photo-capture.js';
import { PHOTO_QR_FRAME_INTERVAL_MS, PHOTO_QR_PRESET } from 'app/env.js';

// ── 状態 ──
let currentPhoto = null;        // { canvas, transferFileName, downloadFileName, layoutId, layoutLabel, capturedAt }
let currentBlob = null;         // QR 転送用 Blob（JPEG圧縮済み・縮小済み）
let currentDownloadBlob = null; // ダウンロード用 Blob（高品質JPEG）
let currentObjectUrl = null;
let layoutSelectUpdaterBound = false;

// ── DOM参照キャッシュ ──
const dom = {
  btnPhoto: null,
  layoutSelect: null,
  modal: null,
  modalImg: null,
  modalClose: null,
  photoDownload: null,
  photoRetake: null,
  photoMeta: null,
  qrStageMount: null,
  qrStart: null,
  qrStop: null,
  qrStatus: null,
};

// ── 初期化 ──
export function initPhoto() {
  dom.btnPhoto = document.getElementById('btn-photo');
  dom.layoutSelect = document.getElementById('photo-layout-select');
  dom.modal = document.getElementById('photo-modal');
  dom.modalImg = document.getElementById('photo-modal-img');
  dom.modalClose = document.getElementById('photo-modal-close');
  dom.photoDownload = document.getElementById('photo-download');
  dom.photoRetake = document.getElementById('photo-retake');
  dom.photoMeta = document.getElementById('photo-meta');
  dom.qrStageMount = document.getElementById('qr-stage-mount');
  dom.qrStart = document.getElementById('qr-start');
  dom.qrStop = document.getElementById('qr-stop');
  dom.qrStatus = document.getElementById('qr-status');

  // レイアウトセレクタの初期化
  refreshLayoutSelect();

  // イベント結線
  dom.btnPhoto.addEventListener('click', onCaptureClick);
  dom.layoutSelect.addEventListener('change', onLayoutChange);
  dom.modalClose.addEventListener('click', closeModal);
  dom.photoDownload.addEventListener('click', downloadCurrent);
  dom.photoRetake.addEventListener('click', retakePhoto);
  dom.qrStart.addEventListener('click', onQrStart);
  dom.qrStop.addEventListener('click', onQrStop);

  // モーダル外クリックで閉じる
  dom.modal.addEventListener('click', (e) => {
    if (e.target === dom.modal) closeModal();
  });
  // ESC キーで閉じる（<dialog> のデフォルト動作 + 後処理）
  dom.modal.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeModal();
  });

  // Space キーで撮影（input/textarea 中は無視）
  window.addEventListener('keydown', onKeyDown);

  // カメラ表示切替時にレイアウト選択肢を更新
  //   ※ initHideCameraToggle の後に呼ばれる前提だが、念のため少し遅延
  setTimeout(refreshLayoutSelect, 0);
}

// ── レイアウトセレクタの選択肢を現在の状態に合わせて更新 ──
function refreshLayoutSelect() {
  if (!dom.layoutSelect) return;

  // 現在選択中のレイアウトIDを保持
  const prevId = dom.layoutSelect.value;
  const layouts = listAvailableLayouts();
  const cameraActive = isCameraActive();

  // 選択肢を再構築
  dom.layoutSelect.innerHTML = '';
  for (const l of layouts) {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.label;
    dom.layoutSelect.appendChild(opt);
  }

  // 選択状態の復元またはデフォルトへフォールバック
  let nextId = prevId;
  const stillExists = layouts.some((l) => l.id === nextId);
  if (!stillExists) {
    nextId = pickDefaultLayoutId();
  }
  dom.layoutSelect.value = nextId;
}

// ── カメラ表示トグル時にレイアウト選択肢を更新するための外部API ──
export function onCameraDisplayChanged() {
  refreshLayoutSelect();
}

// ── 撮影ボタンクリック ──
function onCaptureClick() {
  captureAndShow();
}

// ── レイアウト変更時 ──
function onLayoutChange() {
  // 即座に反映するだけで、撮影は次回押下時
}

// ── Space キー押下 ──
function onKeyDown(e) {
  if (e.code !== 'Space') return;
  // 入力要素にフォーカス中は無視
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // モーダルが開いている時は無視
  if (dom.modal && dom.modal.open) return;
  e.preventDefault();
  captureAndShow();
}

// ── 撮影 → モーダル表示 ──
async function captureAndShow() {
  const layoutId = dom.layoutSelect.value || pickDefaultLayoutId();

  let photo;
  try {
    photo = takePhoto(layoutId);
  } catch (err) {
    console.error('[photo] capture failed:', err);
    showStatusMessage(err.message || '撮影に失敗しました');
    return;
  }

  currentPhoto = photo;

  // QR 転送用 Blob（縮小＋中品質JPEG）
  let transferBlob;
  // ダウンロード用 Blob（元サイズ＋高品質JPEG）
  let downloadBlob;
  try {
    [transferBlob, downloadBlob] = await Promise.all([
      canvasToTransferBlob(photo.canvas),
      canvasToDownloadBlob(photo.canvas),
    ]);
  } catch (err) {
    console.error('[photo] blob conversion failed:', err);
    showStatusMessage('画像の変換に失敗しました');
    return;
  }
  currentBlob = transferBlob;
  currentDownloadBlob = downloadBlob;

  // 既存の Object URL を破棄
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  // モーダルには転送用を表示（ダウンロードは別URL）
  currentObjectUrl = URL.createObjectURL(transferBlob);

  // QR 転送の見積もり時間
  const estimate = estimateTransferTime(transferBlob.size);

  // モーダルへ表示
  dom.modalImg.src = currentObjectUrl;
  dom.photoMeta.innerHTML = `
    <div>レイアウト: ${escapeHtml(photo.layoutLabel)}</div>
    <div>撮影日時: ${escapeHtml(formatDateTime(photo.capturedAt))}</div>
    <div>送信サイズ: ${escapeHtml(photo.transferFileName)} (${formatBytes(transferBlob.size)})</div>
    <div>送信見積もり: 約 ${estimate.loops}ループ / ${estimate.timeSec}秒 (${PHOTO_QR_PRESET}, ${PHOTO_QR_FRAME_INTERVAL_MS}ms間隔)</div>
    <div>ダウンロード: ${escapeHtml(photo.downloadFileName)} (${formatBytes(downloadBlob.size)})</div>
  `;

  // QR ステータスをリセット
  dom.qrStatus.textContent = '送信準備中…';
  dom.qrStageMount.innerHTML = '<div style="color:#888;font-size:12px;">準備中…</div>';

  // モーダルを開く
  if (typeof dom.modal.showModal === 'function') {
    dom.modal.showModal();
  } else {
    dom.modal.setAttribute('open', '');
  }

  // QR 転送を自動開始
  try {
    dom.qrStatus.textContent = 'QR を生成中…';
    await startQrTransfer(dom.qrStageMount, transferBlob, photo.transferFileName, {
      onPrepared: (summary) => {
        dom.qrStatus.textContent = `送信中 — ${summary.totalChunks}チャンク / ${summary.totalFrames}フレーム (1ループ約${(summary.estimatedStats.loopDurationMs / 1000).toFixed(1)}秒)`;
      },
    });
    dom.qrStatus.textContent = '送信中 — 受信側のカメラで読み取ってください';
  } catch (err) {
    console.error('[photo] QR transfer failed:', err);
    dom.qrStatus.textContent = 'QR 送信の開始に失敗しました: ' + (err.message || err);
  }
}

// ── モーダルを閉じる ──
async function closeModal() {
  // QR 送信を停止
  try {
    await stopQrTransfer();
  } catch (e) {
    console.warn('[photo] stopQrTransfer failed:', e);
  }

  if (typeof dom.modal.close === 'function') {
    dom.modal.close();
  } else {
    dom.modal.removeAttribute('open');
  }
}

// ── ダウンロード ──
function downloadCurrent() {
  if (!currentDownloadBlob || !currentPhoto) return;
  const url = URL.createObjectURL(currentDownloadBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentPhoto.downloadFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 少し待ってから URL を解放（ブラウザによっては即解放でDL失敗）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 撮り直す（モーダルを閉じて再撮影）──
async function retakePhoto() {
  await closeModal();
  // 次フレームで撮影し直す（モーダルが完全に閉じてから）
  requestAnimationFrame(() => captureAndShow());
}

// ── QR 開始（再開）──
async function onQrStart() {
  if (!currentBlob || !currentPhoto) return;
  try {
    dom.qrStatus.textContent = '送信再開中…';
    await startQrTransfer(dom.qrStageMount, currentBlob, currentPhoto.transferFileName);
    dom.qrStatus.textContent = '送信中 — 受信側のカメラで読み取ってください';
  } catch (err) {
    dom.qrStatus.textContent = '再開に失敗: ' + (err.message || err);
  }
}

// ── QR 一時停止 ──
function onQrStop() {
  try {
    pauseQrTransfer();
    dom.qrStatus.textContent = '送信を一時停止しました';
  } catch (err) {
    dom.qrStatus.textContent = '停止に失敗: ' + (err.message || err);
  }
}

// ── ユーティリティ: ステータスバーへ一時メッセージ表示 ──
function showStatusMessage(message) {
  if (ui.statusTag) {
    const prev = ui.statusTag.innerHTML;
    ui.statusTag.textContent = message;
    setTimeout(() => {
      ui.statusTag.innerHTML = prev;
    }, 3000);
  } else {
    alert(message);
  }
}

// ── ユーティリティ: HTML エスケープ ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// ── ユーティリティ: 日付フォーマット ──
function formatDateTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── ユーティリティ: バイトサイズ整形 ──
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── ユーティリティ: 転送時間見積もり ──
//   ファイルサイズから chunk 数と1ループあたりの秒数を概算する。
//   実際の受信完了時間は受信側のカメラfpsに依存するため目安。
function estimateTransferTime(fileSize) {
  // プリセット別の chunkByteSize / symbolsPerFrame / parityBlockDataChunks を反映
  const PRESETS = {
    compatibility: { chunk: 220, symbols: 1, parity: 4 },
    balanced:       { chunk: 384, symbols: 2, parity: 6 },
    throughput:     { chunk: 512, symbols: 4, parity: 0 },
    resilient:      { chunk: 220, symbols: 2, parity: 4 },
  };
  const p = PRESETS[PHOTO_QR_PRESET] || PRESETS.balanced;
  const intervalMs = PHOTO_QR_FRAME_INTERVAL_MS ?? 80;

  const totalChunks = Math.max(1, Math.ceil(fileSize / p.chunk));
  // parity ブロックは parityBlockDataChunks チャンクごとに1つ追加
  const parityChunks = p.parity > 0 ? Math.ceil(totalChunks / p.parity) : 0;
  const totalSymbols = totalChunks + parityChunks + 1; // +1 for manifest
  const totalFrames = Math.ceil(totalSymbols / p.symbols);
  const loopMs = totalFrames * intervalMs;
  const loopSec = loopMs / 1000;

  // 実受信側は 1〜2 ループで完了することが多い。余裕を見て 1.5 倍で見積もり。
  return {
    loops: 1,
    timeSec: loopSec.toFixed(1),
    totalFrames,
    totalChunks,
  };
}
