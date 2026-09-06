// ──────────────────────────────────────────────────────────────
// config.js - 全チューニング定数・固定マッピング
//   行動調整用のパラメータを一元管理。実行時には変更しない前提。
// ──────────────────────────────────────────────────────────────

// 全体トラッキングのチューニング
export const TUNING = {
  mirrorLR: true,
  headFlip: { x: 1, y: -1, z: -1 },
  smoothing: 0.4,
  visibilityThreshold: 0.5,
  armVisibilityThreshold: 0.35,
  restSmoothing: 0.12,

  // ── 指 ──
  fingerSmoothing: 0.22,           // 0.35→0.22: 指のスムージングを強化（荒れ防止）
  fingerDeadZone: 0.32,            // 0.25→0.32: 指のデッドゾーン拡大（微小入力を無視）
  thumbGain: 1.5,                  // 親指の感度倍率（1.5倍敏感に。鈍ければ 1.8〜2.0 に）
  thumbDeadZone: 0.15,             // 親指専用のデッドゾーン（他指より緩くして反応しやすく）
  handSmoothing: 0.25,
  handVisibilityThreshold: 0.5,

  // ── ひねり（twist）関連 ──
  upperArmTwistScale: 0.8,         // 肩のひねりの適用倍率
  upperArmTwistMax: Math.PI * 0.6, // 肩のひねりの最大角度
  upperArmTwistSmoothing: 0.18,    // 肩のひねりのスムージング
  upperArmTwistDeadZone: 0.12,     // 上腕のひねりのデッドゾーン（0付近の微小値を無視）
  wristTwistScale: 1.0,            // 手首のひねりの適用倍率
  wristTwistMax: Math.PI,           // 手首は約180°回転するので最大をπに
  // upperArmTwistSmoothing と同じ値にする：肩ひねりの誤差を前腕ひねりが補正する
  // 構造上、両者の追従速度が一致していると手掌の向きが最も安定する
  wristTwistSmoothing: 0.8,         // 手首のひねりのスムージング（sin/cos平滑用）
  wristTwistDeadZone: 0.06,         // 手首のひねりのデッドゾーン

  // ── 腕の奥行き強化 ──
  armDepthEnhance: 0.5,            // 0.65→0.5: 短縮法ブレンドを弱めて劇めり込み防止
  armLengthRatio: 0.85,            // 上腕/前腕長の肩幅に対する比
  armDepthScale: 0.85,             // 1.25→0.85: z増幅率を下げて奥行き過走を防止
  armDepthSign: 1,                 // 奥行き方向の符号 (1 or -1)
  armDepthMaxRatio: 0.45,          // 深度マグニチュードの上限（肩幅×この値）

  // ── 手首の角度（掌の屈曲/橈尺屈）──
  wristAngleScale: 0.85,           // 手首角度の適用倍率
  wristAngleSmoothing: 0.18,       // 手首角度のスムージング

  // ── 体の向き（yaw/pitch）──
  bodyYawSign: 1,                  // 体のヨー方向の符号 (1 or -1)
  bodyPitchSign: 1,                 // 体のピッチ方向の符号 (1 or -1)
  spineYawMax: Math.PI / 6,        // 体のヨー最大角度 (~30°)
  spineYawScale: 0.35,             // 首のヨーから体のヨーへの伝達率
  spineYawDeadZone: 0.10,           // 首のヨーのデッドゾーン
  bodyHeadInfluenceScale: 0.15,      // 首のヨーから体のヨーへの影響倍率
  bodyArmTwistInfluenceScale: 0.10, // 肩のひねりから体のヨーへの影響倍率（肩がねじれても体が少し追従）
  spinePitchMax: Math.PI / 8,      // 体のピッチ最大角度 (~22.5°)
  spinePitchScale: 0.6,             // 体のピッチ適用倍率
  spineBodySmoothing: 0.10,        // 体の向きのスムージング
};

// 手追従の機能フラグ
export const HAND_TUNING = {
  enableFingers: true,
  enableHandOrientation: false,
};

// 瞬目のチューニング
export const BLINK_TUNING = {
  curve: 1.3,
  amplification: 2.5,
  threshold: 0.70,
  maxBlink: 0.88,  // まぶたの最大閉じ度。1.0=全閉。まつ毛が顔に埋まるのを防ぐ
};

// 笑顔（happy）のチューニング（まつ毛対策）
export const HAPPY_TUNING = {
  // happy の上限値。多くのモデルの joy モーフは目閉じを含み、かつ笑うと瞬目スコアも
  // 上がるため、blink + happy の目閉じモーフ影響値が合算（three-vrm は clamp しない）
  // して 1.0 を超え、まつ毛が顔に埋まる。happy 側を上限で丸め、目閉じ分は blink 側の
  // 予算から差し引くことで合計が maxBlink 以下に収まる（face.js の applyExpressions 参照）
  maxHappy: 0.85,
};

// 頭部回転の最大角度（rad）
export const HEAD_LIMIT = {
  pitch: 0.45,
  yaw:   0.70,
  roll:  0.30,
};

// 視線トラッキング用の iris ランドマークインデックス
export const IRIS = {
  leftCenter: 468,
  rightCenter: 473,
  leftInner: 133,  leftOuter: 33,
  rightInner: 362, rightOuter: 263,
  leftUpper: 159,   leftLower: 145,
  rightUpper: 386, rightLower: 374,
};

export const IRIS_MAX_ANGLE = 0.30;
export const IRIS_SMOOTHING = 0.18;

// カメラズームの範囲
export const SKELETON_ZOOM = {
  minShoulderWidth: 0.12,
  maxShoulderWidth: 0.50,
  minZoom: 0.7,
  maxZoom: 1.3,
};

export const ZOOM_SMOOTHING = 0.08;
export const CAMERA_LERP = 0.05;
export const REST_ARM_OPEN = 0.25;

// 指のカール軸周りの最大角度
export const FINGER_MAX_ANGLE = {
  proximal: Math.PI * 0.70,
  intermediate: Math.PI * 0.95,
  distal: Math.PI * 0.80,
};

// 各指のボーン名候補とランドマーク列
export const FINGER_MAP = {
  thumb:  { candidates: [['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], ['ThumbProximal', 'ThumbIntermediate', 'ThumbDistal']], lm: [1, 2, 3, 4] },
  index:  { candidates: [['IndexProximal', 'IndexIntermediate', 'IndexDistal']], lm: [5, 6, 7, 8],       range: [0.30, 0.85] },
  middle: { candidates: [['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal']], lm: [9, 10, 11, 12], range: [0.35, 0.95] },
  ring:   { candidates: [['RingProximal', 'RingIntermediate', 'RingDistal']], lm: [13, 14, 15, 16],      range: [0.30, 0.90] },
  little: { candidates: [['LittleProximal', 'LittleIntermediate', 'LittleDistal']], lm: [17, 18, 19, 20], range: [0.25, 0.75] },
};
export const FINGER_ENTRIES = Object.entries(FINGER_MAP);

// 親指の回転軸（VRM空間）
export const FINGER_AXIS = {
  thumb: null, // 初期化時に THREE.Vector3 を作成（utils/temp-objects で設定）
};

// localStorage に保存する設定のキー名
export const STORAGE_KEYS = {
  zoomEnabled: 'vtuber_zoom_enabled',
  twistEnabled: 'vtuber_twist_enabled',
  brightness: 'vtuber_brightness',
};
