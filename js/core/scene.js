// ──────────────────────────────────────────────────────────────
// scene.js - Three.js シーンのセットアップ
//   renderer / camera / lights / grid / placeholder を構築する。
// ──────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { sceneState } from 'app/state.js';

export function initScene() {
  const canvas = document.getElementById('three-canvas');
  const paneModel = document.getElementById('pane-model');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera3d = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera3d.position.set(0, 1.4, 3.2);
  camera3d.lookAt(0, 1, 0);

  // ライティングを少しモダンに調整（青白と暖色の対比）
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(2, 3, 2);
  scene.add(keyLight);
  const ambientLight = new THREE.AmbientLight(0x9090a0, 1.2);
  scene.add(ambientLight);

  // 仮の床グリッド
  const grid = new THREE.GridHelper(6, 24, 0x4a4d56, 0x34363d);
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  // 仮のプレースホルダー
  const placeholder = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.0, 8, 16),
    new THREE.MeshStandardMaterial({
      color: 0x34363d,
      roughness: 0.5,
      metalness: 0.1,
      emissive: 0x1a1b1e,
    })
  );
  placeholder.position.y = 1.0;
  scene.add(placeholder);

  // 共有stateへ保存
  sceneState.renderer = renderer;
  sceneState.scene = scene;
  sceneState.camera3d = camera3d;
  sceneState.keyLight = keyLight;
  sceneState.ambientLight = ambientLight;
  sceneState.grid = grid;
  sceneState.placeholder = placeholder;
  sceneState.clock = new THREE.Clock();

  // リサイズハンドラ（即時実行で初期化も兼ねる）
  resizeThree();
  // resize の度に呼ばれると高頻度すぎるため、rAFで遅延
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      resizeThree();
    });
  });

  return { renderer, scene, camera3d, keyLight, ambientLight, grid, placeholder, paneModel };
}

export function resizeThree() {
  const paneModel = document.getElementById('pane-model');
  const w = paneModel.clientWidth;
  const h = paneModel.clientHeight;
  sceneState.renderer.setSize(w, h, false);
  sceneState.camera3d.aspect = w / h;
  sceneState.camera3d.updateProjectionMatrix();
}
