// ──────────────────────────────────────────────────────────────
// apply-inochi.js — Inochi2D パペットへトラッキング結果を適用
//   apply.js の Inochi2D 版。並列で動作し、VRM とは排他。
//
//   仕組み:
//     1. パペットロード時にパラメータ一覧を取得し、
//        一般的パラメータ名候補（Head Yaw / Eye L / Mouth Open 等）を
//        正規表現/部分文字列で探索してマッチング。
//     2. マッチ結果を `_paramMap` にキャッシュ。
//     3. 毎フレーム、latestLandmarks から該当パラメータ値を計算して
//        puppetHandle.setParam() で wasm へ送る。
//     4. フェーズゲート:
//        phase 1: ロード + 静止（適用なし）
//        phase 2: 物理 + アイドル（呼吸用の値を徐々に動かすだけ）
//        phase 3: 頭部 + 表情追従（頭部回転/目/口）
//        phase 4: 腕 / 全身（肩・肘・手首の姿勢）
// ──────────────────────────────────────────────────────────────
import { latestLandmarks, inochiState } from 'app/state.js';
import { TUNING, HEAD_LIMIT } from 'app/config.js';

// ── Inochi2D 一般パラメータ名の候補（大文字小文字・区切り文字を無視） ──
//   実モデルは命名規則がまちまちなので、正規化文字列で部分マッチ。
const PARAM_CANDIDATES = {
  // 頭部回転 (Phase 3)
  //   "Head:: Yaw-Pitch" (vec2) が Inochi2D Creator 標準。
  //   これを headYaw と headPitch の両方へマップする。
  headYaw:     ['headyaw', 'head_yaw', 'headyawpitch', 'head_yaw_pitch', 'head::yawpitch', 'head::yaw', 'head::yaw-pitch', 'headturnx', 'head_turn_x', 'headrotatex', 'head_rotation_x', 'headrx', 'turnx', 'head_turn'],
  headPitch:   ['headpitch', 'head_pitch', 'headyawpitch', 'head_yaw_pitch', 'head::yawpitch', 'head::pitch', 'head::yaw-pitch', 'headturny', 'head_turn_y', 'headrotatey', 'head_rotation_y', 'headry', 'turny'],
  headRoll:    ['headroll', 'head_roll', 'head::roll', 'headturnz', 'head_turn_z', 'headrotatez', 'head_rotation_z', 'headrz', 'turnz'],
  headX:       ['headx', 'head_x', 'head::x'],
  headY:       ['heady', 'head_y', 'head::y'],

  // 眼球視線 (Phase 3)
  //   Inochi2D 標準: "Eye:: Left:: Move" (vec2, X-Y)
  eyeLX:       ['eyelx', 'eye_lx', 'eyeleftx', 'eye_left_x', 'eye::left::move', 'eyeleft::move', 'eye::l::move', 'eye::left::x', 'gazeleftx', 'gaze_left_x'],
  eyeLY:       ['eyely', 'eye_ly', 'eyelefty', 'eye_left_y', 'eye::left::y', 'gazelefty', 'gaze_left_y'],
  eyeRX:       ['eyerx', 'eye_rx', 'eyerightx', 'eye_right_x', 'eye::right::move', 'eyeright::move', 'eye::r::move', 'eye::right::x', 'gazerightx', 'gaze_right_x'],
  eyeRY:       ['eyery', 'eye_ry', 'eyerighty', 'eye_right_y', 'eye::right::y', 'gazerighty', 'gaze_right_y'],
  eyeX:        ['eyex', 'eye_x', 'eyesx', 'eyes_x', 'eye::move'],
  eyeY:        ['eyey', 'eye_y', 'eyesy', 'eyes_y'],

  // 瞬き (Phase 3)
  blinkL:      ['blinkl', 'blink_l', 'blinkleft', 'blink_left', 'eyeblinkl', 'eye_blink_l', 'eye::left::blink', 'eye::l::blink', 'eyeblink_l', 'eye::leftblink'],
  blinkR:      ['blinkr', 'blink_r', 'blinkright', 'blink_right', 'eyeblinkr', 'eye_blink_r', 'eye::right::blink', 'eye::r::blink', 'eyeblink_r', 'eye::rightblink'],
  blink:       ['blink', 'eyeblink', 'eye_blink', 'eye::blink'],

  // 口 (Phase 3)
  //   "Mouth:: Shape" (vec2) と "Mouth:: Width" (scalar) が標準。
  mouthOpen:    ['mouthopen', 'mouth_open', 'jawopen', 'jaw_open', 'openmouth', 'open_mouth', 'mouth_o', 'moutho', 'aa', 'mouth::open', 'mouth::shape', 'mouth::shape::y'],
  mouthSmile:  ['mouthsmile', 'mouth_smile', 'smile', 'happy', 'mouthhappy', 'mouth_happy', 'mouthsmilel', 'mouth_smile_l', 'mouth::smile', 'mouth::shape::x'],
  mouthForm:   ['mouthform', 'mouth_form', 'mouth_width', 'mouthwidth', 'mouth::width', 'ih', 'ou'],
  mouthLower:  ['mouthlower', 'mouth_lower', 'lowerlip', 'lower_lip', 'mouth::lower'],

  // 眉 (Phase 3, おまけ)
  browL:       ['browl', 'brow_l', 'browleft', 'brow_left', 'eyebrowl', 'eyebrow_l', 'eyebrowleft', 'brow::left', 'eyebrow::left'],
  browR:       ['browr', 'brow_r', 'browright', 'brow_right', 'eyebrowr', 'eyebrow_r', 'eyebrowright', 'brow::right', 'eyebrow::right'],

  // 腕 (Phase 4)
  //   "Arm:: Left:: Move" が標準。
  armL:        ['arml', 'arm_l', 'armleft', 'arm_left', 'leftarm', 'left_arm', 'arm::left::move', 'arm::l::move', 'arm::left'],
  armR:        ['armr', 'arm_r', 'armright', 'arm_right', 'rightarm', 'right_arm', 'arm::right::move', 'arm::r::move', 'arm::right'],
  armLX:       ['armlx', 'arm_lx', 'armleftx', 'leftarmx', 'arm::left::x'],
  armLY:       ['armly', 'arm_ly', 'armlefty', 'leftarmy', 'arm::left::y'],
  armRX:       ['armrx', 'arm_rx', 'armrightx', 'rightarmx', 'arm::right::x'],
  armRY:       ['armry', 'arm_ry', 'armrighty', 'rightarmy', 'arm::right::y'],

  // 体 (Phase 4)
  //   "Body:: Yaw-Pitch" (vec2), "Body:: Roll" (scalar), "Body:: X:: Move" など。
  bodyYaw:     ['bodyyaw', 'body_yaw', 'spineyaw', 'spine_yaw', 'waistyaw', 'waist_yaw', 'torsoyaw', 'torso_yaw', 'body::yawpitch', 'body::yaw', 'body::yaw-pitch', 'body::x::move'],
  bodyPitch:   ['bodypitch', 'body_pitch', 'spinepitch', 'spine_pitch', 'torsox', 'torso_x', 'body::pitch', 'body::yaw-pitch', 'body::y::move'],
  bodyRoll:    ['bodyroll', 'body_roll', 'spin roll', 'spine_roll', 'torsoz', 'torso_z', 'body::roll'],
  bodyX:       ['bodyx', 'body_x', 'body::x::move'],

  // アイドル/呼吸 (Phase 2)
  breathing:  ['breathing', 'breath', 'idle_breath', 'breath_cycle'],
  idle:       ['idle', 'idle_motion'],
};

