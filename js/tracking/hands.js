// ──────────────────────────────────────────────────────────────
// hands.js - 指トラッキング・手の向き・左右割当
// ──────────────────────────────────────────────────────────────
import * as THREE from 'three';

import { sceneState, latestLandmarks } from 'app/state.js';
import {
  TUNING,
  HAND_TUNING,
  FINGER_ENTRIES,
  FINGER_MAX_ANGLE,
  FINGER_AXIS,
} from 'app/config.js';
import {
  _qIdentity,
  _fingerQuat,
  _fingerAxis,
  _fingerAxisZ,
  _deltaQuat,
  _targetQuat,
  _v3fingerDir,
  _v3spanDir,
  _v3normalDir,
  _m4hand,
  _qHandRaw,
} from 'app/utils/temp-objects.js';
import {
  distance2D,
  bendAngle,
  getFingerAxisZ,
} from 'app/utils/math.js';
import { getBone } from 'app/core/vrm-loader.js';

// VRMボーン候補リストをキャッシュしながら解決
function getBoneCandidates(vrm, prefix, candidatesList) {
  const cache = vrm._boneCandidateCache || (vrm._boneCandidateCache = new Map());
  const key = prefix + candidatesList[0][0];
  if (cache.has(key)) return cache.get(key);

  let result = null;
  for (const set of candidatesList) {
    const bones = set.map(name => getBone(vrm, `${prefix}${name}`));
    if (bones.every(b => b !== null)) { result = bones; break; }
  }
  cache.set(key, result);
  return result;
}

// 一般指（人差し〜小指）のカール量を計算
function computeFingerCurl(lm, indices, handSize, range) {
  const [mcp, pip, dip, tip] = indices.map(i => lm[i]);
  if (!mcp || !pip || !dip || !tip) return null;

  const ratio = distance2D(tip, mcp) / handSize;
  let curl = 1.0 - Math.max(0, Math.min(1, (ratio - range[0]) / (range[1] - range[0])));

  const bend = bendAngle(
    pip.x - mcp.x, pip.y - mcp.y,
    dip.x - pip.x, dip.y - pip.y
  );
  const jointCurl = Math.min(1, bend / (Math.PI * 0.6));
  curl = Math.max(curl, jointCurl);

  // デッドゾーン拡大（微小入力を無視して荒れを防止）
  if (curl < TUNING.fingerDeadZone) curl = 0;
  else curl = (curl - TUNING.fingerDeadZone) / (1 - TUNING.fingerDeadZone);

  return {
    proximal: Math.min(1, curl * 0.85),
    intermediate: Math.min(1, curl * 1.05),
    distal: Math.min(1, curl * 1.15),
  };
}

// 親指のカール量を計算（感度・デッドゾーンが専用）
function computeThumbCurl(lm, indices, handSize) {
  const [cmc, mcp, ip, tip] = indices.map(i => lm[i]);
  const wrist = lm[0];
  if (!cmc || !mcp || !ip || !tip || !wrist) return null;

  const bend = bendAngle(
    ip.x - mcp.x, ip.y - mcp.y,
    tip.x - ip.x, tip.y - ip.y
  );
  // ★ 親指の角度感度にゲイン（thumbGain）を適用
  const angleCurl = Math.min(1, (bend / (Math.PI * 0.6)) * TUNING.thumbGain);

  const ratio = distance2D(tip, wrist) / handSize;
  // ★ 距離ベースの判定範囲を親指用に調整（0.5〜1.0 → 0.4〜0.9 に広げて反応しやすく）
  const distCurl = 1.0 - Math.max(0, Math.min(1, (ratio - 0.40) / (0.90 - 0.40)));

  let curl = Math.max(angleCurl, distCurl);
  // ★ 親指専用のデッドゾーンを適用（他指の 0.32 より小さい 0.15 を使用）
  if (curl < TUNING.thumbDeadZone) curl = 0;
  else curl = (curl - TUNING.thumbDeadZone) / (1 - TUNING.thumbDeadZone);

  return {
    proximal: Math.min(1, curl * 0.8),
    intermediate: Math.min(1, curl * 1.0),
    distal: Math.min(1, curl * 1.2),
  };
}

