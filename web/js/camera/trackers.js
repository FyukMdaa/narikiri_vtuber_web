// ──────────────────────────────────────────────────────────────
// trackers.js - MediaPipe (Face / Pose / Hand) の初期化
//   実体は js/tracking/mediapipe-worker.js の Web Worker 内で動作する。
//   本ファイルはメインスレッド側の Worker 管理 + Promise ベース RPC。
// ──────────────────────────────────────────────────────────────
import { cameraState, ui } from 'app/state.js';
import { MEDIAPIPE_ASSETS } from 'app/config.js';

let worker = null;
let nextRequestId = 1;
const pending = new Map(); // id -> { resolve, reject }

function handleWorkerMessage(event) {
  const { type, id } = event.data ?? {};
  const entry = id != null ? pending.get(id) : null;
  if (!entry) return;
  pending.delete(id);
  if (type === 'error') {
    entry.reject(new Error(event.data.error ?? 'mediapipe worker error'));
  } else {
    entry.resolve(event.data);
  }
}

function handleWorkerError(err) {
  console.error('[Tracking] worker error:', err);
  // 保留中のリクエストは全て失敗させ、ループ側に検出失敗として伝播させる
  for (const [id, entry] of pending) {
    entry.reject(err instanceof Error ? err : new Error(String(err?.message ?? err)));
    pending.delete(id);
  }
}

function postToWorker(message, transfer) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ ...message, id }, transfer ?? []);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

// 3つのトラッカーを Worker 内で初期化。失敗時は例外を上層へ伝播。
export async function initTrackers() {
  if (cameraState.trackersReady) return;
  ui.statusTag.textContent = 'トラッキングモデルを読み込み中…';

  try {
    if (!worker) {
      worker = new Worker(new URL('../tracking/mediapipe-worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', handleWorkerMessage);
      worker.addEventListener('error', handleWorkerError);
    }

    await postToWorker({
      type: 'init',
      wasmBase: new URL(MEDIAPIPE_ASSETS.wasmBase, document.baseURI).href,
      models: {
        face: new URL(MEDIAPIPE_ASSETS.models.face, document.baseURI).href,
        pose: new URL(MEDIAPIPE_ASSETS.models.pose, document.baseURI).href,
        hand: new URL(MEDIAPIPE_ASSETS.models.hand, document.baseURI).href,
      },
      delegate: MEDIAPIPE_ASSETS.delegate,
    });

    cameraState.trackersReady = true;
  } catch (err) {
    cameraState.trackersReady = false;
    throw err;
  }
}

// 1フレーム分の検出を Worker に依頼する。
// bitmap の所有権は Worker に転送される（呼び出し側で再利用しないこと）。
export function detectFrame(bitmap, timestamp) {
  if (!worker || !cameraState.trackersReady) {
    bitmap.close?.();
    return Promise.reject(new Error('trackers not ready'));
  }
  return postToWorker({ type: 'detect', bitmap, timestamp }, [bitmap]);
}

// Worker を終了し、全トラッカーを破棄する。
export async function closeTrackers() {
  cameraState.trackersReady = false;
  if (!worker) return;
  try {
    await postToWorker({ type: 'close' });
  } catch {
    // Worker が既に死んでいる等は無視
  } finally {
    worker.removeEventListener('message', handleWorkerMessage);
    worker.removeEventListener('error', handleWorkerError);
    worker.terminate();
    worker = null;
    pending.clear();
  }
}