// ── パラメータ名の正規化（大文字小文字・区切り文字を無視） ──
//   "Head:: Yaw-Pitch" → "headyawpitch" のように、: / - / _ / . / 空白 をすべて除去。
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[_\-\s.:\\/]/g, '');
}

// ── パペットロード時にマッチ表を構築 ──
//   戻り値: { headYaw: paramName | null, eyeLX: ..., ... }
export function buildParamMap(puppetHandle) {
  const params = puppetHandle.getParams();
  const map = {};
  // 正規化名 → 実パラメータ名
  const normalized = new Map();
  for (const p of params) {
    normalized.set(normalizeName(p.name), p);
  }

  for (const [logicalName, candidates] of Object.entries(PARAM_CANDIDATES)) {
    let found = null;
    // 完全一致を優先
    for (const c of candidates) {
      const n = normalizeName(c);
      if (normalized.has(n)) { found = normalized.get(n); break; }
    }
    // 部分一致（normalized に含まれる）
    if (!found) {
      outer: for (const c of candidates) {
        const n = normalizeName(c);
        for (const [normName, param] of normalized) {
          if (normName.includes(n) || n.includes(normName)) { found = param; break outer; }
        }
      }
    }
    map[logicalName] = found ? found.name : null;
  }

  console.info('[Inochi2D] param map:', map);
  return map;
}