// 各指のカールをVRMの指ボーンへ適用
export function applyFingers(vrm, handLm, side) {
  const prefix = side === 'left' ? 'left' : 'right';
  const wrist = handLm[0], middleMcp = handLm[9];
  if (!wrist || !middleMcp) return;
  const handSize = distance2D(wrist, middleMcp);
  if (handSize < 0.01) return;

  for (const [fingerName, cfg] of FINGER_ENTRIES) {
    const curl = fingerName === 'thumb'
      ? computeThumbCurl(handLm, cfg.lm, handSize)
      : computeFingerCurl(handLm, cfg.lm, handSize, cfg.range);
    if (!curl) continue;

    const bones = getBoneCandidates(vrm, prefix, cfg.candidates);
    if (!bones) continue;

    const jointNames = ['proximal', 'intermediate', 'distal'];
    for (let j = 0; j < 3; j++) {
      const bone = bones[j];
      if (!bone) continue;

      const restQuat = bone.userData.restQuat || _qIdentity;
      const curlValue = curl[jointNames[j]];
      if (curlValue < 0.01) {
        bone.quaternion.slerp(restQuat, TUNING.fingerSmoothing * 2.0);
        continue;
      }

      const maxAngle = FINGER_MAX_ANGLE[jointNames[j]];
      const angle = curlValue * maxAngle * (side === 'left' ? 1 : -1);

      _fingerAxis.copy(
        fingerName === 'thumb' ? FINGER_AXIS.thumb : _fingerAxisZ.set(0, 0, getFingerAxisZ())
      );
      _deltaQuat.setFromAxisAngle(_fingerAxis, angle);
      _targetQuat.copy(restQuat).multiply(_deltaQuat);
      bone.quaternion.slerp(_targetQuat, TUNING.fingerSmoothing);
    }
  }
}

// 手の甲の向きをVRMへ適用（オプション機能・デフォルトOFF）
export function applyHandOrientation(vrm, handLm, side) {
  const bone = getBone(vrm, side === 'left' ? 'leftHand' : 'rightHand');
  if (!bone) return;

  const wrist     = handLm[0];
  const indexMcp  = handLm[5];
  const middleMcp = handLm[9];
  const pinkyMcp  = handLm[17];
  if (!wrist || !indexMcp || !middleMcp || !pinkyMcp) return;

  _v3fingerDir.set(
    -(middleMcp.x - wrist.x),
    -(middleMcp.y - wrist.y),
    -(middleMcp.z - wrist.z)
  ).normalize();
  _v3spanDir.set(
    -(pinkyMcp.x - indexMcp.x),
    -(pinkyMcp.y - indexMcp.y),
    -(pinkyMcp.z - indexMcp.z)
  ).normalize();
  _v3normalDir.crossVectors(_v3fingerDir, _v3spanDir);
  if (_v3normalDir.lengthSq() < 0.001) return;
  _v3normalDir.normalize();

  _m4hand.makeBasis(_v3spanDir, _v3fingerDir, _v3normalDir);
  _qHandRaw.setFromRotationMatrix(_m4hand);
  if (isNaN(_qHandRaw.x)) return;

  const restQuat = bone.userData.restQuat || _qIdentity;
  _targetQuat.copy(restQuat).multiply(_qHandRaw);
  bone.quaternion.slerp(_targetQuat, TUNING.handSmoothing);
}

// ── 検出された手をVRM左右に割り当てる ──
// MediaPipe の handedness は「入力画像がミラー済み（セルフィー表示）」という前提で
// 付けられるラベル。本アプリは生カメラ映像をそのまま検出に渡しているため、
// ラベルは実際の解剖学的左右と入れ替わってしまう。一方、ポーズlandmarkの左右は
// 解剖学的な左右で安定しており、腕の割り当て（applyLandmarksToVrm）もそちらで
// 行われている。そこで「手のランドマークの手首 ⇔ ポーズの手首」の2D距離が最も
// 近い腕に手を割り当てることで、腕と手の左右がクロスするのを防ぐ。
function labelHandSide(hand) {
  return TUNING.mirrorLR
    ? (hand.handedness === 'Left' ? 'right' : 'left')
    : (hand.handedness === 'Left' ? 'left' : 'right');
}

