// ──────────────────────────────────────────────────────────────
// spine.js - 胴体（spine + hips）の回転
//   Roll: 肩線の傾き
//   Yaw:  首のヨー + 肩のひねり
//   Pitch: 肩と腰の奥行き差
// ──────────────────────────────────────────────────────────────
import { sceneState } from 'app/state.js';
import { TUNING } from 'app/config.js';
import {
  _m4tmp,
  _tmpQuat,
  _eulerHead,
  _eulerHips,
  _qHipsTarget,
  _eulerSpine,
  _qSpineTarget,
  _smoothedSpineYawV,
  _smoothedSpinePitchV,
  setSmoothedSpineYaw,
  setSmoothedSpinePitch,
} from 'app/utils/temp-objects.js';
import { getBone } from 'app/core/vrm-loader.js';

export function applySpine(vrm, pose, headMatrix) {
  const spine = getBone(vrm, 'spine');
  const hips = getBone(vrm, 'hips');
  if (!spine) return;

  const lShoulder = pose[11];
  const rShoulder = pose[12];
  const lHip = pose[23];
  const rHip = pose[24];

  if (!lShoulder || !rShoulder) return;
  if ((lShoulder.visibility ?? 1) < 0.5 || (rShoulder.visibility ?? 1) < 0.5) return;

  const dx = rShoulder.x - lShoulder.x;
  const dy = rShoulder.y - lShoulder.y;
  const dz = rShoulder.z - lShoulder.z;

  const shoulderWidth2D = Math.sqrt(dx * dx + dy * dy);
  const shoulderWidth3D = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (shoulderWidth3D < 0.05) return;

  // ── Roll（左右の傾き）: 既存ロジック ──
  const tiltRatio = Math.max(-1, Math.min(1, dy / Math.max(shoulderWidth2D, 0.05)));
  const roll = sceneState.isVrm1
    ? -tiltRatio * (Math.PI / 6)
    :  tiltRatio * (Math.PI / 6);

  // ── Yaw（体の向き）: 首のヨー ＋ 肩のひねり ──
  // (1) 首のヨーをベースに、デッドゾーン＋影響倍率(15%)で控えめに追従
  // (2) 肩のひねり（左右の肩の奥行き差）も体に少し伝達（肩がねじれても体が少し追従）
  let yaw = 0;

  if (headMatrix) {
    _m4tmp.fromArray(headMatrix);
    _tmpQuat.setFromRotationMatrix(_m4tmp);
    _eulerHead.setFromQuaternion(_tmpQuat, 'YXZ');
    let headYaw = _eulerHead.y;
    // VRM1/VRM0 で符号を合わせる（applyHeadRotationと同様の処理）
    headYaw *= -1;

    // デッドゾーン：小幅な首振りには体は追従しない
    if (Math.abs(headYaw) < TUNING.spineYawDeadZone) {
      headYaw = 0;
    } else {
      const sgn = Math.sign(headYaw);
      headYaw = sgn * (Math.abs(headYaw) - TUNING.spineYawDeadZone);
    }
    yaw += headYaw * TUNING.bodyHeadInfluenceScale;
  }

  // (2) 肩のひねり（左右の肩の奥行き差）
  const shoulderTwistRatio = Math.max(-1, Math.min(1, dz / shoulderWidth3D));
  yaw += shoulderTwistRatio * TUNING.bodyArmTwistInfluenceScale * Math.PI / 2;

  // クランプ（首が極端に向いても体は30°まで）
  yaw = Math.max(-TUNING.spineYawMax, Math.min(TUNING.spineYawMax, yaw));
  yaw *= TUNING.bodyYawSign;
  yaw *= (TUNING.mirrorLR ? 1 : -1);

  // ── Pitch（前傾/後傾）: 肩と腰の奥行き差から推定 ──
  let pitch = 0;
  if (lHip && rHip && (lHip.visibility ?? 1) > 0.3 && (rHip.visibility ?? 1) > 0.3) {
    const shoulderCenterZ = (lShoulder.z + rShoulder.z) / 2;
    const hipCenterZ = (lHip.z + rHip.z) / 2;
    const torsoLen2D = Math.abs((lShoulder.y + rShoulder.y) / 2 - (lHip.y + rHip.y) / 2);
    if (torsoLen2D > 0.05) {
      const pitchRatio = Math.max(-1, Math.min(1, (shoulderCenterZ - hipCenterZ) / torsoLen2D));
      pitch = pitchRatio * TUNING.spinePitchMax * TUNING.spinePitchScale;
      pitch *= TUNING.bodyPitchSign;
      pitch *= (sceneState.isVrm1 ? -1 : 1);
    }
  }

  // スムージング
  const newYaw = _smoothedSpineYawV + (yaw - _smoothedSpineYawV) * TUNING.spineBodySmoothing;
  const newPitch = _smoothedSpinePitchV + (pitch - _smoothedSpinePitchV) * TUNING.spineBodySmoothing;
  setSmoothedSpineYaw(newYaw);
  setSmoothedSpinePitch(newPitch);

  // ── Yaw は hips に適用（体全体の向き）──
  if (hips) {
    _eulerHips.set(0, newYaw, 0, 'YXZ');
    _qHipsTarget.setFromEuler(_eulerHips);
    hips.quaternion.slerp(_qHipsTarget, TUNING.smoothing * 0.5);
  }

  // ── Pitch + Roll は spine に適用 ──
  _eulerSpine.set(newPitch, 0, roll, 'YXZ');
  _qSpineTarget.setFromEuler(_eulerSpine);
  spine.quaternion.slerp(_qSpineTarget, TUNING.smoothing * 0.5);
}
