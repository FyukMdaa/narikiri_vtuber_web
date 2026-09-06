// ──────────────────────────────────────────────────────────────
// face.js - 顔系トラッキング
//   - 表情（blink / aa / happy）
//   - 視線（iris gaze）
//   - 頭部回転（pitch / yaw / roll with limits）
// ──────────────────────────────────────────────────────────────
import * as THREE from 'three';

import { sceneState } from 'app/state.js';
import {
  BLINK_TUNING,
  HAPPY_TUNING,
  IRIS,
  IRIS_MAX_ANGLE,
  IRIS_SMOOTHING,
  HEAD_LIMIT,
  TUNING,
} from 'app/config.js';
import {
  _v3IrisCenter,
  _qIrisTarget,
  _eulerIris,
  _m4tmp,
  _eulerTmp,
  _quatRaw,
  _smoothedGaze,
  _eulerClamp,
  _eulerHead,
  _tmpQuat,
} from 'app/utils/temp-objects.js';
import { getBone } from 'app/core/vrm-loader.js';

// 瞬目値の処理：カーブ → 増幅 → スナップ → 上限キャップ
export function processBlink(raw) {
  const curved = Math.pow(raw, BLINK_TUNING.curve);
  const amplified = Math.min(curved * BLINK_TUNING.amplification, 1.0);
  const snapped = amplified >= BLINK_TUNING.threshold ? 1.0 : amplified;
  return Math.min(snapped, BLINK_TUNING.maxBlink);
}

// VRM の expression に blendshapes を反映
export function applyExpressions(vrm, blendshapes) {
  if (!blendshapes || !vrm.expressionManager) return;
  const score = (name) => blendshapes.find(c => c.categoryName === name)?.score ?? 0;
  const em = vrm.expressionManager;

  // 笑顔（happy）。多くのモデルの joy モーフは目閉じを含むため、happy だけでも目が閉じる。
  // さらに笑顔では瞬目スコアも上がり、three-vrm は同一モーフへの影響値を clamp せず合算
  // する（VRM0 は overrideBlink も効かない）ため、blink + happy で目閉じが 1.0 を超え、
  // まつ毛が顔に埋まる。→ happy を maxHappy で丸め、残りの目閉じ予算を blink 側に配分
  // して、合計の目閉じ度が常に maxBlink 以下になるようにする。
  const happy = Math.min(
    Math.max(score('mouthSmileLeft'), score('mouthSmileRight')),
    HAPPY_TUNING.maxHappy,
  );
  const blinkBudget = Math.max(0, BLINK_TUNING.maxBlink - happy);

  // カメラはミラー表示。VRM 側の目はユーザと同じ側（左目=カメラ映像の右目）
  em.setValue('blinkLeft',  Math.min(processBlink(score('eyeBlinkRight')), blinkBudget));
  em.setValue('blinkRight', Math.min(processBlink(score('eyeBlinkLeft')),  blinkBudget));
  em.setValue('aa', score('jawOpen'));
  em.setValue('happy', happy);
}

// 視線方向を iris 位置から計算（左右個別）
function computeIrisGaze(lm, side) {
  const isLeft = side === 'left';
  const innerIdx = isLeft ? IRIS.leftInner : IRIS.rightInner;
  const outerIdx = isLeft ? IRIS.leftOuter : IRIS.rightOuter;
  const upperIdx = isLeft ? IRIS.leftUpper : IRIS.rightUpper;
  const lowerIdx = isLeft ? IRIS.leftLower : IRIS.rightLower;
  const irisIdx = isLeft ? IRIS.leftCenter : IRIS.rightCenter;

  const inner = lm[innerIdx];
  const outer = lm[outerIdx];
  const upper = lm[upperIdx];
  const lower = lm[lowerIdx];
  const iris = lm[irisIdx];
  if (!inner || !outer || !upper || !lower || !iris) return null;

  const eyeCenterX = (inner.x + outer.x) / 2;
  const eyeCenterY = (upper.y + lower.y) / 2;
  const eyeWidth = Math.abs(outer.x - inner.x);
  const eyeHeight = Math.abs(lower.y - upper.y);
  if (eyeWidth < 1e-6 || eyeHeight < 1e-6) return null;

  let relX = (iris.x - eyeCenterX) / (eyeWidth / 2);
  let relY = (iris.y - eyeCenterY) / (eyeHeight / 2);
  if (Math.abs(relX) < 0.08) relX = 0;
  if (Math.abs(relY) < 0.08) relY = 0;
  relX = Math.max(-1, Math.min(1, relX));
  relY = Math.max(-1, Math.min(1, relY));
  return { x: relX, y: relY };
}

