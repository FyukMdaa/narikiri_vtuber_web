// ──────────────────────────────────────────────────────────────
// wrist.js - 手首のひねり（回内・回外）計算
//
// 解剖学的基準方式：
//   「ひねり0＝肘の純粋な屈曲のみ」を表す基準ベクトルを毎フレーム計算する。
//   基準ベクトル = swing × N_rest
//     swing  = setFromUnitVectors((±1,0,0), 前腕方向)  … 肘屈曲のみの回転
//     N_rest = (0, -getFingerAxisZ(), 0) … 手掌法線のrest方向
//   swing はボーンX軸を前腕方向へ回す最小回転なので、swing・N_rest は常に前腕
//   方向と直交する＝特異点が存在しない。
// ──────────────────────────────────────────────────────────────
import {
  TUNING,
} from 'app/config.js';
import { sceneState } from 'app/state.js';
import {
  _v3wristToIndex,
  _v3wristToPinky,
  _v3palmNormal,
  _v3palmPerp,
  _v3palmLocal,
  _v3twistRef,
  _v3crossTmp2,
  _v3palmRest,
  _v3boneAxis,
  _qLowerSwingRef,
  _smoothedWristSinCos,
  _wristTwistReliability,
  setWristTwistReliability,
} from 'app/utils/temp-objects.js';
import { getFingerAxisZ } from 'app/utils/math.js';

// qInvUpper:     upperArm の回転の逆クォータニオン
// lowerLocalDir: upperArm ローカルフレームでの前腕方向（正規化済み）
// side:          'left' / 'right'
// handLm:        手の21個ランドマーク
// 戻り値: ひねり角［rad］。測定不能なら null。_wristTwistReliability に
//         測定の信頼度（0〜1）も設定する
export function computeWristTwist(qInvUpper, lowerLocalDir, side, handLm) {
  setWristTwistReliability(0);
  if (!handLm || handLm.length < 21) return null;

  const handWrist = handLm[0];
  const indexMcp = handLm[5];
  const pinkyMcp = handLm[17];
  if (!handWrist || !indexMcp || !pinkyMcp) return null;

  // 手掌の2方向ベクトル（VRM座標系）
  _v3wristToIndex.set(
    -(indexMcp.x - handWrist.x),
    -(indexMcp.y - handWrist.y),
    -(indexMcp.z - handWrist.z)
  );
  _v3wristToPinky.set(
    -(pinkyMcp.x - handWrist.x),
    -(pinkyMcp.y - handWrist.y),
    -(pinkyMcp.z - handWrist.z)
  );

  // 手掌法線 = (手首→人差指) × (手首→小指)
  _v3palmNormal.crossVectors(_v3wristToIndex, _v3wristToPinky);
  if (_v3palmNormal.lengthSq() < 1e-10) return null;
  _v3palmNormal.normalize();
  // VRM0用のミラー座標変換（y反転）は方向ベクトルと同じく法線にも適用する。
  // ※成分ごとの反射は cross の前後で結果が変わるため、必ずcrossの「後」に適用する
  if (!sceneState.isVrm1) _v3palmNormal.y *= -1;
  // ミラー設定では「ユーザーの右手→アバターの左手」のように手のキラリティが
  // 反転して対応する。cross の手順はキラリティ固定のため、対応によっては法線が
  // 手の甲向き（＝180°ズレ）になる。ここで側ごとに向きを揃える
  if (TUNING.mirrorLR === (side === 'left')) _v3palmNormal.multiplyScalar(-1);

  // 手掌法線を upperArm ローカルフレームへ変換
  _v3palmLocal.copy(_v3palmNormal).applyQuaternion(qInvUpper);

  // 前腕軸に垂直な成分を取り出す
  const dot = _v3palmLocal.dot(lowerLocalDir);
  _v3palmPerp.copy(_v3palmLocal).addScaledVector(lowerLocalDir, -dot);
  const perpLen = _v3palmPerp.length();
  if (perpLen < 1e-4) return null;
  _v3palmPerp.multiplyScalar(1 / perpLen);

  // 信頼度：手首を深く曲げて手掌法線が前腕軸に近づくほどひねりは不定になる
  const align = Math.abs(dot);
  const reliability = align <= 0.55 ? 1
    : align >= 0.92 ? 0
    : (0.92 - align) / (0.92 - 0.55);
  setWristTwistReliability(reliability);

  // 解剖学的基準：肘の純粋屈曲（swing）だけを適用したときの手掌法線の方向
  _v3palmRest.set(0, getFingerAxisZ(), 0);
  _v3boneAxis.set(side === 'left' ? 1 : -1, 0, 0);
  _qLowerSwingRef.setFromUnitVectors(_v3boneAxis, lowerLocalDir);
  _v3twistRef.copy(_v3palmRest).applyQuaternion(_qLowerSwingRef);

  // 前腕軸まわりの符号付き角度（基準→手掌法線）
  _v3crossTmp2.crossVectors(_v3twistRef, _v3palmPerp);
  const sin = _v3crossTmp2.dot(lowerLocalDir);
  const cos = _v3twistRef.dot(_v3palmPerp);
  let angle = Math.atan2(sin, cos);

  // スケール＆クランプ
  angle *= TUNING.wristTwistScale;
  angle = Math.max(-TUNING.wristTwistMax, Math.min(TUNING.wristTwistMax, angle));
  return angle;
}
