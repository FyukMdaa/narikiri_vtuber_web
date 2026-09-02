// ──────────────────────────────────────────────────────────────
// temp-objects.js - 毎フレーム確保されるのを避けるための
//   事前割当て済み THREE オブジェクト群。GC 圧力を下げる。
// ──────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { REST_ARM_OPEN } from 'app/config.js';

// ── 汎用一時オブジェクト ──
export const _tmpQuat = new THREE.Quaternion();
export const _qIdentity = new THREE.Quaternion();

// ── 腕（applyArm）計算用 ──
export const _v3defaultDir = new THREE.Vector3();
export const _v3upperDir = new THREE.Vector3();
export const _v3lowerDir = new THREE.Vector3();
export const _v3lowerLocal = new THREE.Vector3();
export const _qUpperTarget = new THREE.Quaternion();
export const _qLowerTarget = new THREE.Quaternion();
export const _qInvUpper = new THREE.Quaternion();

// ── ひねり（twist）計算用 ──
export const _v3upperArmDir = new THREE.Vector3();
export const _v3forearmDirTwist = new THREE.Vector3();
export const _v3forearmPerp = new THREE.Vector3();
export const _v3shoulderLine = new THREE.Vector3();
export const _v3shoulderPerp = new THREE.Vector3();
export const _v3twistCross = new THREE.Vector3();
export const _v3twistAxis = new THREE.Vector3();
export const _qUpperTwist = new THREE.Quaternion();
export const _qLowerTwist = new THREE.Quaternion();
export const _v3wristToIndex = new THREE.Vector3();
export const _v3wristToPinky = new THREE.Vector3();
export const _v3palmNormal = new THREE.Vector3();
export const _v3palmPerp = new THREE.Vector3();
export const _v3palmLocal = new THREE.Vector3();
export const _v3twistRef = new THREE.Vector3();
export const _v3crossTmp2 = new THREE.Vector3();
export const _v3palmRest = new THREE.Vector3();
export const _v3boneAxis = new THREE.Vector3();
export const _qLowerSwingRef = new THREE.Quaternion();

// ひねり角度のスムーズ値（左右別）
export const _smoothedUpperTwist = { left: 0, right: 0 };

// 手首のひねり（回内・回外）のスムージング：sin/cos を別々に平滑してから
// atan2 で再構成する（±πの折返し点をまたいでも値がジャンプしない）
export const _smoothedWristSinCos = {
  left: { sin: 0, cos: 1 },
  right: { sin: 0, cos: 1 },
};

// computeWristTwist が返すひねり角度の信頼度（0〜1）。
// 手首を深く曲げて手掌法線が前腕軸にほぼ平行になると角度が不定になるため、
// 信頼度が低い間は呼び出し側でスムージング更新をホールドする
export let _wristTwistReliability = 0;
export function setWristTwistReliability(v) { _wristTwistReliability = v; }

// ── 手首の角度・腕の奥行き・体の向き 用 ──
export const _v3handDir = new THREE.Vector3();
export const _v3forearmForWrist = new THREE.Vector3();
export const _qLowerArmWorld = new THREE.Quaternion();
export const _qWristFull = new THREE.Quaternion();
export const _qWristSwing = new THREE.Quaternion();
export const _qWristTwistPart = new THREE.Quaternion();
export const _qTwistInv = new THREE.Quaternion();
export const _qWristScaled = new THREE.Quaternion();
export const _qWristTarget = new THREE.Quaternion();

// 体の向き（spine yaw/pitch）用
export const _eulerHips = new THREE.Euler();
export const _qHipsTarget = new THREE.Quaternion();
export let _smoothedSpineYawV = 0;
export let _smoothedSpinePitchV = 0;
export function setSmoothedSpineYaw(v) { _smoothedSpineYawV = v; }
export function setSmoothedSpinePitch(v) { _smoothedSpinePitchV = v; }

// rest の上腕方向（VRM1 / VRM0 で Y の符号が異なる）
export const _restUpperDir = {
  left: new THREE.Vector3(REST_ARM_OPEN, -1, 0.05).normalize(),
  right: new THREE.Vector3(-REST_ARM_OPEN, -1, 0.05).normalize(),
};

export const _restUpperQuat = {
  left: new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    _restUpperDir.left
  ),
  right: new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(-1, 0, 0),
    _restUpperDir.right
  ),
};

export const _restUpperQuatVrm0 = {
  left: new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(REST_ARM_OPEN, 1, 0.05).normalize()
  ),
  right: new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(-REST_ARM_OPEN, 1, 0.05).normalize()
  ),
};

// ── 表情・視線 用 ──
export const _v3IrisCenter = new THREE.Vector3();
export const _qIrisTarget = new THREE.Quaternion();
export const _eulerIris = new THREE.Euler();
export const _m4tmp = new THREE.Matrix4();
export const _eulerTmp = new THREE.Euler();
export const _quatRaw = new THREE.Quaternion();
export const _smoothedGaze = { x: 0, y: 0 };

// ── 頭部 ──
export const _eulerClamp = new THREE.Euler();
export const _eulerHead = new THREE.Euler();

// ── 胴体 ──
export const _eulerSpine = new THREE.Euler();
export const _qSpineTarget = new THREE.Quaternion();

// ── カメラ追従用 ──
export const _camTargetPos = new THREE.Vector3(0, 1.0, 3.5);
export const _camTargetLookAt = new THREE.Vector3(0, 1.0, 0);
export const _camLookAtSmooth = new THREE.Vector3(0, 1.0, 0);
export const _v3headPos = new THREE.Vector3();

// ── 指 ──
export const _fingerQuat = new THREE.Quaternion();
export const _fingerAxis = new THREE.Vector3();
export const _fingerAxisZ = new THREE.Vector3();
export const _deltaQuat = new THREE.Quaternion();
export const _targetQuat = new THREE.Quaternion();

// ── 手の向き ──
export const _v3fingerDir = new THREE.Vector3();
export const _v3spanDir = new THREE.Vector3();
export const _v3normalDir = new THREE.Vector3();
export const _m4hand = new THREE.Matrix4();
export const _qHandRaw = new THREE.Quaternion();

// 親指用の固定軸
import { FINGER_AXIS } from 'app/config.js';
FINGER_AXIS.thumb = new THREE.Vector3(0, 1, 0);
