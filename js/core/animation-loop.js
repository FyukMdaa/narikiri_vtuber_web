// ──────────────────────────────────────────────────────────────
// animation-loop.js - Three.js のアニメーションループ
//   FPS 計測・カメラ追従・ズームスムージング・VRM更新
// ──────────────────────────────────────────────────────────────
import { sceneState, zoomState, fpsState, fullBodyState } from 'app/state.js';
import {
  ZOOM_SMOOTHING,
  CAMERA_LERP,
} from 'app/config.js';
import {
  _v3headPos,
  _camTargetPos,
  _camTargetLookAt,
  _camLookAtSmooth,
} from 'app/utils/temp-objects.js';
import { getBone } from 'app/core/vrm-loader.js';
import { shoulderWidthToZoom, getShoulderWidth } from 'app/utils/math.js';

// re-export: 旧 API を維持（他モジュールからの参照を透過にする）
export { shoulderWidthToZoom, getShoulderWidth };

// メインアニメーションループ
export function animate() {
  requestAnimationFrame(animate);
  const delta = sceneState.clock.getDelta();
  const { currentVrm, placeholder, camera3d, renderer, scene } = sceneState;

  if (!currentVrm) {
    placeholder.rotation.y += 0.006;
  } else {
    currentVrm.update(delta);
  }

  // ズームスムージング
  if (Math.abs(zoomState.current - zoomState.target) > 0.001) {
    zoomState.current += (zoomState.target - zoomState.current) * ZOOM_SMOOTHING;
    camera3d.zoom = zoomState.current;
    camera3d.updateProjectionMatrix();
  }

  // カメラ追従
  if (currentVrm) {
    if (zoomState.enabled) {
      const headNode = currentVrm.humanoid && getBone(currentVrm, 'head');
      const headY = headNode
        ? headNode.getWorldPosition(_v3headPos).y + 0.09
        : 1.4;
      _camTargetPos.set(0, headY, 2.6);
      _camTargetLookAt.set(0, headY, 0);
    } else {
      _camTargetPos.set(0, fullBodyState.centerY, fullBodyState.dist);
      _camTargetLookAt.set(0, fullBodyState.centerY, 0);
    }
    camera3d.position.lerp(_camTargetPos, CAMERA_LERP);
    _camLookAtSmooth.lerp(_camTargetLookAt, CAMERA_LERP);
    camera3d.lookAt(_camLookAtSmooth);
  }

  // FPS 計測
  const now = performance.now();
  const dt = now - fpsState.lastFrameTime;
  fpsState.lastFrameTime = now;
  if (dt > 0) {
    const instFps = 1000 / dt;
    fpsState.smoothed = fpsState.smoothed ? fpsState.smoothed * 0.9 + instFps * 0.1 : instFps;
    if (fpsState.readoutEl) {
      fpsState.readoutEl.textContent = `${fpsState.smoothed.toFixed(0)} fps`;
    }
  }

  renderer.render(scene, camera3d);
}

// 明るさスライダ適用
export function applyBrightness(factor) {
  sceneState.keyLight.intensity = 1.1 * factor;
  // AmbientLight は直接参照（scene 全体走査の最適化）
  sceneState.ambientLight.intensity = 1.2 * factor;
}
