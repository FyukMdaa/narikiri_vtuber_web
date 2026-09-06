// ──────────────────────────────────────────────────────────────
// apply.js - トラッキング結果をVRMへ統合適用するオーケストレータ
// ──────────────────────────────────────────────────────────────
import { sceneState, latestLandmarks } from 'app/state.js';
import { TUNING } from 'app/config.js';

import { applyExpressions, applyEyeGaze, applyHeadRotation } from 'app/tracking/face.js';
import { applySpine } from 'app/tracking/spine.js';
import { applyArm, applyWristForSide } from 'app/tracking/arms.js';
import { assignHandsToVrmSides, applyHandTracking } from 'app/tracking/hands.js';

// 1フレーム分の最新ランドマークをVRMへ適用
export function applyLandmarksToVrm(vrm) {
  if (!vrm) return;

  const { pose, face, faceBlendshapes, headMatrix } = latestLandmarks;

  try {
    applyExpressions(vrm, faceBlendshapes);
    applyEyeGaze(vrm, face, headMatrix);
    applyHeadRotation(vrm, headMatrix);

    if (pose) {
      applySpine(vrm, pose, headMatrix);
    }

    const mpLeft = pose
      ? { shoulder: pose[11], elbow: pose[13], wrist: pose[15] }
      : { shoulder: null, elbow: null, wrist: null };

    const mpRight = pose
      ? { shoulder: pose[12], elbow: pose[14], wrist: pose[16] }
      : { shoulder: null, elbow: null, wrist: null };

    // ミラー設定時はユーザーの右手→VRM左、左手→VRM右
    const vrmLeftSource = TUNING.mirrorLR ? mpRight : mpLeft;
    const vrmRightSource = TUNING.mirrorLR ? mpLeft : mpRight;

    // VRM側ごとの手ランドマークを構築（ミラー設定を反映）
    const handByVrmSide = {};
    const hands = latestLandmarks.hands;
    assignHandsToVrmSides(hands, pose);
    if (hands) {
      for (const hand of hands) {
        if (!hand.landmarks || hand.landmarks.length < 21) continue;
        if ((hand.score ?? 0) < TUNING.handVisibilityThreshold) continue;
        // 未設定時のみラベルで代替
        const vrmSide = hand.vrmSide || (
          TUNING.mirrorLR
            ? (hand.handedness === 'Left' ? 'right' : 'left')
            : (hand.handedness === 'Left' ? 'left' : 'right')
        );
        handByVrmSide[vrmSide] = hand.landmarks;
      }
    }

    applyArm(vrm, vrmLeftSource.shoulder, vrmLeftSource.elbow, vrmLeftSource.wrist,
              vrmRightSource.shoulder, 'left', handByVrmSide.left);
    applyArm(vrm, vrmRightSource.shoulder, vrmRightSource.elbow, vrmRightSource.wrist,
              vrmLeftSource.shoulder, 'right', handByVrmSide.right);

    // 手首の角度（掌の屈曲/橈尺屈）を適用
    applyWristForSide(vrm, vrmLeftSource.elbow, vrmLeftSource.wrist, handByVrmSide.left, 'left');
    applyWristForSide(vrm, vrmRightSource.elbow, vrmRightSource.wrist, handByVrmSide.right, 'right');

    applyHandTracking(vrm);
  } catch (err) {
    console.warn('Tracking error:', err);
  }
}