// ── スムージングヘルパ ──
function smooth(prev, next, rate) {
  if (prev === undefined || isNaN(prev)) return next;
  return prev + (next - prev) * rate;
}

// 1フレーム分の適用。apply.js と同じ I/F
//   ※ 開発手順の phase 概念は廃止。常時、全機能を動かす。
//      - 呼吸 / アイドル
//      - 頭部 + 表情 (headMatrix / blendshapes)
//      - 腕 / 全身 (pose landmarks)
//   ※ update(dt) で bindings が評価され、ノード transform / deform へ反映される。
export function applyLandmarksToInochi(puppetHandle) {
  if (!puppetHandle) return;

  const map = inochiState.paramMap;
  if (!map) return;

  // 値を [-1, 1] に正規化 → 実パラメータの [min, max] へ線形マップ
  //   ※新形式 (v0.8+) では min/max/defaults が配列 (vec2 or scalar)。
  //   v5: value に [x, y] 配列を渡すと vec2 パラメータへ各軸独立にマップする。
  //      (例: "Head:: Yaw-Pitch" へ [yaw, pitch]、"Mouth:: Shape" へ [smile, open])
  const set = (logicalName, value) => {
    const actualName = map[logicalName];
    if (actualName == null) return;
    const spec = inochiState.paramSpec?.[actualName];
    const minRaw = spec?.min ?? 0;
    const maxRaw = spec?.max ?? 1;
    const mins = Array.isArray(minRaw) ? minRaw : [minRaw, minRaw];
    const maxs = Array.isArray(maxRaw) ? maxRaw : [maxRaw, maxRaw];
    if (Array.isArray(value)) {
      const mapped = value.map((v, i) => {
        const normalized = Math.max(-1, Math.min(1, v));
        const mn = mins[Math.min(i, mins.length - 1)];
        const mx = maxs[Math.min(i, maxs.length - 1)];
        return (normalized + 1) * 0.5 * (mx - mn) + mn;
      });
      puppetHandle.setParam(actualName, mapped);
      return;
    }
    const normalized = Math.max(-1, Math.min(1, value));
    const mapped = (normalized + 1) * 0.5 * (maxs[0] - mins[0]) + mins[0];
    puppetHandle.setParam(actualName, mapped);
  };

  // ── 呼吸 / アイドル ──
  const t = performance.now() * 0.001;
  if (map.breathing) {
    const v = (Math.sin(t * 1.2) + 1) * 0.25;
    set('breathing', (v * 2) - 1);
  }
  if (map.idle) {
    const v = Math.sin(t * 0.5) * 0.1;
    set('idle', (v * 2) - 1);
  }

  // ── 頭部 + 表情 ──
  applyHeadAndExpression(puppetHandle, set, map);

  // ── 腕 / 全身 ──
  applyArmsAndBody(puppetHandle, set, map);

  // bindings を評価 → ノード transform / deform へ反映
  //   (WASM バックエンド時は物理ステップも兼ねる)
  puppetHandle.update(1 / 60);
}

