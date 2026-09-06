// ──────────────────────────────────────────────────────────────
// vrm-loader.js - VRM ファイルの読込・破棄・カメラフレーミング
// ──────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

import { sceneState, fullBodyState, ui, zoomState } from 'app/state.js';
import {
  _v3headPos,
  _camTargetPos,
  _camTargetLookAt,
  _camLookAtSmooth,
  _qIdentity,
  _restUpperQuat,
  _restUpperQuatVrm0,
} from 'app/utils/temp-objects.js';

const gltfLoader = new GLTFLoader();
gltfLoader.register((parser) => new VRMLoaderPlugin(parser));

// VRMボーン取得（キャッシュ付き）
export function getBone(vrm, name) {
  const cache = vrm._boneCache || (vrm._boneCache = new Map());
  let bone = cache.get(name);
  if (bone === undefined) {
    bone = vrm.humanoid.getNormalizedBoneNode(name);
    cache.set(name, bone);
  }
  return bone;
}

// 現在のVRMを破棄してリソース解放
export function disposeCurrentVrm() {
  if (!sceneState.currentVrm) return;
  sceneState.scene.remove(sceneState.currentVrm.scene);
  VRMUtils.deepDispose(sceneState.currentVrm.scene);
  sceneState.currentVrm = null;
}

// VRMロード時にカメラを顔の位置へ寄せる
export function frameCameraToVrm(vrm) {
  const headNode = vrm.humanoid && getBone(vrm, 'head');
  const headWorldPos = headNode
    ? headNode.getWorldPosition(_v3headPos)
    : _v3headPos.set(0, 1.4, 0);

  const faceCenterY = headWorldPos.y + 0.09;
  sceneState.camera3d.position.set(0, faceCenterY, 2.6);
  sceneState.camera3d.lookAt(0, faceCenterY, 0);

  _camTargetPos.set(0, faceCenterY, 2.6);
  _camTargetLookAt.set(0, faceCenterY, 0);
  _camLookAtSmooth.set(0, faceCenterY, 0);
}

// 全身が映るカメラ距離を計算してキャッシュ
export function updateFullBodyCache(vrm) {
  if (!vrm) return;
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const height = box.max.y - box.min.y;
  fullBodyState.centerY = (box.max.y + box.min.y) / 2;
  const fovRad = sceneState.camera3d.fov * Math.PI / 180;
  fullBodyState.dist = (height * 1.25) / (2 * Math.tan(fovRad / 2));
}

// ── VRM ロード直後の気をつけポーズ ──
// 両腕を軽く開いた rest 姿勢へ設定する
export function setKiotsukePose(vrm) {
  if (!vrm || !vrm.humanoid) return;

  const sides = ['left', 'right'];

  for (const side of sides) {
    const upperArm = getBone(vrm, `${side}UpperArm`);
    const lowerArm = getBone(vrm, `${side}LowerArm`);
    const hand     = getBone(vrm, `${side}Hand`);

    if (upperArm) {
      const targetRestQuat = sceneState.isVrm1 ? _restUpperQuat[side] : _restUpperQuatVrm0[side];
      upperArm.quaternion.copy(targetRestQuat);
    }

    if (lowerArm) lowerArm.quaternion.copy(_qIdentity);
    if (hand)     hand.quaternion.copy(_qIdentity);
  }

  if (vrm.expressionManager && typeof vrm.expressionManager.reset === 'function') {
    vrm.expressionManager.reset();
  }
}

// ファイルからVRMを読み込む
export async function loadVrm(url, fileName) {
  ui.statusTag.textContent = `「${fileName}」を読み込み中…`;
  ui.btnLoadVrm.disabled = true;
  try {
    const gltf = await gltfLoader.loadAsync(url);
    const vrm = gltf.userData.vrm;

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    vrm.scene.traverse((obj) => { obj.frustumCulled = false; });

    disposeCurrentVrm();
    sceneState.placeholder.visible = false;
    sceneState.grid.visible = true;

    sceneState.currentVrm = vrm;
    sceneState.scene.add(vrm.scene);

    sceneState.isVrm1 = gltf.parser?.json?.extensions?.VRMC_vrm !== undefined ||
             vrm.meta?.specVersion === '1.0';

    vrm.scene.rotation.y = sceneState.isVrm1 ? 0 : Math.PI;
    if (vrm.lookAt) vrm.lookAt.target = null;

    frameCameraToVrm(vrm);

    zoomState.target = 1.0;
    zoomState.current = 1.0;
    sceneState.camera3d.zoom = 1.0;
    sceneState.camera3d.updateProjectionMatrix();

    setKiotsukePose(vrm);
    vrm.update(0);

    vrm.humanoid.forEach((boneName, node) => {
      node.userData.restQuat = node.quaternion.clone();
    });

    updateFullBodyCache(vrm);
    ui.statusTag.textContent = `「${fileName}」を表示中`;
  } catch (err) {
    console.error(err);
    ui.statusTag.textContent = `VRMの読み込みに失敗しました（${fileName}）`;
  } finally {
    ui.btnLoadVrm.disabled = false;
    URL.revokeObjectURL(url);
  }
}
