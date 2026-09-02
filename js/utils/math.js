// ──────────────────────────────────────────────────────────────
// math.js - 数学ヘルパ群
//   座標変換・角度計算・Swing-Twist 分解など。
//   状態を持たない純粋関数として実装。
// ──────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  _qTwistInv,
  _v3upperArmDir,
  _v3forearmDirTwist,
  _v3forearmPerp,
  _v3shoulderLine,
  _v3shoulderPerp,
  _v3twistCross,
} from 'app/utils/temp-objects.js';
import { TUNING, SKELETON_ZOOM } from 'app/config.js';
import { sceneState } from 'app/state.js';

// MediaPipe 座標から VRM 座標への方向ベクトル変換（座標反転）
export function mpToVrmDir(from, to, outVec) {
  outVec.set(
    -(to.x - from.x),
    -(to.y - from.y),
    -(to.z - from.z)
  );
  return outVec;
}

// ランドマークの可視度チェック
export function isArmLandmarkVisible(p) {
  return p && (p.visibility ?? 1) >= TUNING.armVisibilityThreshold;
}

// 2D 距離
export function distance2D(p1, p2) {
  const dx = p1.x - p2.x, dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// 2D 上の曲がり角度（0〜π）
export function bendAngle(ax, ay, bx, by) {
  const dot = ax * bx + ay * by;
  const cross = ax * by - ay * bx;
  return Math.atan2(Math.abs(cross), dot);
}

// ── 腕の奥行き強化：短縮法（foreshortening）で深度を推定 ──
// MediaPipeのzはノイズが多く振幅も小さい。2Dの見かけの長さから「本来の長さとの差」を計算し、
// その差を深度の大きさとして使うことで、手前/奥への腕の動きをより明確に反映する。
// dirVec: mpToVrmDir 後の方向ベクトル（normalize前）。z成分を拡張した状態で書き換える。
// fromLM, toLM: セグメントの両端のランドマーク。refWidth: 肩幅など基準長（2D）。
export function enhanceArmDepth(dirVec, fromLM, toLM, refWidth) {
  if (TUNING.armDepthEnhance <= 0 || !fromLM || !toLM || refWidth <= 0.01) return;
  const dx = toLM.x - fromLM.x;
  const dy = toLM.y - fromLM.y;
  const seg2D = Math.sqrt(dx * dx + dy * dy);
  const expected = refWidth * TUNING.armLengthRatio;
  let depthMag = Math.sqrt(Math.max(0, expected * expected - seg2D * seg2D));
  const maxDepth = refWidth * TUNING.armDepthMaxRatio;
  depthMag = Math.min(depthMag, maxDepth);
  const zSign = Math.sign(dirVec.z) || 1;
  const blended = (1 - TUNING.armDepthEnhance) * dirVec.z
                + TUNING.armDepthEnhance * (zSign * depthMag);
  dirVec.z = blended * TUNING.armDepthScale * TUNING.armDepthSign;
}

// ── Swing-Twist 分解 ──
// クォータニオン q を、軸 axis まわりの回転(twist)とそれに垂直な回転(swing)に分ける。
// q = swing * twist となるように分解する。
export function swingTwistDecompose(q, axis, swingOut, twistOut) {
  const dot = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  twistOut.set(q.w, dot * axis.x, dot * axis.y, dot * axis.z);
  const lenSq = twistOut.x * twistOut.x + twistOut.y * twistOut.y
              + twistOut.z * twistOut.z + twistOut.w * twistOut.w;
  if (lenSq < 1e-12) {
    twistOut.set(0, 0, 0, 1);
    swingOut.copy(q);
    return;
  }
  const inv = 1 / Math.sqrt(lenSq);
  twistOut.x *= inv; twistOut.y *= inv; twistOut.z *= inv; twistOut.w *= inv;
  _qTwistInv.copy(twistOut).invert();
  swingOut.copy(q).multiply(_qTwistInv);
}

// VRM の指カール軸の Z 成分（VRM1/VRM0 で符号が異なる）
export function getFingerAxisZ() {
  return sceneState.isVrm1 ? -1 : 1;
}

// ── 肩のひねり（上腕の内旋・外旋）を計算 ──
// 上腕軸（肩→肘）まわりの前腕の回転角度を、対側の肩を基準に計算する。
// 腕を体側に垂らすと前腕と上腕が一直線になりひねりが定義できないので null を返す。
export function computeUpperArmTwist(shoulder, elbow, wrist, oppositeShoulder) {
  if (!shoulder || !elbow || !wrist || !oppositeShoulder) return null;
  if (!isArmLandmarkVisible(shoulder) || !isArmLandmarkVisible(elbow) ||
      !isArmLandmarkVisible(wrist) ||
      (oppositeShoulder.visibility ?? 1) < TUNING.visibilityThreshold) return null;

  // 上腕方向（VRM座標系：mpToVrmDir と同じ反転を適用）
  _v3upperArmDir.set(
    -(elbow.x - shoulder.x),
    -(elbow.y - shoulder.y),
    -(elbow.z - shoulder.z)
  );
  if (_v3upperArmDir.lengthSq() < 1e-10) return null;
  _v3upperArmDir.normalize();
  if (!sceneState.isVrm1) _v3upperArmDir.y *= -1;

  // 前腕方向（VRM座標系）
  _v3forearmDirTwist.set(
    -(wrist.x - elbow.x),
    -(wrist.y - elbow.y),
    -(wrist.z - elbow.z)
  );
  if (_v3forearmDirTwist.lengthSq() < 1e-10) return null;
  if (!sceneState.isVrm1) _v3forearmDirTwist.y *= -1;

  // 前腕を上腕に垂直な平面へ射影
  const dot1 = _v3forearmDirTwist.dot(_v3upperArmDir);
  _v3forearmPerp.copy(_v3forearmDirTwist).addScaledVector(_v3upperArmDir, -dot1);
  // 肘がほぼ伸びきっていると射影成分がノイズ支配になり、ひねり測定がゴミ化する
  // （バンザイなど腕を伸ばしたポーズで腕全体が軸まわりに暴れる原因）。
  // |射影| = sin(肘の屈曲角)。約14.5°以上曲がっていなければ測定せず、呼び出し側は
  // 直前の値をホールドする（前腕ひねりが手掌の向きを補正するため見た目は保たれる）
  if (_v3forearmPerp.lengthSq() < 0.25 * 0.25) return null;
  _v3forearmPerp.normalize();

  // 肩線（自肩→対側肩）をVRM座標系で計算
  _v3shoulderLine.set(
    -(oppositeShoulder.x - shoulder.x),
    -(oppositeShoulder.y - shoulder.y),
    -(oppositeShoulder.z - shoulder.z)
  );
  if (!sceneState.isVrm1) _v3shoulderLine.y *= -1;

  // 肩線を上腕に垂直な平面へ射影（ひねり0の基準方向）
  const dot2 = _v3shoulderLine.dot(_v3upperArmDir);
  _v3shoulderPerp.copy(_v3shoulderLine).addScaledVector(_v3upperArmDir, -dot2);
  if (_v3shoulderPerp.lengthSq() < 1e-8) return null;
  _v3shoulderPerp.normalize();

  // 上腕軸まわりの符号付き角度（基準→前腕）
  _v3twistCross.crossVectors(_v3shoulderPerp, _v3forearmPerp);
  const sin = _v3twistCross.dot(_v3upperArmDir);
  const cos = _v3shoulderPerp.dot(_v3forearmPerp);
  let angle = Math.atan2(sin, cos);

  angle *= TUNING.upperArmTwistScale;
  angle = Math.max(-TUNING.upperArmTwistMax, Math.min(TUNING.upperArmTwistMax, angle));
  return angle;
}

// トラッキングロスト時にひねり状態をrestへ緩和する
export function decayWristTwistState(side, smoothedWristSinCos) {
  smoothedWristSinCos[side].sin *= 0.9;
  smoothedWristSinCos[side].cos = 1 - (1 - smoothedWristSinCos[side].cos) * 0.9;
}

// clamp ヘルパ
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ── ズーム計算 ──
// 肩幅（2D）からズーム倍率を計算
export function shoulderWidthToZoom(w) {
  if (w <= 0) return 1.0;
  const t = Math.max(0, Math.min(1,
    (w - SKELETON_ZOOM.minShoulderWidth) / (SKELETON_ZOOM.maxShoulderWidth - SKELETON_ZOOM.minShoulderWidth)
  ));
  return SKELETON_ZOOM.minZoom + t * (SKELETON_ZOOM.maxZoom - SKELETON_ZOOM.minZoom);
}

// ポーズから両肩の 2D 距離を取得
export function getShoulderWidth(pose) {
  if (!pose) return 0;
  const lS = pose[11], rS = pose[12];
  if (!lS || !rS) return 0;
  const dx = lS.x - rS.x, dy = lS.y - rS.y;
  return Math.sqrt(dx * dx + dy * dy);
}