// ── 頭部 + 表情の適用 ──
function applyHeadAndExpression(puppetHandle, set, map) {
  const { face, faceBlendshapes, headMatrix } = latestLandmarks;

  // 頭部回転: headMatrix があればそれを使い、無ければ face landmarks から推定
  let pitch = 0, yaw = 0, roll = 0;
  if (headMatrix && headMatrix.length >= 16) {
    // headMatrix は column-major 4x4
    // 回転部分（左上 3x3）から Euler を抽出
    const m = headMatrix;
    // YXZ Euler
    pitch = Math.asin(Math.max(-1, Math.min(1, -m[9])));
    yaw = Math.atan2(m[8], m[10]);
    roll = Math.atan2(m[1], m[5]);
    // MediaPipe はカメラ映像基準（ミラー前提）。VRM と同じ符号反転を適用。
    pitch *= -1;
    yaw   *= -1;
    roll  *= -1;
  } else if (face && face.length >= 33) {
    // フォールバック: 顔の代表的ランドマークから概算
    const lEye = face[33], rEye = face[263];
    const nose = face[1], noseBridge = face[168];
    if (lEye && rEye) {
      const dx = rEye.x - lEye.x;
      const dy = rEye.y - lEye.y;
      roll = Math.atan2(dy, dx);
    }
    if (nose && noseBridge) {
      // 鼻の位置の中央からのズレで yaw を概算
      const cx = (lEye.x + rEye.x) / 2;
      yaw = (nose.x - cx) * 4;
    }
  }

  // クランプ（HEAD_LIMIT と同じ範囲）
  pitch = Math.max(-HEAD_LIMIT.pitch, Math.min(HEAD_LIMIT.pitch, pitch));
  yaw   = Math.max(-HEAD_LIMIT.yaw,   Math.min(HEAD_LIMIT.yaw,   yaw));
  roll  = Math.max(-HEAD_LIMIT.roll,  Math.min(HEAD_LIMIT.roll,  roll));

  // スムージング（Inochi2D 側で物理が動くので浅め）
  inochiState._sm.headPitch = smooth(inochiState._sm.headPitch, pitch, TUNING.smoothing * 0.5);
  inochiState._sm.headYaw   = smooth(inochiState._sm.headYaw,   yaw,   TUNING.smoothing * 0.5);
  inochiState._sm.headRoll  = smooth(inochiState._sm.headRoll,  roll,  TUNING.smoothing * 0.5);

  // headYaw / headPitch / headRoll 形式（[-1, 1] に正規化）
  //   v5: 複数の論理名が同じ実パラメータ (例: "Head:: Yaw-Pitch" vec2) に
  //      収束した場合は、上書きではなく [yaw, pitch] 配列で 1 回だけ設定する。
  //      (旧実装は headPitch→headY の順に上書きし、yaw 軸に pitch 値を
  //       書き込んでいたため、顔の向きが不正確だった)
  const yawN   = inochiState._sm.headYaw   / HEAD_LIMIT.yaw;
  const pitchN = inochiState._sm.headPitch / HEAD_LIMIT.pitch;
  const rollN  = inochiState._sm.headRoll  / HEAD_LIMIT.roll;
  if (map.headYaw && map.headYaw === map.headPitch) {
    set('headYaw', [yawN, pitchN]);
  } else {
    if (map.headYaw)   set('headYaw',   yawN);
    if (map.headPitch) set('headPitch', pitchN);
  }
  if (map.headRoll && map.headRoll !== map.headYaw && map.headRoll !== map.headPitch) {
    set('headRoll', rollN);
  }
  // headX / headY 形式（一部モデルは yaw/pitch を X/Y 1軸ずつ持つ）
  //   same-param 衝突時は既に配列設定済みなので上書きしない
  if (map.headX && map.headX !== map.headYaw && map.headX !== map.headPitch) set('headX', yawN);
  if (map.headY && map.headY !== map.headYaw && map.headY !== map.headPitch && map.headY !== map.headX) set('headY', pitchN);

  // ── 表情（blendshapes）──
  if (faceBlendshapes) {
    const score = (name) => faceBlendshapes.find(c => c.categoryName === name)?.score ?? 0;

    // 瞬き（カメラ映像ミラー前提: ユーザ右目 = モデル左目）
    const blinkL = Math.min(Math.max(score('eyeBlinkRight'), 0), 1);
    const blinkR = Math.min(Math.max(score('eyeBlinkLeft'),  0), 1);
    inochiState._sm.blinkL = smooth(inochiState._sm.blinkL, blinkL, 0.3);
    inochiState._sm.blinkR = smooth(inochiState._sm.blinkR, blinkR, 0.3);
    if (map.blinkL) set('blinkL', inochiState._sm.blinkL * 2 - 1);
    if (map.blinkR) set('blinkR', inochiState._sm.blinkR * 2 - 1);
    if (map.blink)  set('blink',  ((inochiState._sm.blinkL + inochiState._sm.blinkR) * 0.5) * 2 - 1);

    // 口（開閉）
    const mouthOpen = Math.min(Math.max(score('jawOpen'), 0), 1);
    inochiState._sm.mouthOpen = smooth(inochiState._sm.mouthOpen, mouthOpen, 0.4);

    // 口（笑顔）
    const smile = Math.min(
      Math.max(score('mouthSmileLeft'), score('mouthSmileRight')),
      1
    );
    inochiState._sm.mouthSmile = smooth(inochiState._sm.mouthSmile, smile, 0.3);

    // v5: mouthOpen と mouthSmile が同じ実パラメータ (例: "Mouth:: Shape" vec2)
    //      に収束した場合は [smile, open] 配列で 1 回だけ設定する。
    //      (旧実装は smile が jawOpen を上書きし、口が開かないことがあった)
    if (map.mouthOpen && map.mouthOpen === map.mouthSmile) {
      set('mouthOpen', [inochiState._sm.mouthSmile * 2 - 1, inochiState._sm.mouthOpen * 2 - 1]);
    } else {
      if (map.mouthOpen)  set('mouthOpen',  inochiState._sm.mouthOpen * 2 - 1);
      if (map.mouthSmile) set('mouthSmile', inochiState._sm.mouthSmile * 2 - 1);
    }

    // 口形（広げ/すぼめ）
    const mouthForm = (score('mouthSmileLeft') - score('mouthPressLeft')) +
                      (score('mouthSmileRight') - score('mouthPressRight'));
    if (map.mouthForm) set('mouthForm', Math.max(-1, Math.min(1, mouthForm)));

    // 眉
    const browL = Math.min(Math.max(score('browOuterUpLeft'), 0), 1) -
                  Math.min(Math.max(score('browDownLeft'), 0), 1);
    const browR = Math.min(Math.max(score('browOuterUpRight'), 0), 1) -
                  Math.min(Math.max(score('browDownRight'), 0), 1);
    if (map.browL) set('browL', browL * 2 - 1);
    if (map.browR) set('browR', browR * 2 - 1);
  }

  // ── 視線（眼球の micro rotation）──
  if (face && face.length >= 478) {
    // MediaPipe iris インデックス
    const irisL = face[468], irisR = face[473];
    const eyeLCenter = { x: (face[133].x + face[33].x) / 2, y: (face[159].y + face[145].y) / 2 };
    const eyeRCenter = { x: (face[362].x + face[263].x) / 2, y: (face[386].y + face[374].y) / 2 };
    let gx = 0, gy = 0;
    if (irisL) {
      gx += irisL.x - eyeLCenter.x;
      gy += irisL.y - eyeLCenter.y;
    }
    if (irisR) {
      gx += irisR.x - eyeRCenter.x;
      gy += irisR.y - eyeRCenter.y;
    }
    gx *= -2; gy *= -2; // ミラー + 増幅
    gx = Math.max(-1, Math.min(1, gx));
    gy = Math.max(-1, Math.min(1, gy));
    inochiState._sm.gazeX = smooth(inochiState._sm.gazeX, gx, 0.2);
    inochiState._sm.gazeY = smooth(inochiState._sm.gazeY, gy, 0.2);

    if (map.eyeX)      set('eyeX',      inochiState._sm.gazeX);
    if (map.eyeY)      set('eyeY',      inochiState._sm.gazeY);
    if (map.eyeLX)     set('eyeLX',     inochiState._sm.gazeX);
    if (map.eyeLY)     set('eyeLY',     inochiState._sm.gazeY);
    if (map.eyeRX)     set('eyeRX',     inochiState._sm.gazeX);
    if (map.eyeRY)     set('eyeRY',     inochiState._sm.gazeY);
  }
}

