// ──────────────────────────────────────────────────────────────
// arms.js - 腕トラッキング
//   - 上腕・前腕の方向をVRMへ適用
//   - 上腕のひねり（内旋・外旋）
//   - 手首の角度（掌の屈曲/橈尺屈）
// ──────────────────────────────────────────────────────────────
import { sceneState, twistState } from 'app/state.js';
import { TUNING } from 'app/config.js';
import {
  _tmpQuat,
  _v3defaultDir,
  _v3upperDir,
  _v3lowerDir,
  _v3lowerLocal,
  _qUpperTarget,
  _qLowerTarget,
  _qInvUpper,
  _qIdentity,
  _v3twistAxis,
  _qUpperTwist,
  _qLowerTwist,
  _v3handDir,
  _v3forearmForWrist,
  _qLowerArmWorld,
  _qWristFull,
  _qWristSwing,
  _qWristScaled,
  _qWristTarget,
  _qTwistInv,
  _qSceneRotYInv,
  _restUpperQuat,
  _restUpperQuatVrm0,
  _smoothedUpperTwist,
  _smoothedWristSinCos,
  _wristTwistReliability,
} from 'app/utils/temp-objects.js';
import {
  mpToVrmDir,
  isArmLandmarkVisible,
  enhanceArmDepth,
  computeUpperArmTwist,
  decayWristTwistState,
} from 'app/utils/math.js';
import { getBone } from 'app/core/vrm-loader.js';
import { computeWristTwist } from 'app/tracking/wrist.js';

// ── 手首の角度（掌の屈曲/橈尺屈）を適用 ──
// 前腕方向(肘→手首)から手の方向(手首→中指MCP)への回転を計算し、
// 前腕軸まわりの成分(twist=回内/回外, 既にlowerArmに適用済み)を除いた
// swing成分のみを hand ボーンに適用する。
export function applyWristAngle(vrm, elbow, wristPose, handLm, side, handBone) {
  if (!handBone || !handLm || handLm.length < 21) return;
  if (!isArmLandmarkVisible(elbow) || !isArmLandmarkVisible(wristPose)) return;

  const handWrist = handLm[0];
  const middleMcp = handLm[9];
  if (!handWrist || !middleMcp) return;

  // lowerArmボーンの世界クォータニオンを取得（手ボーンはlowerArmのローカルフレームにいる）
  const lowerArmBone = getBone(vrm, side === 'left' ? 'leftLowerArm' : 'rightLowerArm');
  if (!lowerArmBone) return;
  lowerArmBone.getWorldQuaternion(_qLowerArmWorld);
  // VRM0.x では vrm.scene 自体に π のY回転が掛かっている（vrm-loader.js の座標合わせ）。
  // getWorldQuaternion にはこのシーン回転が含まれるが、手の方向変換（mpToVrmDir ＋
  // VRM0のy反転）は正規化ボーンのローカル基準フレームで行っているため、シーン回転が
  // 混入すると手方向のX成分（左右）とZ成分（前後）が反転し、手首の左右角が逆になる。
  // そこで VRM0 のときだけシーン回転を打ち消してから逆クォータニオンを作る。
  // （VRM1 はシーン回転ゼロなので影響なし）
  if (!sceneState.isVrm1) _qLowerArmWorld.premultiply(_qSceneRotYInv);
  _qTwistInv.copy(_qLowerArmWorld).invert();

  // 手の方向（VRM世界座標系）: 手首 → 中指MCP
  _v3forearmForWrist.set(
    -(middleMcp.x - handWrist.x),
    -(middleMcp.y - handWrist.y),
    -(middleMcp.z - handWrist.z)
  );
  if (_v3forearmForWrist.lengthSq() < 1e-10) return;
  _v3forearmForWrist.normalize();
  if (!sceneState.isVrm1) _v3forearmForWrist.y *= -1;

  // lowerArmのローカルフレームに変換
  // 世界空間の回転を手ボーンに直接適用すると、腕の向きによって曲がり方が不正確になる。
  // lowerArmのローカルフレームで方向を計算することで、正確に手首の角度だけを反映する。
  _v3handDir.copy(_v3forearmForWrist).applyQuaternion(_qTwistInv);

  // restQuatの逆クォータニオン
  const restQuat = handBone.userData.restQuat || _qIdentity;
  _qWristSwing.copy(restQuat).invert();

  // ボーンのrestフレームでの手の方向（restQuatを除外した純粋な手首の曲げ）
  _v3handDir.applyQuaternion(_qWristSwing);

  // rest方向（左右で符号が異なる：VRMのleftHandは+X、rightHandは-Xがデフォルト方向）
  const handSign = side === 'left' ? 1 : -1;
  _v3defaultDir.set(handSign, 0, 0);
  _qWristFull.setFromUnitVectors(_v3defaultDir, _v3handDir);
  if (isNaN(_qWristFull.x)) return;

  // スケールしてマイルドに
  _qWristScaled.copy(_qIdentity).slerp(_qWristFull, TUNING.wristAngleScale);
  // rest姿勢の上に重ねる
  _qWristTarget.copy(restQuat).multiply(_qWristScaled);
  handBone.quaternion.slerp(_qWristTarget, TUNING.wristAngleSmoothing);
}

