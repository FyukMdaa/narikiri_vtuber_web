// ──────────────────────────────────────────────────────────────
// state.js - 共有ミュータブル状態
//   複数モジュールから参照・更新される状態を一元管理する。
//   import したオブジェクトのプロパティを変更すると全参照者に伝播する。
// ──────────────────────────────────────────────────────────────

// Three.js シーン関連
export const sceneState = {
  currentVrm: null,        // 現在読み込み済みのVRMオブジェクト
  isVrm1: false,           // VRM 1.0 仕様かどうか（座標系の符号反転に使用）
  renderer: null,
  scene: null,
  camera3d: null,
  keyLight: null,
  ambientLight: null,
  grid: null,
  placeholder: null,
  clock: null,
};

// カメラ・トラッカー関連
export const cameraState = {
  mediaStream: null,        // getUserMedia で取得したストリーム
  trackersReady: false,     // MediaPipe 3トラッカーの初期化完了フラグ
  faceLandmarker: null,
  poseLandmarker: null,
  handLandmarker: null,
  detectionLoopId: null,    // requestAnimationFrame の ID
};

// ズーム設定
export const zoomState = {
  enabled: true,
  target: 1.0,
  current: 1.0,
};

// ひねり反映設定
export const twistState = {
  enabled: true,
};

// MediaPipe 検出結果（每フレーム更新）
export const latestLandmarks = {
  face: null,
  pose: null,
  hands: [],
  faceBlendshapes: null,
  headMatrix: null,
};

// FPS 計測用
export const fpsState = {
  lastFrameTime: 0,
  smoothed: 0,
  readoutEl: null,
};

// UI キャッシュ（main.js で初期化）
export const ui = {
  btnCamera: null,
  btnCameraLabel: null,
  btnOverlay: null,
  btnLoadVrm: null,
  vrmInput: null,
  statusTag: null,
  emptyHint: null,
  paneModel: null,
  paneCamera: null,
  brightnessSlider: null,
  brightnessVal: null,
  optZoom: null,
  zoomLabel: null,
  optTwist: null,
  twistLabel: null,
  video: null,
  overlay: null,
  overlayCtx: null,
};

// カメラ枠のフルボディキャッシュ（VRM ロード時に計算）
export const fullBodyState = {
  dist: 3.5,        // 全身が映るカメラ距離
  centerY: 0.9,    // 全身の中心高さ
};