// ── 腕 / 体の適用 ──
function applyArmsAndBody(puppetHandle, set, map) {
  const { pose, headMatrix } = latestLandmarks;
  if (!pose) return;

  // 肩と肘と手首
  const lShoulder = pose[11], rShoulder = pose[12];
  const lElbow    = pose[13], rElbow    = pose[14];
  const lWrist    = pose[15], rWrist    = pose[16];
  const lHip      = pose[23], rHip      = pose[24];

  if (!lShoulder || !rShoulder) return;
  if ((lShoulder.visibility ?? 1) < 0.4 || (rShoulder.visibility ?? 1) < 0.4) return;

  // ── 体の向き（yaw/pitch/roll）──
  //   肩の傾き = roll, 肩の奥行き差 = yaw, 肩-腰の奥行き差 = pitch
  if (map.bodyYaw || map.bodyPitch || map.bodyRoll) {
    const dx = rShoulder.x - lShoulder.x;
    const dy = rShoulder.y - lShoulder.y;
    const dz = rShoulder.z - lShoulder.z;
    const sw = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const roll  = -Math.atan2(dy, Math.abs(dx) || 0.001);
    const yaw   = (dz / sw) * 2;
    let pitch = 0;
    if (lHip && rHip && (lHip.visibility ?? 1) > 0.3) {
      const shoulderZ = (lShoulder.z + rShoulder.z) / 2;
      const hipZ      = (lHip.z + rHip.z) / 2;
      const torsoLen  = Math.abs((lShoulder.y + rShoulder.y) / 2 - (lHip.y + rHip.y) / 2) || 1;
      pitch = (shoulderZ - hipZ) / torsoLen;
    }
    if (map.bodyRoll)  set('bodyRoll',  Math.max(-1, Math.min(1, roll  * 2)));
    if (map.bodyYaw)   set('bodyYaw',   Math.max(-1, Math.min(1, yaw   * 2)));
    if (map.bodyPitch) set('bodyPitch', Math.max(-1, Math.min(1, pitch * 2)));
  }

  // ── 腕: 肩から手首へのベクトルを各軸パラメータへ ──
  //   Inochi2D モデルの腕パラメータ設計はモデル依存が大きいが、
  //   一般的な「左腕 X / Y」形式に合わせる。
  if (map.armLX || map.armLY || map.armL || map.armRX || map.armRY || map.armR) {
    // ミラー設定を考慮（VRM の mirrorLR と同様）
    const mirror = TUNING.mirrorLR;
    const srcLeft  = mirror ? rShoulder : lShoulder;
    const srcLeftEl = mirror ? rElbow    : lElbow;
    const srcLeftW  = mirror ? rWrist    : lWrist;
    const srcRight  = mirror ? lShoulder : rShoulder;
    const srcRightEl = mirror ? lElbow    : rElbow;
    const srcRightW  = mirror ? lWrist    : rWrist;

    // 左腕の向き（肩→手首）を yaw/pitch 風に分解
    if (srcLeft && srcLeftW && (srcLeft.visibility ?? 1) > 0.3) {
      const dx = srcLeftW.x - srcLeft.x;
      const dy = srcLeftW.y - srcLeft.y;
      const dz = srcLeftW.z - srcLeft.z;
      // 腕を下ろした状態を 0、横に90度開いた状態を +1 とする
      // 横方向（x）の寄与: +1 側がユーザ側
      const armX = Math.max(-1, Math.min(1, dx * 4));
      // 前方向（z）の寄与: 手を前に出すと +
      const armY = Math.max(-1, Math.min(1, -dy * 3 + dz * 2));
      if (map.armL)  set('armL',  armX);
      if (map.armLX) set('armLX', armX);
      if (map.armLY) set('armLY', armY);
    }
    if (srcRight && srcRightW && (srcRight.visibility ?? 1) > 0.3) {
      const dx = srcRightW.x - srcRight.x;
      const dy = srcRightW.y - srcRight.y;
      const dz = srcRightW.z - srcRight.z;
      const armX = Math.max(-1, Math.min(1, dx * 4));
      const armY = Math.max(-1, Math.min(1, -dy * 3 + dz * 2));
      if (map.armR)  set('armR',  armX);
      if (map.armRX) set('armRX', armX);
      if (map.armRY) set('armRY', armY);
    }
  }
}