// 上腕 + 前腕 + ひねり を統合してVRMへ適用
export function applyArm(vrm, shoulder, elbow, wrist, oppositeShoulder, side, handLm) {
  const upperArm = getBone(vrm, side === 'left' ? 'leftUpperArm' : 'rightUpperArm');
  const lowerArm = getBone(vrm, side === 'left' ? 'leftLowerArm' : 'rightLowerArm');
  if (!upperArm) return;

  const sign = side === 'left' ? 1 : -1;
  _v3defaultDir.set(sign, 0, 0);

  const targetRestQuat = sceneState.isVrm1 ? _restUpperQuat[side] : _restUpperQuatVrm0[side];

  // 肩幅（2D）を基準長として計算（奥行き強化で使用）
  const shoulderRefWidth = (shoulder && oppositeShoulder)
    ? Math.hypot(oppositeShoulder.x - shoulder.x, oppositeShoulder.y - shoulder.y)
    : 0;

  // ランドマーク不可視時は rest 姿勢へスムーズに戻す
  if (!isArmLandmarkVisible(shoulder) || !isArmLandmarkVisible(elbow)) {
    upperArm.quaternion.slerp(targetRestQuat, TUNING.restSmoothing);
    if (lowerArm) lowerArm.quaternion.slerp(_qIdentity, TUNING.restSmoothing);
    _smoothedUpperTwist[side] *= 0.9;
    decayWristTwistState(side, _smoothedWristSinCos);
    return;
  }

  mpToVrmDir(shoulder, elbow, _v3upperDir);
  if (_v3upperDir.lengthSq() < 1e-10) {
    upperArm.quaternion.slerp(targetRestQuat, TUNING.restSmoothing);
    if (lowerArm) lowerArm.quaternion.slerp(_qIdentity, TUNING.restSmoothing);
    return;
  }

  // ── 腕の奥行き強化（上腕）──
  enhanceArmDepth(_v3upperDir, shoulder, elbow, shoulderRefWidth);
  _v3upperDir.normalize();
  if (!sceneState.isVrm1) _v3upperDir.y *= -1;

  _qUpperTarget.setFromUnitVectors(_v3defaultDir, _v3upperDir);

  // ── 肩のひねり（上腕の内旋・外旋）を適用 ──
  if (twistState.enabled) {
    const upperTwist = computeUpperArmTwist(shoulder, elbow, wrist, oppositeShoulder);
    if (upperTwist !== null) {
      // デッドゾーン：0付近の微小値を無視（手首弯曲時のノイズ結合を防止）
      const tw = Math.abs(upperTwist) < TUNING.upperArmTwistDeadZone ? 0 : upperTwist;
      _smoothedUpperTwist[side] += (tw - _smoothedUpperTwist[side]) * TUNING.upperArmTwistSmoothing;
    }
    // 計算成功・失敗に関わらず現在のスムーズ値を適用（ホールド動作）
    _v3twistAxis.set(sign, 0, 0);
    _qUpperTwist.setFromAxisAngle(_v3twistAxis, _smoothedUpperTwist[side]);
    _qUpperTarget.multiply(_qUpperTwist);
  } else {
    _smoothedUpperTwist[side] *= 0.9;
  }

  upperArm.quaternion.slerp(_qUpperTarget, TUNING.smoothing);

  if (!lowerArm) return;

  if (!isArmLandmarkVisible(wrist)) {
    lowerArm.quaternion.slerp(_qIdentity, TUNING.restSmoothing);
    decayWristTwistState(side, _smoothedWristSinCos);
    return;
  }

  mpToVrmDir(elbow, wrist, _v3lowerDir);
  if (_v3lowerDir.lengthSq() < 1e-10) {
    lowerArm.quaternion.slerp(_qIdentity, TUNING.restSmoothing);
    return;
  }

  // ── 腕の奥行き強化（前腕）──
  enhanceArmDepth(_v3lowerDir, elbow, wrist, shoulderRefWidth);
  _v3lowerDir.normalize();
  if (!sceneState.isVrm1) _v3lowerDir.y *= -1;

  _qInvUpper.copy(upperArm.quaternion).invert();
  _v3lowerLocal.copy(_v3lowerDir).applyQuaternion(_qInvUpper);
  _qLowerTarget.setFromUnitVectors(_v3defaultDir, _v3lowerLocal);

  // ── 手首のひねり（前腕の回内・回外）を適用 ──
  // sin/cos を別々に平滑してから atan2 で再構成することで、
  // ±πの折返し点をまたぐ際の「くるくる回る」不具合を解消する。
  if (twistState.enabled) {
    const wristTwist = computeWristTwist(_qInvUpper, _v3lowerLocal, side, handLm);
    if (wristTwist !== null && _wristTwistReliability > 0.01) {
      const tw = Math.abs(wristTwist) < TUNING.wristTwistDeadZone ? 0 : wristTwist;
      // 信頼度（手首深屈曲で手掌法線が前腕に平行になるほど低い）で更新率を緩める
      const rate = TUNING.wristTwistSmoothing * _wristTwistReliability;
      const s = Math.sin(tw), c = Math.cos(tw);
      _smoothedWristSinCos[side].sin += (s - _smoothedWristSinCos[side].sin) * rate;
      _smoothedWristSinCos[side].cos += (c - _smoothedWristSinCos[side].cos) * rate;
    }
    // 測定不能な間は最後のひねりをホールド＝ジャンプしない
    const smoothedTwist = Math.atan2(_smoothedWristSinCos[side].sin, _smoothedWristSinCos[side].cos);
    _v3twistAxis.set(sign, 0, 0);
    _qLowerTwist.setFromAxisAngle(_v3twistAxis, smoothedTwist);
    _qLowerTarget.multiply(_qLowerTwist);
  } else {
    decayWristTwistState(side, _smoothedWristSinCos);
  }

  lowerArm.quaternion.slerp(_qLowerTarget, TUNING.smoothing);
}

// 手首の角度を各サイドに適用（手が見えない場合はrestに戻す）
export function applyWristForSide(vrm, elbow, wristPose, handLm, side) {
  const handBone = getBone(vrm, side === 'left' ? 'leftHand' : 'rightHand');
  if (!handBone) return;
  if (handLm && handLm.length >= 21 && isArmLandmarkVisible(elbow) && isArmLandmarkVisible(wristPose)) {
    applyWristAngle(vrm, elbow, wristPose, handLm, side, handBone);
  } else {
    const restQuat = handBone.userData.restQuat || _qIdentity;
    handBone.quaternion.slerp(restQuat, TUNING.restSmoothing);
  }
}