// VRM の左右眼球ボーンへ視線回転を適用
export function applyEyeGaze(vrm, faceLm, headMatrix) {
  if (!faceLm || faceLm.length < 478) return;

  // 頭部ロールで水平方向の視線を減衰（首を傾けるとき視線は動かない）
  let headRoll = 0;
  if (headMatrix) {
    _quatRaw.setFromRotationMatrix(_m4tmp.fromArray(headMatrix));
    _eulerTmp.setFromQuaternion(_quatRaw, 'XYZ');
    headRoll = _eulerTmp.z;
  }

  const leftGaze = computeIrisGaze(faceLm, 'left');
  const rightGaze = computeIrisGaze(faceLm, 'right');

  let rawX = 0, rawY = 0;
  let validCount = 0;
  if (leftGaze)  { rawX += leftGaze.x;  rawY += leftGaze.y;  validCount++; }
  if (rightGaze) { rawX += rightGaze.x; rawY += rightGaze.y; validCount++; }
  if (validCount === 0) return;
  rawX /= validCount;
  rawY /= validCount;
  rawX = -rawX;  // ミラー

  const rollDamping = Math.max(0.0, 1.0 - Math.abs(headRoll) * 3.0);
  rawX *= rollDamping;
  rawY *= rollDamping;

  const gazeLerp = 0.15;
  _smoothedGaze.x += (rawX - _smoothedGaze.x) * gazeLerp;
  _smoothedGaze.y += (rawY - _smoothedGaze.y) * gazeLerp;

  const gx = Math.max(-1, Math.min(1, _smoothedGaze.x));
  const gy = Math.max(-1, Math.min(1, _smoothedGaze.y));

  const pitch = -gy * IRIS_MAX_ANGLE;
  const yaw = gx * IRIS_MAX_ANGLE;
  _eulerIris.set(pitch, yaw, 0, 'XYZ');
  _qIrisTarget.setFromEuler(_eulerIris);

  const leftEyeBone = getBone(vrm, 'leftEye');
  const rightEyeBone = getBone(vrm, 'rightEye');
  if (leftEyeBone)  leftEyeBone.quaternion.slerp(_qIrisTarget, IRIS_SMOOTHING);
  if (rightEyeBone) rightEyeBone.quaternion.slerp(_qIrisTarget, IRIS_SMOOTHING);
}

// 頭部回転を headMatrix から計算してVRMへ適用
export function applyHeadRotation(vrm, matrixData) {
  const head = getBone(vrm, 'head');
  if (!head || !matrixData) return;

  _m4tmp.fromArray(matrixData);
  _tmpQuat.setFromRotationMatrix(_m4tmp);
  _eulerHead.setFromQuaternion(_tmpQuat, 'YXZ');

  let pitch = _eulerHead.x;
  let yaw   = _eulerHead.y;
  let roll  = _eulerHead.z;

  // VRM1 と VRM0 で座標系の符号が異なる
  if (sceneState.isVrm1) {
    yaw  *= -1;
    roll *= -1;
  } else {
    pitch *= -1;
    yaw   *= -1;
    roll  *= 1;
  }

  _eulerClamp.set(pitch, yaw, roll, 'YXZ');
  _eulerClamp.x = Math.max(-HEAD_LIMIT.pitch, Math.min(HEAD_LIMIT.pitch, _eulerClamp.x));
  _eulerClamp.y = Math.max(-HEAD_LIMIT.yaw,   Math.min(HEAD_LIMIT.yaw,   _eulerClamp.y));
  _eulerClamp.z = Math.max(-HEAD_LIMIT.roll,  Math.min(HEAD_LIMIT.roll,  _eulerClamp.z));

  _tmpQuat.setFromEuler(_eulerClamp);
  head.quaternion.slerp(_tmpQuat, TUNING.smoothing);
}