export function assignHandsToVrmSides(hands, pose) {
  if (!hands || hands.length === 0) return;

  // ポーズの手首（解剖学的な左右）。VRM側は腕の割り当てと同じ対応にする
  // （mirrorLR ではユーザーの左手→VRM右、右手→VRM左）
  const poseWrists = [];
  if (pose && pose[15] && (pose[15].visibility ?? 1) >= 0.3) {
    poseWrists.push({ lm: pose[15], vrmSide: TUNING.mirrorLR ? 'right' : 'left' });
  }
  if (pose && pose[16] && (pose[16].visibility ?? 1) >= 0.3) {
    poseWrists.push({ lm: pose[16], vrmSide: TUNING.mirrorLR ? 'left' : 'right' });
  }

  if (poseWrists.length === 0) {
    for (const hand of hands) hand.vrmSide = labelHandSide(hand);
    return;
  }

  const distTo = (hand, pw) => {
    const w = hand.landmarks && hand.landmarks[0];
    if (!w || !pw.lm) return Infinity;
    const dx = w.x - pw.lm.x, dy = w.y - pw.lm.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  if (hands.length >= 2 && poseWrists.length === 2) {
    // 2手×2手首：合計距離が最小の組み合わせを採用
    const [a, b] = hands;
    const [w0, w1] = poseWrists;
    const direct = distTo(a, w0) + distTo(b, w1);
    const swapped = distTo(a, w1) + distTo(b, w0);
    const optimal = Math.min(direct, swapped);
    const labelA = labelHandSide(a);
    const labelB = labelHandSide(b);
    const labelTotal = (labelA === w0.vrmSide) ? direct : swapped;
    // 距離差が僅少（手が重なっている等）のときはラベル基準を優先してフリつきを防ぎ、
    // 距離の証拠が十分なときは距離基準を採用する
    if (labelA !== labelB && labelTotal <= optimal * 1.3) {
      a.vrmSide = labelA;
      b.vrmSide = labelB;
    } else if (direct <= swapped) {
      a.vrmSide = w0.vrmSide;
      b.vrmSide = w1.vrmSide;
    } else {
      a.vrmSide = w1.vrmSide;
      b.vrmSide = w0.vrmSide;
    }
    return;
  }

  // 1手、またはポーズ手首が片側しか見えていない場合：最近傍で割り当て
  for (const hand of hands) {
    let bestSide = null, bestD = Infinity;
    for (const pw of poseWrists) {
      const d = distTo(hand, pw);
      if (d < bestD) { bestD = d; bestSide = pw.vrmSide; }
    }
    hand.vrmSide = (bestSide && bestD <= 0.3) ? bestSide : labelHandSide(hand);
  }
  // 両手が同じ側になった場合は反対側へ振り直す
  if (hands.length >= 2 && hands[0].vrmSide === hands[1].vrmSide) {
    hands[1].vrmSide = (hands[0].vrmSide === 'left') ? 'right' : 'left';
  }
}

// 検出された各手へ指・手の向きを適用
export function applyHandTracking(vrm) {
  const hands = latestLandmarks.hands;
  if (!hands || hands.length === 0) return;

  for (const hand of hands) {
    const { landmarks, score } = hand;
    if (!landmarks || landmarks.length < 21) continue;
    if (score < TUNING.handVisibilityThreshold) continue;

    // 左右の割り当ては applyLandmarksToVrm 内の assignHandsToVrmSides で
    // 毎フレーム判定して hand.vrmSide に入れてある（未設定時のみラベルで代替）
    const vrmSide = hand.vrmSide || labelHandSide(hand);

    if (HAND_TUNING.enableFingers)         applyFingers(vrm, landmarks, vrmSide);
    if (HAND_TUNING.enableHandOrientation) applyHandOrientation(vrm, landmarks, vrmSide);
  }
}
